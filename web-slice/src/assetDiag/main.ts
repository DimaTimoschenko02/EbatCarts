// Asset diagnostic page — web-engine mirror of scenes/asset_diag.tscn (Godot).
// Renders every terrain asset at 4 rotations, prints each one's Y-span / edge
// geometry read straight from the recentered mesh, and exposes window.__diag
// so the exact vertex tables in docs/space-kit-terrain-catalog.md can be
// re-verified in three.js (not just Godot). Dev/study aid, not shipped.
import * as THREE from "three";
import { loadAssetLibrary } from "../map/assetLoader";

const TERRAIN = [
  "terrain", "terrain_ramp", "terrain_rampLarge", "terrain_rampLarge_detailed",
  "terrain_side", "terrain_sideCliff", "terrain_sideCorner",
  "terrain_sideCornerInner", "terrain_sideEnd",
  "terrain_roadStraight", "terrain_roadCorner", "terrain_roadCross",
  "terrain_roadEnd", "terrain_roadSplit",
];
const ROTS = [0, 90, 180, 270];

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0b1a);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const dir = new THREE.DirectionalLight(0xffffff, 1.1);
dir.position.set(4, 8, 3);
scene.add(dir);

// Orbit state driven by pointer drag + wheel.
let camTarget = new THREE.Vector3(6, 0, 6);
let yaw = 0.7, pitch = 0.9, dist = 22;
function place(): void {
  camera.position.set(
    camTarget.x + dist * Math.cos(pitch) * Math.sin(yaw),
    camTarget.y + dist * Math.sin(pitch),
    camTarget.z + dist * Math.cos(pitch) * Math.cos(yaw),
  );
  camera.lookAt(camTarget);
}
let drag = false, px = 0, py = 0;
addEventListener("mousedown", e => { drag = true; px = e.clientX; py = e.clientY; });
addEventListener("mouseup", () => { drag = false; });
addEventListener("mousemove", e => {
  if (!drag) return;
  yaw -= (e.clientX - px) * 0.005; pitch = Math.max(0.05, Math.min(1.5, pitch + (e.clientY - py) * 0.005));
  px = e.clientX; py = e.clientY; place();
});
addEventListener("wheel", e => { dist = Math.max(4, Math.min(120, dist + e.deltaY * 0.02)); place(); });

function label(text: string, x: number, y: number, z: number, color = "#cde"): void {
  const cvs = document.createElement("canvas");
  cvs.width = 256; cvs.height = 64;
  const ctx = cvs.getContext("2d")!;
  ctx.fillStyle = color; ctx.font = "20px monospace"; ctx.textAlign = "center";
  ctx.fillText(text, 128, 40);
  const tex = new THREE.CanvasTexture(cvs);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  spr.position.set(x, y, z); spr.scale.set(2, 0.5, 1);
  scene.add(spr);
}

// Read a template's geometry summary: Y-span and the (x,z) footprint of its
// highest and lowest vertices — the raw signal for "above vs below pivot" and
// ascent direction.
interface Geo { yMin: number; yMax: number; hi: THREE.Vector3[]; lo: THREE.Vector3[]; }
function readGeo(root: THREE.Object3D): Geo {
  const verts: THREE.Vector3[] = [];
  root.updateMatrixWorld(true);
  root.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const pos = m.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      verts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
    }
  });
  let yMin = Infinity, yMax = -Infinity;
  for (const v of verts) { yMin = Math.min(yMin, v.y); yMax = Math.max(yMax, v.y); }
  const eps = 0.02;
  const uniq = (arr: THREE.Vector3[]) => {
    const seen = new Set<string>(); const out: THREE.Vector3[] = [];
    for (const v of arr) { const k = `${v.x.toFixed(1)},${v.z.toFixed(1)}`; if (!seen.has(k)) { seen.add(k); out.push(v); } }
    return out;
  };
  return {
    yMin, yMax,
    hi: uniq(verts.filter(v => v.y > yMax - eps)),
    lo: uniq(verts.filter(v => v.y < yMin + eps)),
  };
}

