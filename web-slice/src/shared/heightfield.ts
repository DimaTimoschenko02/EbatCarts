// Pure heightfield math — no THREE, no rendering. Extracted from
// map/mapLoader.ts (P3 combat vertical slice) so the SAME slope/ascent rules
// can be shared between the client renderer (GameMap wraps this) and the
// Colyseus match server (rocket-vs-terrain collision, server/config/arena.ts)
// without duplicating the ascent tables in two places.
//
// See .claude/rules/map-building.md for the grid conventions this encodes:
//   world_pos = (x * tile_size, y_level * level_height, z * tile_size) + origin_offset
//
// Rotation tables (verified by direct GLB vertex inspection, tools/glb-catalog.mjs,
// see docs/space-kit-terrain-catalog.md and .claude/rules/map-building.md):
//   terrain_ramp  (y_level = LOW):   rot 0 → ascends +Z, 90 → +X, 180 → −Z, 270 → −X
//   terrain_side* (y_level = HIGH):  rot 0 → descends −Z, 90 → −X, 180 → +Z, 270 → +X
// Ramp and side share the exact same ascent basis (+Z at rot=0) — same raw
// topology, just shifted above vs. below the pivot. Corner tiles ascend
// DIAGONALLY toward the plateau corner (see CORNER_ASCENT below).

export interface CellDef {
  asset: string;
  x: number;
  z: number;
  y_level: number;
  rot?: number;
}

export interface RectFill {
  asset: string;
  x_min: number;
  x_max: number;
  z_min: number;
  z_max: number;
  y_level: number;
  rot?: number;
}

export interface PropDef {
  asset: string;
  x: number;
  z: number;
  y_level: number;
  rot?: number;
  scale?: number;
}

export interface MapJson {
  meta: {
    tile_size: number;
    level_height: number;
    origin_offset: [number, number, number];
  };
  rect_fills?: RectFill[];
  cells?: CellDef[];
  props?: PropDef[];
}

// h(local) = base + rise * (0.5 + localX * ax + localZ * az), local ∈ [-0.5, 0.5].
// Flat cells: rise = 0, base = top surface. Slopes: base = low edge height,
// rise = level_height, (ax, az) = unit ascent direction.
//
// Optional (ax2, az2): second ascent gradient, combined with the first via
// MAX instead of a single lerp — used by terrain_sideCornerInner, whose real
// mesh is "almost the whole tile high, only a small wedge near one corner is
// low" (inversion of sideCorner). A single diagonal gradient (like
// CORNER_ASCENT) undershoots badly along the two straight high edges (dips to
// ~0.35 short of full rise there); MAX of two axis-aligned ramps (one per
// high edge) saturates to full rise exactly at both edges instead. See
// docs/space-kit-terrain-catalog.md "terrain_sideCornerInner".
export interface HeightCell {
  base: number;
  rise: number;
  ax: number;
  az: number;
  ax2?: number;
  az2?: number;
}

// Ascent direction per rotation table above (side descends → ascent is opposite).
// Ramp and side share the same ascent basis (+Z at rot=0) — the raw ramp mesh's
// low edge sits at local Z=-0.5, flat top at Z∈[0,+0.5], identical topology to
// terrain_side just shifted above the pivot instead of below it. Verified by
// direct vertex inspection (tools/glb-catalog.mjs).
const RAMP_ASCENT: Record<number, [number, number]> = {
  0: [0, 1], 90: [1, 0], 180: [0, -1], 270: [-1, 0],
};
const SIDE_ASCENT: Record<number, [number, number]> = {
  0: [0, 1], 90: [1, 0], 180: [0, -1], 270: [-1, 0],
};
// sideCorner ascends DIAGONALLY toward the plateau corner (verified by vertex
// read in the browser: at rot 90 the high edge sits at the +X+Z cell corner).
// Components are 1/√2 so the clamped height ramp reaches full rise at the corner.
const D = Math.SQRT1_2;
const CORNER_ASCENT: Record<number, [number, number]> = {
  0: [-D, D], 90: [D, D], 180: [D, -D], 270: [-D, -D],
};
// sideCliff: same axial ascent basis as terrain_side (low edge -Z at rot=0,
// straight not diagonal — verified by vertex read, docs/space-kit-terrain-
// catalog.md "terrain_sideCliff"), but the mesh's Y-span sits ABOVE the pivot
// like a ramp, so y_level means the LOW edge here (unlike plain side, where
// y_level means the HIGH edge). Kept as its own named alias (rather than
// reusing SIDE_ASCENT directly) so the two tables can diverge later without a
// silent shared-object edit.
const CLIFF_ASCENT: Record<number, [number, number]> = {
  0: [0, 1], 90: [1, 0], 180: [0, -1], 270: [-1, 0],
};
// sideCornerInner: inversion of sideCorner — almost the whole tile is HIGH,
// only a small wedge near one corner is low. rot table below is the LOW
// corner's (x,z) sign per docs/space-kit-terrain-catalog.md. Each entry holds
// two axis-aligned ascent gradients, one toward each of the two straight high
// edges adjacent to the low corner (opposite axis signs of the low corner) —
// combined via MAX in heightCellFor/sample (see HeightCell ax2/az2 doc).
const CORNER_INNER_ASCENT: Record<number, [number, number, number, number]> = {
  0: [-1, 0, 0, 1], // low corner +X-Z: ascend to -X, ascend to +Z
  90: [-1, 0, 0, -1], // low corner +X+Z: ascend to -X, ascend to -Z
  180: [1, 0, 0, -1], // low corner -X+Z: ascend to +X, ascend to -Z
  270: [1, 0, 0, 1], // low corner -X-Z: ascend to +X, ascend to +Z
};

