// JSON grid-map loader — three.js port of scripts/map_loader.gd, following
// .claude/rules/map-building.md.
//
// The loader "dumbly places" assets — no auto-sides / auto-corner magic (that
// was deliberately removed in the Godot version after it caused more bugs
// than it solved). On top of placement it delegates the HEIGHTFIELD math to
// ../shared/heightfield.ts (extracted in the P3 combat slice so the Colyseus
// match server can sample the exact same terrain for rocket collision without
// duplicating the ascent tables — see server/config/arena.ts).
import * as THREE from "three";
import type { AssetLibrary } from "./assetLoader";
import { Heightfield, type CellDef, type MapJson, type PropDef } from "../shared/heightfield";
import type { KartObstacle } from "../physics/kartCollision";

export type { MapJson };

// A static (never-moving, always-alive) collision circle contributed by a
// map prop — see LARGE_PROP_ASSETS below. Superset of KartObstacle so it can
// be concatenated straight into the `obstacles` array Kart.update() already
// accepts from net/remoteKarts.ts getObstacles() (see main.ts wiring).
export interface StaticObstacle extends KartObstacle {
  radius: number;
}

// Which prop asset names get a physical collision circle — everything else
// (rock, rocks_smallA/B, rock_crystals) is pure decoration the kart drives
// straight through. See .claude/rules/map-building.md "Props" section for
// the asset catalog this mirrors. Keep this in sync if new big rock/crystal
// props are added to the Space Kit prop set.
const LARGE_PROP_ASSETS = new Set(["rock_largeA", "rock_crystalsLargeA", "rock_crystalsLargeB"]);

// Large props get a collision circle shrunk from their raw footprint AABB by
// this factor — arcade standard so grazing the rock's rough/uneven visual
// edge doesn't get treated as a hard hit (mirrors why KART_COLLISION_RADIUS
// itself is smaller than the kart mesh's own footprint).
const PROP_COLLISION_SHRINK = 0.8;

export class GameMap {
  readonly root = new THREE.Group();
  private heightfield = new Heightfield();
  private tile = 1;
  private levelHeight = 0.5;
  private origin = new THREE.Vector3();
  private staticObstacles: StaticObstacle[] = [];

  // Static collision circles contributed by large decorative props (see
  // LARGE_PROP_ASSETS) — concatenate with net.getObstacles() before passing
  // to Kart.update() (see main.ts).
  getStaticObstacles(): readonly StaticObstacle[] {
    return this.staticObstacles;
  }

  // Ground height at a world XZ point, or null when there is no cell there
  // (off the map edge → the mover treats it as a wall).
  sampleHeight(wx: number, wz: number): number | null {
    return this.heightfield.sample(wx, wz);
  }

  private place(lib: AssetLibrary, def: CellDef): void {
    const template = lib.get(def.asset);
    if (!template) {
      console.warn("[map] unknown asset:", def.asset);
      return;
    }
    const rot = ((Math.round(def.rot ?? 0) % 360) + 360) % 360;
    const inst = template.clone();
    inst.position.set(
      def.x * this.tile + this.origin.x,
      def.y_level * this.levelHeight + this.origin.y,
      def.z * this.tile + this.origin.z
    );
    inst.rotation.y = THREE.MathUtils.degToRad(rot);
    this.root.add(inst);
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

    if (LARGE_PROP_ASSETS.has(def.asset)) {
      // Radius from the UNSCALED template's own footprint AABB (rotation
      // around Y doesn't change the circle enclosing a centered footprint,
      // so def.rot needs no compensation here — only def.scale does).
      const box = new THREE.Box3().setFromObject(template);
      const size = box.getSize(new THREE.Vector3());
      const scale = def.scale ?? 1;
      const radius = (Math.max(size.x, size.z) / 2) * scale * PROP_COLLISION_SHRINK;
      this.staticObstacles.push({ x: inst.position.x, z: inst.position.z, alive: true, radius });
    }
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
    map.heightfield = Heightfield.fromMapJson(data);

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
