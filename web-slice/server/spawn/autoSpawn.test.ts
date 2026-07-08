import { describe, expect, it } from "vitest";
import { deriveBoxGrid, deriveSpawnGrid, farthestPointSample, findFlatSpawnCandidates } from "./autoSpawn";
import type { MapJson } from "../../src/shared/heightfield";

// A 10x10 flat plaza (rect_fill) with a ramp cut into one edge and a raised,
// disconnected 3x3 plateau in the corner — enough shape to exercise "flat",
// "edge of the flat region", and "not flat" in one small fixture.
function makeFixtureMap(): MapJson {
  return {
    meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
    rect_fills: [
      { asset: "terrain", x_min: 0, x_max: 9, z_min: 0, z_max: 9, y_level: 1, rot: 0 },
    ],
    cells: [
      // ramp cut into the plaza's edge at x=9 — should never be a candidate,
      // and should also disqualify its flat neighbor at x=8 from candidacy.
      { asset: "terrain_ramp", x: 10, z: 5, y_level: 1, rot: 180 },
      // a flat road tile counts as flat too.
      { asset: "terrain_roadStraight", x: 5, z: 5, y_level: 1, rot: 0 },
    ],
  };
}

describe("findFlatSpawnCandidates", () => {
  it("includes plain terrain and road tiles, excludes ramps/sides", () => {
    const candidates = findFlatSpawnCandidates(makeFixtureMap());
    const keys = new Set(candidates.map(c => c.x + "," + c.z));
    expect(keys.has("5,5")).toBe(true); // road tile, fully surrounded by flat terrain
    expect(keys.has("10,5")).toBe(false); // the ramp itself
  });

  it("excludes cells at the flat region's outer edge (neighbor missing)", () => {
    const candidates = findFlatSpawnCandidates(makeFixtureMap());
    const keys = new Set(candidates.map(c => c.x + "," + c.z));
    // x=0 / x=9 / z=0 / z=9 are the plaza's outer ring — every one of them
    // has at least one missing neighbor (off the fixture entirely).
    expect(keys.has("0,0")).toBe(false);
    expect(keys.has("9,9")).toBe(false);
    expect(keys.has("0,5")).toBe(false);
    // an interior cell one step in from every edge must survive.
    expect(keys.has("5,4")).toBe(true);
  });

  it("is deterministic and sorted by (x, z)", () => {
    const a = findFlatSpawnCandidates(makeFixtureMap());
    const b = findFlatSpawnCandidates(makeFixtureMap());
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i++) {
      const prev = a[i - 1];
      const cur = a[i];
      expect(cur.x > prev.x || (cur.x === prev.x && cur.z > prev.z)).toBe(true);
    }
  });
});

describe("farthestPointSample", () => {
  it("spreads points out instead of clustering", () => {
    const candidates = findFlatSpawnCandidates(makeFixtureMap());
    const picked = farthestPointSample(candidates, 4);
    expect(picked.length).toBe(4);
    // no two picks should be adjacent (distance 1) when far-apart interior
    // cells are available in an 8x8 interior region.
    for (let i = 0; i < picked.length; i++) {
      for (let j = i + 1; j < picked.length; j++) {
        const d = Math.hypot(picked[i].x - picked[j].x, picked[i].z - picked[j].z);
        expect(d).toBeGreaterThan(1);
      }
    }
  });

  it("never returns duplicate points and caps at candidate count", () => {
    const candidates = findFlatSpawnCandidates(makeFixtureMap());
    const picked = farthestPointSample(candidates, 9999);
    const keys = new Set(picked.map(c => c.x + "," + c.z));
    expect(keys.size).toBe(picked.length);
    expect(picked.length).toBe(candidates.length);
  });

  it("is deterministic across repeated calls on the same input", () => {
    const candidates = findFlatSpawnCandidates(makeFixtureMap());
    expect(farthestPointSample(candidates, 4)).toEqual(farthestPointSample(candidates, 4));
  });
});

describe("deriveSpawnGrid / deriveBoxGrid", () => {
  it("derives at least 6 spawn points on the fixture and box points exclude them", () => {
    const map = makeFixtureMap();
    const spawns = deriveSpawnGrid(map, 6);
    expect(spawns.length).toBe(6);

    const boxes = deriveBoxGrid(map, 6, spawns);
    const spawnKeys = new Set(spawns.map(([x, z]) => x + "," + z));
    for (const [x, z] of boxes) {
      expect(spawnKeys.has(x + "," + z)).toBe(false);
    }
  });

  it("returns fewer points than requested (not throws) when the map is too small", () => {
    const tiny: MapJson = {
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      rect_fills: [{ asset: "terrain", x_min: 0, x_max: 2, z_min: 0, z_max: 2, y_level: 0, rot: 0 }],
    };
    // only the center cell (1,1) has all 4 neighbors present.
    const spawns = deriveSpawnGrid(tiny, 6);
    expect(spawns).toEqual([[1, 1]]);
  });
});