export function normRot(rot: number | undefined): number {
  return ((Math.round(rot ?? 0) % 360) + 360) % 360;
}

export function heightCellFor(asset: string, yLevel: number, rot: number, levelHeight: number): HeightCell {
  const lh = levelHeight;
  if (asset.startsWith("terrain_ramp")) {
    const [ax, az] = RAMP_ASCENT[rot] ?? [0, 0];
    return { base: yLevel * lh, rise: lh, ax, az }; // y_level = LOW edge
  }
  if (asset.startsWith("terrain_sideCornerInner")) {
    // MUST be checked before the generic "terrain_sideCorner" branch below —
    // "terrain_sideCornerInner".startsWith("terrain_sideCorner") is true.
    // Ramp-like vertically (above pivot), same as sideCorner. Two ascent
    // gradients combined via MAX — see CORNER_INNER_ASCENT / HeightCell doc.
    const [ax, az, ax2, az2] = CORNER_INNER_ASCENT[rot] ?? [0, 0, 0, 0];
    return { base: yLevel * lh, rise: lh, ax, az, ax2, az2 }; // y_level = LOW corner
  }
  if (asset.startsWith("terrain_sideCorner")) {
    // Ramp-like vertically: geometry spans [0, +level_height] above pivot.
    const [ax, az] = CORNER_ASCENT[rot] ?? [0, 0];
    return { base: yLevel * lh, rise: lh, ax, az }; // y_level = LOW edge
  }
  if (asset.startsWith("terrain_sideCliff")) {
    // MUST be checked before the generic "terrain_side" branch below —
    // "terrain_sideCliff".startsWith("terrain_side") is true. Axial ascent
    // basis identical to plain side, but Y-span sits ABOVE the pivot like a
    // ramp, so y_level means the LOW edge (not the HIGH edge like plain side).
    const [ax, az] = CLIFF_ASCENT[rot] ?? [0, 0];
    return { base: yLevel * lh, rise: lh, ax, az }; // y_level = LOW edge
  }
  if (asset.startsWith("terrain_side")) {
    // LATENT: this also matches terrain_sideEnd ("terrain_side" prefix), whose
    // Y-span is likewise ramp-like above the pivot — see docs/space-kit-
    // terrain-catalog.md. Harmless today (sideEnd's rotation table isn't even
    // fully characterized yet, nothing places it); needs its own branch
    // before it's wired into a map, same fix pattern as sideCliff above.
    const [ax, az] = SIDE_ASCENT[rot] ?? [0, 0];
    return { base: yLevel * lh - lh, rise: lh, ax, az }; // y_level = HIGH edge
  }
  return { base: yLevel * lh, rise: 0, ax: 0, az: 0 }; // flat terrain / roads
}

// Pure grid heightfield: builds a lookup of per-cell slope descriptors from a
// MapJson and samples ground height at arbitrary world XZ. No THREE, no
// asset loading — safe to import from both the browser bundle and the
// Colyseus (Node) match server.
export class Heightfield {
  private readonly cells = new Map<string, HeightCell>();
  private tile = 1;
  private levelHeight = 0.5;
  private originX = 0;
  private originZ = 0;

  static fromMapJson(data: MapJson): Heightfield {
    const hf = new Heightfield();
    hf.tile = data.meta.tile_size;
    hf.levelHeight = data.meta.level_height;
    hf.originX = data.meta.origin_offset[0];
    hf.originZ = data.meta.origin_offset[2];

    for (const rect of data.rect_fills ?? []) {
      const rot = normRot(rect.rot);
      for (let x = rect.x_min; x <= rect.x_max; x++) {
        for (let z = rect.z_min; z <= rect.z_max; z++) {
          hf.setCell(x, z, heightCellFor(rect.asset, rect.y_level, rot, hf.levelHeight));
        }
      }
    }
    for (const cell of data.cells ?? []) {
      const rot = normRot(cell.rot);
      hf.setCell(cell.x, cell.z, heightCellFor(cell.asset, cell.y_level, rot, hf.levelHeight));
    }
    return hf;
  }

  private setCell(cx: number, cz: number, cell: HeightCell): void {
    this.cells.set(cx + "," + cz, cell);
  }

  // World XZ → grid cell coordinates (float, not rounded) — exposed so callers
  // (e.g. spawn/box placement) can convert grid coords to world without
  // duplicating the tile/origin formula.
  gridToWorld(gx: number, gz: number): { x: number; z: number } {
    return { x: gx * this.tile + this.originX, z: gz * this.tile + this.originZ };
  }

  // Ground height at a world XZ point, or null when there is no cell there
  // (off the map edge → treated as a wall / explosion trigger by callers).
  sample(wx: number, wz: number): number | null {
    const fx = (wx - this.originX) / this.tile;
    const fz = (wz - this.originZ) / this.tile;
    const cx = Math.round(fx);
    const cz = Math.round(fz);
    const cell = this.cells.get(cx + "," + cz);
    if (!cell) return null;
    const lx = fx - cx;
    const lz = fz - cz;
    let t = clamp(0.5 + lx * cell.ax + lz * cell.az, 0, 1);
    if (cell.ax2 !== undefined || cell.az2 !== undefined) {
      const t2 = clamp(0.5 + lx * (cell.ax2 ?? 0) + lz * (cell.az2 ?? 0), 0, 1);
      t = Math.max(t, t2);
    }
    return cell.base + cell.rise * t;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
