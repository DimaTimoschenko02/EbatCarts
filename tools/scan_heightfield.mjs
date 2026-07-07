#!/usr/bin/env node
// Diagnostic: replays GameMap's heightfield math (duplicated here so this can
// run standalone via plain node, no vite/vitest/three needed) against a map
// JSON, to empirically find height discontinuities instead of hand-deriving
// rotation tables (error-prone). Formula copied verbatim from
// web-slice/src/map/mapLoader.ts (heightCellFor / sampleHeight) — keep this
// duplicate in sync manually if that file's height math changes.
//
// Usage: node tools/scan_heightfield.mjs [path-to-map.json]

import { readFileSync } from "node:fs";
import { join } from "node:path";

const mapPath = process.argv[2] ?? join(process.cwd(), "web-slice", "public", "maps", "arena_slice.json");
const data = JSON.parse(readFileSync(mapPath, "utf8"));

const D = Math.SQRT1_2;
// RAMP_ASCENT fixed 2026-07-07 to match real GLB geometry (was rotated 90° off
// from the mesh — see docs/space-kit-terrain-catalog.md). Now identical to
// SIDE_ASCENT since both meshes ascend +Z at rot=0. Keep this duplicate in sync
// with web-slice/src/map/mapLoader.ts manually if that file changes again.
const RAMP_ASCENT = { 0: [0, 1], 90: [1, 0], 180: [0, -1], 270: [-1, 0] };
const SIDE_ASCENT = { 0: [0, 1], 90: [1, 0], 180: [0, -1], 270: [-1, 0] };
const CORNER_ASCENT = { 0: [-D, D], 90: [D, D], 180: [D, -D], 270: [-D, -D] };

function normRot(rot) {
  return ((Math.round(rot ?? 0) % 360) + 360) % 360;
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function heightCellFor(asset, yLevel, rot, lh) {
  if (asset.startsWith("terrain_ramp")) {
    const [ax, az] = RAMP_ASCENT[rot] ?? [0, 0];
    return { base: yLevel * lh, rise: lh, ax, az };
  }
  if (asset.startsWith("terrain_sideCorner")) {
    const [ax, az] = CORNER_ASCENT[rot] ?? [0, 0];
    return { base: yLevel * lh, rise: lh, ax, az };
  }
  if (asset.startsWith("terrain_side")) {
    const [ax, az] = SIDE_ASCENT[rot] ?? [0, 0];
    return { base: yLevel * lh - lh, rise: lh, ax, az };
  }
  return { base: yLevel * lh, rise: 0, ax: 0, az: 0 };
}

class GameMap {
  constructor(data) {
    this.tile = data.meta.tile_size;
    this.lh = data.meta.level_height;
    this.origin = data.meta.origin_offset;
    this.heights = new Map();
    for (const rect of data.rect_fills ?? []) {
      for (let x = rect.x_min; x <= rect.x_max; x++) {
        for (let z = rect.z_min; z <= rect.z_max; z++) {
          this.place({ asset: rect.asset, x, z, y_level: rect.y_level, rot: rect.rot });
        }
      }
    }
    for (const cell of data.cells ?? []) this.place(cell);
  }
  place(def) {
    const rot = normRot(def.rot);
    this.heights.set(def.x + "," + def.z, heightCellFor(def.asset, def.y_level, rot, this.lh));
  }
  sampleHeight(wx, wz) {
    const fx = (wx - this.origin[0]) / this.tile;
    const fz = (wz - this.origin[2]) / this.tile;
    const cx = Math.round(fx);
    const cz = Math.round(fz);
    const cell = this.heights.get(cx + "," + cz);
    if (!cell) return null;
    const t = clamp(0.5 + (fx - cx) * cell.ax + (fz - cz) * cell.az, 0, 1);
    return cell.base + cell.rise * t;
  }
}

const map = new GameMap(data);
const origin = data.meta.origin_offset;

const lo = 0, hi = 23, step = 0.1;
let bad = 0;
for (let x = lo; x <= hi; x += step) {
  let prev = null;
  for (let z = lo; z <= hi; z += step) {
    const h = map.sampleHeight(x + origin[0], z + origin[2]);
    if (prev !== null && h !== null && Math.abs(h - prev) > 0.15) {
      console.log(`DISCONTINUITY along Z at x=${x.toFixed(1)} z≈${z.toFixed(1)}: ${prev.toFixed(3)} -> ${h.toFixed(3)}`);
      bad++;
    }
    prev = h;
  }
}
for (let z = lo; z <= hi; z += step) {
  let prev = null;
  for (let x = lo; x <= hi; x += step) {
    const h = map.sampleHeight(x + origin[0], z + origin[2]);
    if (prev !== null && h !== null && Math.abs(h - prev) > 0.15) {
      console.log(`DISCONTINUITY along X at z=${z.toFixed(1)} x≈${x.toFixed(1)}: ${prev.toFixed(3)} -> ${h.toFixed(3)}`);
      bad++;
    }
    prev = h;
  }
}
console.log(`TOTAL bad transitions: ${bad}\n`);

console.log("--- West ramp profile along X (z=11.5) ---");
for (let x = 6.5; x <= 9.5; x += 0.25) {
  console.log(`x=${x.toFixed(2)} h=${map.sampleHeight(x + origin[0], 11.5 + origin[2])}`);
}
console.log("--- East ramp profile along X (z=11.5) ---");
for (let x = 13.5; x <= 16.5; x += 0.25) {
  console.log(`x=${x.toFixed(2)} h=${map.sampleHeight(x + origin[0], 11.5 + origin[2])}`);
}
console.log("--- West ramp cell (x=8) profile along Z (should be FLAT if ramp truly ascends X only) ---");
for (let z = 10.5; z <= 12.5; z += 0.25) {
  console.log(`z=${z.toFixed(2)} h=${map.sampleHeight(8 + origin[0], z + origin[2])}`);
}
console.log("--- NW corner cell (8,8) diagonal scan ---");
for (let t = -0.5; t <= 0.5; t += 0.1) {
  console.log(`t=${t.toFixed(2)} h=${map.sampleHeight(8 + t + origin[0], 8 + t + origin[2])}`);
}
console.log("--- NE corner cell (15,8) diagonal scan (toward -X+Z, i.e. t negative moves +X) ---");
for (let t = -0.5; t <= 0.5; t += 0.1) {
  console.log(`t=${t.toFixed(2)} h=${map.sampleHeight(15 - t + origin[0], 8 + t + origin[2])}`);
}
