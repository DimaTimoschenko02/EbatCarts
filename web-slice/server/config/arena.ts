// Server-side arena data: loads the same map JSON the client renders
// (public/maps/arena_slice.json) and builds a Heightfield from it (shared
// math with the client, see src/shared/heightfield.ts) so rocket-vs-terrain
// collision uses the exact same slope rules the player sees.
//
// Spawn points and weapon-box points are hand-picked grid coordinates read
// directly off arena_slice.json (ground level, clear of roads/plateau edges)
// — same "hardcode for now" approach as the existing
// `// TODO: read spawn points from the map JSON once the match room knows
// which map is active` comment in rooms/MatchRoom.ts. Not derived from a
// map-authored "spawn" marker layer because that format doesn't exist yet.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Heightfield, type MapJson } from "../../src/shared/heightfield";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAP_PATH = path.join(__dirname, "../../public/maps/arena_slice.json");

const mapJson = JSON.parse(readFileSync(MAP_PATH, "utf-8")) as MapJson;
export const ARENA_HEIGHTFIELD = Heightfield.fromMapJson(mapJson);

export interface WorldPoint {
  x: number;
  z: number;
}

// Ground-level points around the ring, clear of the road bands and the
// central plateau/skirt — verified against arena_slice.json's rect_fills
// (ground bands + inside-ring ground) and cell lists (road corners, plateau
// skirt cells). MIN_KART_SPAWNS in the reference is 4; we provide 6.
const SPAWN_GRID: readonly [number, number][] = [
  [2, 2], [21, 2], [2, 21], [21, 21], [11, 2], [11, 21],
];

// Mix of ground-level and plateau boxes (2 of 6 on the plateau) — a
// reasonable spread across the arena per docs/p2-port-notes.md §2, without
// inventing a map-authored box layer yet.
const BOX_GRID: readonly [number, number][] = [
  [2, 11], [21, 11], [6, 6], [17, 17], [10, 10], [13, 13],
];

function toWorldPoints(grid: readonly [number, number][]): WorldPoint[] {
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
