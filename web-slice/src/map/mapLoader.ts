// JSON grid-map loader — three.js port of scripts/map_loader.gd, following
// .claude/rules/map-building.md:
//
//   world_pos = (x * tile_size, y_level * level_height, z * tile_size) + origin_offset
//
// The loader "dumbly places" assets — no auto-sides / auto-corner magic (that
// was deliberately removed in the Godot version after it caused more bugs
// than it solved). On top of placement it builds a HEIGHTFIELD the physics
// can sample: flat tiles map to their top surface, ramps and sides map to a
// linear slope across the cell (both rise exactly one level_height per tile).
//
// Rotation tables (verified in Godot via vertex inspection, see rules file):
//   terrain_ramp  (y_level = LOW):   rot 0 → ascends +X, 180 → −X, 90 → −Z, −90 → +Z
//   terrain_side* (y_level = HIGH):  rot 0 → descends −Z, 90 → −X, 180 → +Z, −90 → +X
// Corner tiles are approximated by the plain-side slope of the same rot —
// good enough for a point-sampled arcade heightfield.
import * as THREE from "three";
import type { AssetLibrary } from "./assetLoader";

interface CellDef {
  asset: string;
  x: number;
  z: number;
  y_level: number;
  rot?: number;
}

interface RectFill {
  asset: string;
  x_min: number;
  x_max: number;
  z_min: number;
  z_max: number;
  y_level: number;
  rot?: number;
}

interface PropDef {
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
interface HeightCell {
  base: number;
  rise: number;
  ax: number;
  az: number;
}

// Ascent direction per rotation table above (side descends → ascent is opposite).
const RAMP_ASCENT: Record<number, [number, number]> = {
  0: [1, 0], 180: [-1, 0], 90: [0, -1], 270: [0, 1],
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

function normRot(rot: number | undefined): number {
  return ((Math.round(rot ?? 0) % 360) + 360) % 360;
}

export class GameMap {
  readonly root = new THREE.Group();
  private readonly heights = new Map<string, HeightCell>();
  private tile = 1;
  private levelHeight = 0.5;
  private origin = new THREE.Vector3();

  // Ground height at a world XZ point, or null when there is no cell there
  // (off the map edge → the mover treats it as a wall).
  sampleHeight(wx: number, wz: number): number | null {
    const fx = (wx - this.origin.x) / this.tile;
    const fz = (wz - this.origin.z) / this.tile;
    const cx = Math.round(fx);
    const cz = Math.round(fz);
    const cell = this.heights.get(cx + "," + cz);
    if (!cell) return null;
    const t = THREE.MathUtils.clamp(0.5 + (fx - cx) * cell.ax + (fz - cz) * cell.az, 0, 1);
    return cell.base + cell.rise * t;
  }

  private setHeight(cx: number, cz: number, cell: HeightCell): void {
    this.heights.set(cx + "," + cz, cell);
  }

  private heightCellFor(asset: string, yLevel: number, rot: number): HeightCell {
    const lh = this.levelHeight;
    if (asset.startsWith("terrain_ramp")) {
      const [ax, az] = RAMP_ASCENT[rot] ?? [0, 0];
      return { base: yLevel * lh, rise: lh, ax, az }; // y_level = LOW edge
    }
    if (asset.startsWith("terrain_sideCorner")) {
      // Ramp-like vertically: geometry spans [0, +level_height] above pivot.
      const [ax, az] = CORNER_ASCENT[rot] ?? [0, 0];
      return { base: yLevel * lh, rise: lh, ax, az }; // y_level = LOW edge
    }
    if (asset.startsWith("terrain_side")) {
      const [ax, az] = SIDE_ASCENT[rot] ?? [0, 0];
      return { base: yLevel * lh - lh, rise: lh, ax, az }; // y_level = HIGH edge
    }
    return { base: yLevel * lh, rise: 0, ax: 0, az: 0 }; // flat terrain / roads
  }

  private place(lib: AssetLibrary, def: CellDef): void {
    const template = lib.get(def.asset);
    if (!template) {
      console.warn("[map] unknown asset:", def.asset);
      return;
    }
    const rot = normRot(def.rot);
    const inst = template.clone();
    inst.position.set(
      def.x * this.tile + this.origin.x,
      def.y_level * this.levelHeight + this.origin.y,
      def.z * this.tile + this.origin.z
    );
    inst.rotation.y = THREE.MathUtils.degToRad(rot);
    this.root.add(inst);
    this.setHeight(def.x, def.z, this.heightCellFor(def.asset, def.y_level, rot));
  }

  private placeProp(lib: AssetLibrary, def: PropDef): void {
    const template = lib.get(def.asset);
    if (!template) {
      console.warn("[map] unknown prop asset:", def.asset);
      return;
    }
    const inst = template.clone();
    inst.position.set(
      def.x * this.tile + this.origin.x,
      def.y_level * this.levelHeight + this.origin.y,
      def.z * this.tile + this.origin.z
    );
    inst.rotation.y = THREE.MathUtils.degToRad(def.rot ?? 0);
    inst.scale.setScalar(def.scale ?? 1);
    this.root.add(inst);
  }

  static async load(url: string, lib: AssetLibrary): Promise<GameMap> {
    const data = (await (await fetch(url)).json()) as MapJson;
    return GameMap.fromJson(data, lib);
  }

  static fromJson(data: MapJson, lib: AssetLibrary): GameMap {
    const map = new GameMap();
    map.tile = data.meta.tile_size;
    map.levelHeight = data.meta.level_height;
    map.origin.fromArray(data.meta.origin_offset);

    for (const rect of data.rect_fills ?? []) {
      for (let x = rect.x_min; x <= rect.x_max; x++) {
        for (let z = rect.z_min; z <= rect.z_max; z++) {
          map.place(lib, { asset: rect.asset, x, z, y_level: rect.y_level, rot: rect.rot });
        }
      }
    }
    for (const cell of data.cells ?? []) map.place(lib, cell);
    for (const prop of data.props ?? []) map.placeProp(lib, prop);
    return map;
  }
}
