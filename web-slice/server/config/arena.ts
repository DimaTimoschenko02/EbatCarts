// Server-side arena data: loads the SAME map JSON the client renders by
// default (public/maps/${ACTIVE_MAP}.json, see src/shared/activeMap.ts — the
// one place that name is chosen, imported by both sides) and builds a
// Heightfield from it (shared math with the client, see
// src/shared/heightfield.ts) so rocket-vs-terrain collision uses the exact
// same slope rules the player sees.
//
// Spawn points and weapon-box points are DERIVED from the map JSON (flat
// cells clear of the island's edges, spread out via farthest-point sampling
// — see server/spawn/autoSpawn.ts) rather than hand-picked per map. This is
// what closes out the `// TODO: read spawn points from the map JSON once the
// match room knows which map is active` note that used to live in
// rooms/MatchRoom.ts: hardcoded grid coords only made sense while exactly
// one map (arena_slice) ever loaded; ACTIVE_MAP switching to mars_base
// exposed that they don't generalize (wrong plateau height → spawns
// underground / mid-air).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Heightfield, type MapJson } from "../../src/shared/heightfield";
import { ACTIVE_MAP } from "../../src/shared/activeMap";
import { deriveBoxGrid, deriveSpawnGrid, type GridPoint } from "../spawn/autoSpawn";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAP_PATH = path.join(__dirname, `../../public/maps/${ACTIVE_MAP}.json`);

const mapJson = JSON.parse(readFileSync(MAP_PATH, "utf-8")) as MapJson;
export const ARENA_HEIGHTFIELD = Heightfield.fromMapJson(mapJson);

export interface WorldPoint {
  x: number;
  z: number;
}

// MIN_KART_SPAWNS in the reference (spawn_manager.gd) is 4; we ask for 6 —
// deriveSpawnGrid returns fewer only if the map genuinely doesn't have that
// many flat, edge-clear cells (see autoSpawn.ts doc).
const SPAWN_GRID: readonly GridPoint[] = deriveSpawnGrid(mapJson, 6);

// Excludes the spawn cells so a box never stacks exactly on a spawn point.
const BOX_GRID: readonly GridPoint[] = deriveBoxGrid(mapJson, 6, SPAWN_GRID);

function toWorldPoints(grid: readonly GridPoint[]): WorldPoint[] {
  return grid.map(([gx, gz]) => ARENA_HEIGHTFIELD.gridToWorld(gx, gz));
}

export const SPAWN_POINTS: readonly WorldPoint[] = toWorldPoints(SPAWN_GRID);
export const BOX_POINTS: readonly WorldPoint[] = toWorldPoints(BOX_GRID);

// Ground height at any XZ point (falls back to 0 if somehow off the
// heightfield — shouldn't happen for the hand-picked spawn/box points
// above). Used both for box hover placement and for setting a respawned
// player's y before their client resumes reporting its own heightfield-
// sampled pose.
export function groundHeightAt(p: WorldPoint): number {
  return ARENA_HEIGHTFIELD.sample(p.x, p.z) ?? 0;
}
