#!/usr/bin/env node
// GLB terrain asset catalog builder — pure Node, no dependencies.
//
// Parses each terrain*.glb binary directly (GLB container -> JSON chunk +
// BIN chunk), walks nodes/meshes to collect every mesh's POSITION accessor,
// applies each node's local translation (assets are single-node scenes as
// far as we care — see recenter_on_import.gd / assetLoader.ts which only
// look at direct children), and reports:
//   - AABB (min/max XYZ) BEFORE any XZ recentering (raw Blender-export pivot
//     offset expected here, e.g. ~(2.0, _, 1.5) — this is normal, XZ offset
//     is fixed at load time by both Godot's import hook and assetLoader.ts)
//   - Y-span RELATIVE TO THE PIVOT (Y is never recentered anywhere in the
//     pipeline, so this Y-span is the ground truth for classifying the
//     asset as flat / ramp-like (above pivot, y in [0, +h]) / side-like
//     (below pivot, y in [-h, 0]) / non-standard.
//
// Usage: node tools/glb-catalog.mjs [glob-relative-to assets/map_materials/space-kit]
// Default: terrain*.glb

import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

const ASSET_DIR = join(process.cwd(), "assets", "map_materials", "space-kit");

function parseGlb(buf) {
  // GLB header: magic(4) version(4) length(4)
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error("not a glb file (bad magic)");
  let offset = 12;
  let jsonChunk = null;
  let binChunk = null;
  while (offset < buf.length) {
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const chunkData = buf.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 0x4e4f534a) jsonChunk = chunkData; // 'JSON'
    else if (chunkType === 0x004e4942) binChunk = chunkData; // 'BIN\0'
    offset += 8 + chunkLength;
  }
  if (!jsonChunk) throw new Error("no JSON chunk found");
  const json = JSON.parse(jsonChunk.toString("utf8"));
  return { json, bin: binChunk };
}

// Minimal accessor -> typed array reader (POSITION is always VEC3 float32
// in these Kenney exports, but we handle the general componentType/type
// combinations anyway for robustness).
const COMPONENT_TYPE_SIZES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex];
  const bufferView = gltf.bufferViews[accessor.bufferView];
  const compSize = COMPONENT_TYPE_SIZES[accessor.componentType];
  const numComponents = TYPE_COMPONENTS[accessor.type];
  const byteStride = bufferView.byteStride ?? compSize * numComponents;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = new Float32Array(accessor.count * numComponents);
  for (let i = 0; i < accessor.count; i++) {
    const elemStart = start + i * byteStride;
    for (let c = 0; c < numComponents; c++) {
      const byteOff = elemStart + c * compSize;
      let value;
      switch (accessor.componentType) {
        case 5126: value = bin.readFloatLE(byteOff); break; // FLOAT
        case 5125: value = bin.readUInt32LE(byteOff); break; // UNSIGNED_INT
        case 5123: value = bin.readUInt16LE(byteOff); break; // UNSIGNED_SHORT
        case 5121: value = bin.readUInt8(byteOff); break; // UNSIGNED_BYTE
        case 5122: value = bin.readInt16LE(byteOff); break; // SHORT
        case 5120: value = bin.readInt8(byteOff); break; // BYTE
        default: throw new Error("unsupported componentType " + accessor.componentType);
      }
      out[i * numComponents + c] = value;
    }
  }
  return out;
}

// Compose a node's local translation (Kenney exports use plain T, no
// rotation/scale on the mesh-holding nodes as far as this catalog needs —
// if a node has rotation/scale we still add translation only and flag it,
// good enough since all terrain assets in this kit are axis-aligned single
// meshes at import).
function nodeTranslation(node) {
  if (node.matrix) {
    // column-major 4x4, translation is elements 12,13,14
    return [node.matrix[12], node.matrix[13], node.matrix[14]];
  }
  return node.translation ?? [0, 0, 0];
}

