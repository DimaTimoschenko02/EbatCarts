// Derives spawn/weapon-box grid coordinates directly from a loaded map's
// JSON instead of hand-picking coordinates per map (see the now-removed
// SPAWN_GRID/BOX_GRID hardcodes in server/config/arena.ts — those were
// authored against arena_slice.json specifically and silently spawned karts
// underground the moment the active map changed to anything else). Pure and
// unit-testable: no Colyseus/schema deps, just MapJson in, grid coords out.
import type { CellDef, MapJson, RectFill } from "../../src/shared/heightfield";

export interface GridCell {
  x: number;
  z: number;
  asset: string;
  yLevel: number;
}

// "terrain" itself, or any terrain_road* variant — both are flat quads per
// .claude/rules/map-building.md ("По форме идентичны terrain (плоские)").
// Ramps/sides/corners/cliffs all start with "terrain_" too but have their
// own more specific prefixes, so this must NOT just be `asset.startsWith
// ("terrain")` — that would also match terrain_ramp, terrain_side, etc.
const FLAT_ASSET_RE = /^terrain(_road.*)?$/;

function collectCells(map: MapJson): GridCell[] {
  const out: GridCell[] = [];
  for (const rect of (map.rect_fills ?? []) as RectFill[]) {
    for (let x = rect.x_min; x <= rect.x_max; x++) {
      for (let z = rect.z_min; z <= rect.z_max; z++) {
        out.push({ x, z, asset: rect.asset, yLevel: rect.y_level });
      }
    }
  }
  // cells[] is authored after rect_fills and wins on overlap, matching
  // Heightfield.fromMapJson's own last-write-wins ordering.
  for (const cell of (map.cells ?? []) as CellDef[]) {
    out.push({ x: cell.x, z: cell.z, asset: cell.asset, yLevel: cell.y_level });
  }
  return out;
}

// Flat cells whose four orthogonal neighbors all exist at the SAME y_level —
// guards against spawning right at a ramp/cliff boundary or the island's
// outer edge (where the next cell is void/air and a kart would spawn hanging
// over nothing). Sorted by (x, z) so the result is 100% deterministic given
// a fixed map file, independent of JSON array ordering.
export function findFlatSpawnCandidates(map: MapJson): GridCell[] {
  const cells = collectCells(map);
  const index = new Map<string, GridCell>();
  for (const c of cells) index.set(c.x + "," + c.z, c);

  const candidates: GridCell[] = [];
  for (const c of index.values()) {
    if (!FLAT_ASSET_RE.test(c.asset)) continue;
    const neighbors: [number, number][] = [
      [c.x + 1, c.z], [c.x - 1, c.z], [c.x, c.z + 1], [c.x, c.z - 1],
    ];
    const clearOfEdge = neighbors.every(([nx, nz]) => {
      const n = index.get(nx + "," + nz);
      return n !== undefined && n.yLevel === c.yLevel;
    });
    if (clearOfEdge) candidates.push(c);
  }
  candidates.sort((a, b) => a.x - b.x || a.z - b.z);
  return candidates;
}

// Greedy farthest-point sampling over `candidates`: starts at `startIndex`
// and repeatedly adds whichever remaining candidate maximizes its minimum
// distance to everything already chosen. Deterministic (no Math.random) —
// same map file always yields the same points, so spawns don't shuffle
// between server restarts.
export function farthestPointSample(
  candidates: readonly GridCell[],
  count: number,
  startIndex = 0
): GridCell[] {
  if (candidates.length === 0) return [];
  const chosen: GridCell[] = [candidates[startIndex % candidates.length]];
  while (chosen.length < count && chosen.length < candidates.length) {
    let best: GridCell | null = null;
    let bestMinDist = -Infinity;
    for (const c of candidates) {
      if (chosen.includes(c)) continue;
      let minDist = Infinity;
      for (const s of chosen) {
        const d = Math.hypot(s.x - c.x, s.z - c.z);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        best = c;
      }
    }
    if (!best) break;
    chosen.push(best);
  }
  return chosen;
}

export type GridPoint = readonly [number, number];

// `count` spread-out kart spawn points, in map grid coordinates (feed to
// Heightfield.gridToWorld for world XZ). Minimum useful arena needs at least
// a handful of flat cells clear of edges — callers should treat an empty/
// short result as a map-authoring problem, not silently spawn nowhere.
export function deriveSpawnGrid(map: MapJson, count = 6): GridPoint[] {
  const candidates = findFlatSpawnCandidates(map);
  return farthestPointSample(candidates, count).map(c => [c.x, c.z] as const);
}

// `count` weapon-box points, spread independently of (and excluding) the
// spawn points so boxes don't stack exactly on top of a spawn. Starts the
// farthest-point walk from the middle of the candidate list (rather than
// index 0, same as deriveSpawnGrid) purely so the two grids don't converge
// on the same corner of the candidate list when a map has few flat cells.
export function deriveBoxGrid(
  map: MapJson,
  count = 6,
  exclude: readonly GridPoint[] = []
): GridPoint[] {
  const excludeSet = new Set(exclude.map(([x, z]) => x + "," + z));
  const candidates = findFlatSpawnCandidates(map).filter(c => !excludeSet.has(c.x + "," + c.z));
  const startIndex = Math.floor(candidates.length / 2);
  return farthestPointSample(candidates, count, startIndex).map(c => [c.x, c.z] as const);
}