(async () => {
  const lib = await loadAssetLibrary(TERRAIN);
  const info: string[] = ["Asset  yMin..yMax  hiXZ  loXZ", ""];
  const geos: Record<string, Geo> = {};

  TERRAIN.forEach((name, row) => {
    const tmpl = lib.get(name)!;
    const g = readGeo(tmpl);
    geos[name] = g;
    const fmt = (vs: THREE.Vector3[]) => vs.map(v => `(${v.x.toFixed(1)},${v.z.toFixed(1)})`).join("");
    info.push(`${name}  y[${g.yMin.toFixed(2)},${g.yMax.toFixed(2)}]  hi=${fmt(g.hi)}  lo=${fmt(g.lo)}`);
    label(name, -2.5, 1.4, row * 2.5, "#ffd54a");
    ROTS.forEach((rot, col) => {
      const inst = tmpl.clone();
      inst.rotation.y = (rot * Math.PI) / 180;
      inst.position.set(col * 2.5, 0, row * 2.5);
      scene.add(inst);
      if (row === 0) label(`rot ${rot}`, col * 2.5, 1.4, -2, "#7fffd4");
    });
  });

  // ── Test assemblies (off to −Z) — compare candidate skirt recipes ────────
  const LH = 0.5;
  function tile(name: string, cx: number, cz: number, yLevel: number, rotDeg: number, ox: number, oz: number): void {
    const inst = lib.get(name)!.clone();
    inst.rotation.y = (rotDeg * Math.PI) / 180;
    inst.position.set(ox + cx, yLevel * LH, oz + cz);
    scene.add(inst);
  }
  // A raised 3×3 plateau at level 1 floating over VOID (island edge case).
  // Recipe A: straight edges = terrain_side (thin quad, hole underneath).
  // Recipe B: straight edges = terrain_sideCliff (solid cliff face).
  // Corners: sideCorner (y_level = LOW = 0). Ascent table from catalog:
  //   side rot 0→+Z,90→+X,180→−Z,270→−X ; sideCorner high-corner
  //   rot0→−X+Z,90→+X+Z,180→+X−Z,270→−X−Z (y_level LOW).
  function plateau3(ox: number, oz: number, edge: "terrain_side" | "terrain_sideCliff"): void {
    for (let x = 0; x <= 2; x++) for (let z = 0; z <= 2; z++) tile("terrain", x, z, 1, 0, ox, oz);
    const eLvl = edge === "terrain_side" ? 1 : 0; // side=HIGH, cliff=LOW
    for (let x = 0; x <= 2; x++) { tile(edge, x, -1, eLvl, 180, ox, oz); tile(edge, x, 3, eLvl, 0, ox, oz); }
    for (let z = 0; z <= 2; z++) { tile(edge, -1, z, eLvl, 270, ox, oz); tile(edge, 3, z, eLvl, 90, ox, oz); }
    tile("terrain_sideCorner", -1, -1, 0, 270, ox, oz); // SW low corner −X−Z
    tile("terrain_sideCorner", 3, -1, 0, 180, ox, oz);  // SE low corner +X−Z
    tile("terrain_sideCorner", -1, 3, 0, 0, ox, oz);    // NW... high −X+Z
    tile("terrain_sideCorner", 3, 3, 0, 90, ox, oz);    // NE high +X+Z
  }
  plateau3(2, -8, "terrain_side");
  label("plateau: SIDE (buggy?)", 3, 2, -9, "#ff8080");
  plateau3(10, -8, "terrain_sideCliff");
  label("plateau: SIDECLIFF", 11, 2, -9, "#80ff80");

  // Grid + axis helper so +X / +Z are unmistakable.
  const grid = new THREE.GridHelper(60, 60, 0x334, 0x223);
  grid.position.set(15, -0.01, 15);
  scene.add(grid);
  scene.add(new THREE.AxesHelper(3)); // red=+X, green=+Y, blue=+Z

  camTarget.set(5, 0, TERRAIN.length * 1.25);
  place();
  (document.getElementById("info") as HTMLElement).textContent = info.join("\n");
  (window as unknown as Record<string, unknown>).__diag = { lib, geos, scene, camera };
  (window as unknown as Record<string, unknown>).__ready = true;
})();

renderer.setAnimationLoop(() => renderer.render(scene, camera));