// Rotate a vector by a glTF quaternion [x,y,z,w] (standard quaternion-vector
// rotation formula). Needed because some assets (terrain_sideCliff) carry a
// non-uniform node scale — translation-only was silently wrong for those.
function rotateByQuat(v, q) {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // v' = v + w*t + cross(q.xyz, t)
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

// Full local->parent transform for a node: scale, then rotate, then translate.
function applyNodeTransform(node, v) {
  const scale = node.scale ?? [1, 1, 1];
  const rotation = node.rotation ?? [0, 0, 0, 1];
  const translation = node.translation ?? [0, 0, 0];
  let out = [v[0] * scale[0], v[1] * scale[1], v[2] * scale[2]];
  out = rotateByQuat(out, rotation);
  return [out[0] + translation[0], out[1] + translation[1], out[2] + translation[2]];
}

function collectVertices(gltf, bin) {
  const scene = gltf.scenes[gltf.scene ?? 0];
  const verts = []; // {x,y,z}
  const warnings = [];

  // parentTransform: function(localVec) -> parentVec, composed depth-first.
  function walk(nodeIndex, parentTransform) {
    const node = gltf.nodes[nodeIndex];
    const rot = node.rotation;
    const isIdentityRot = !rot || (rot[0] === 0 && rot[1] === 0 && rot[2] === 0 && rot[3] === 1);
    if (!isIdentityRot) {
      warnings.push(`node "${node.name ?? nodeIndex}" has non-identity rotation — full quaternion transform applied (verify results)`);
    }
    const transform = v => parentTransform(applyNodeTransform(node, v));
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes[node.mesh];
      for (const prim of mesh.primitives) {
        const posIdx = prim.attributes.POSITION;
        if (posIdx === undefined) continue;
        const positions = readAccessor(gltf, bin, posIdx);
        for (let i = 0; i < positions.length; i += 3) {
          const [x, y, z] = transform([positions[i], positions[i + 1], positions[i + 2]]);
          verts.push({ x, y, z });
        }
      }
    }
    for (const child of node.children ?? []) walk(child, transform);
  }

  for (const rootIdx of scene.nodes) walk(rootIdx, v => v);
  return { verts, warnings };
}

function aabb(verts) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const v of verts) {
    min.x = Math.min(min.x, v.x); max.x = Math.max(max.x, v.x);
    min.y = Math.min(min.y, v.y); max.y = Math.max(max.y, v.y);
    min.z = Math.min(min.z, v.z); max.z = Math.max(max.z, v.z);
  }
  return { min, max };
}

function classify(box) {
  const ySpan = box.max.y - box.min.y;
  const yLo = box.min.y, yHi = box.max.y;
  const EPS = 0.02;
  if (ySpan < EPS) return "flat";
  if (Math.abs(yLo) < EPS && yHi > EPS) return "ramp-like (above pivot, y in [0, +span])";
  if (Math.abs(yHi) < EPS && yLo < -EPS) return "side-like (below pivot, y in [-span, 0])";
  return "NON-STANDARD";
}

function fmt(n) { return n.toFixed(3); }

function catalogFile(filePath) {
  const buf = readFileSync(filePath);
  const { json, bin } = parseGlb(buf);
  const { verts, warnings } = collectVertices(json, bin);
  const box = aabb(verts);
  return { box, verts, warnings, vertCount: verts.length };
}

function main() {
  const pattern = process.argv[2] ?? "terrain";
  const files = readdirSync(ASSET_DIR).filter(
    f => f.endsWith(".glb") && f.startsWith(pattern)
  );
  files.sort();

  console.log(`Found ${files.length} files matching "${pattern}*.glb" in ${ASSET_DIR}\n`);

  const results = [];
  for (const f of files) {
    const name = basename(f, ".glb");
    try {
      const r = catalogFile(join(ASSET_DIR, f));
      const size = {
        x: r.box.max.x - r.box.min.x,
        y: r.box.max.y - r.box.min.y,
        z: r.box.max.z - r.box.min.z,
      };
      const cls = classify(r.box);
      results.push({ name, ...r, size, cls });
      console.log(`## ${name}`);
      console.log(`   verts: ${r.vertCount}`);
      console.log(`   AABB raw  min=(${fmt(r.box.min.x)}, ${fmt(r.box.min.y)}, ${fmt(r.box.min.z)})  max=(${fmt(r.box.max.x)}, ${fmt(r.box.max.y)}, ${fmt(r.box.max.z)})`);
      console.log(`   size (x,y,z) = (${fmt(size.x)}, ${fmt(size.y)}, ${fmt(size.z)})`);
      console.log(`   classification: ${cls}`);
      if (r.warnings.length) console.log(`   WARNINGS: ${r.warnings.join("; ")}`);
      if (cls !== "flat" && process.argv.includes("--verts")) {
        // Recenter XZ exactly like assetLoader.ts/recenter_on_import.gd
        // (shift so the raw AABB's XZ center lands on 0,0), then print the
        // unique corner vertices so we can read off slope direction at rot=0.
        const cx = (r.box.min.x + r.box.max.x) / 2;
        const cz = (r.box.min.z + r.box.max.z) / 2;
        const seen = new Set();
        for (const v of r.verts) {
          const rx = v.x - cx, ry = v.y, rz = v.z - cz;
          const key = `${fmt(rx)},${fmt(ry)},${fmt(rz)}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        const uniq = [...seen].map(k => k.split(",").map(Number));
        uniq.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
        console.log(`   recentered unique verts (x, y, z):`);
        for (const [x, y, z] of uniq) console.log(`     (${fmt(x)}, ${fmt(y)}, ${fmt(z)})`);
      }
      console.log("");
    } catch (e) {
      console.log(`## ${name}\n   ERROR: ${e.message}\n`);
    }
  }

  return results;
}

main();
