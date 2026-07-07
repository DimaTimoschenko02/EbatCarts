// Heightfield math is physics-critical (kart height follow + wall blocking),
// so the cell→height rules are pinned here. Slope tables come from
// .claude/rules/map-building.md; the sideCorner quirk (ramp-like Y span) was
// verified by a vertex read of the raw GLB in the browser (2026-07-06).
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { GameMap, type MapJson } from "./mapLoader";

// Placement templates are irrelevant for height math — use empty groups.
function stubLib(names: string[]): Map<string, THREE.Group> {
  return new Map(names.map(n => [n, new THREE.Group()]));
}

const LIB = stubLib([
  "terrain", "terrain_ramp", "terrain_side", "terrain_sideCorner", "terrain_roadStraight",
]);

function makeMap(cells: MapJson["cells"], rects: MapJson["rect_fills"] = []): GameMap {
  return GameMap.fromJson(
    {
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      rect_fills: rects,
      cells,
    },
    LIB
  );
}

describe("GameMap heightfield", () => {
  it("flat terrain: top surface at y_level * level_height, roads identical", () => {
    const map = makeMap([
      { asset: "terrain", x: 0, z: 0, y_level: 0 },
      { asset: "terrain", x: 1, z: 0, y_level: 2 },
      { asset: "terrain_roadStraight", x: 2, z: 0, y_level: 1, rot: 90 },
    ]);
    expect(map.sampleHeight(0, 0)).toBe(0);
    expect(map.sampleHeight(1, 0)).toBe(1.0);
    expect(map.sampleHeight(2, 0)).toBe(0.5);
  });

  it("off-map and between maps returns null (wall for the mover)", () => {
    const map = makeMap([{ asset: "terrain", x: 0, z: 0, y_level: 0 }]);
    expect(map.sampleHeight(5, 5)).toBeNull();
    expect(map.sampleHeight(-1.2, 0)).toBeNull();
  });

  // NB: cells are pivot-centered — cell (0,0) spans world [-0.5, 0.5); probes
  // sit at ±0.4 because exactly ±0.5 rounds into the (empty) neighbor cell.
  //
  // Ramp shares its ascent basis with terrain_side (+Z at rot=0) — verified by
  // direct GLB vertex inspection (tools/glb-catalog.mjs). An earlier version of
  // this test pinned a table that was rotated 90° off from the real mesh (ramp
  // ascended +X here while the rendered mesh actually rose along +Z) — see
  // docs/space-kit-terrain-catalog.md for the full discrepancy writeup.
  it("ramp rot=0 ascends +Z from its LOW y_level", () => {
    const map = makeMap([{ asset: "terrain_ramp", x: 0, z: 0, y_level: 0, rot: 0 }]);
    expect(map.sampleHeight(0, -0.4)).toBeCloseTo(0.05, 5); // near low edge
    expect(map.sampleHeight(0, 0)).toBeCloseTo(0.25, 5); // mid
    expect(map.sampleHeight(0, 0.4)).toBeCloseTo(0.45, 5); // near high edge
  });

  it("ramp rot=90 ascends +X from its LOW y_level", () => {
    const map = makeMap([{ asset: "terrain_ramp", x: 0, z: 0, y_level: 0, rot: 90 }]);
    expect(map.sampleHeight(-0.4, 0)).toBeCloseTo(0.05, 5); // near low edge
    expect(map.sampleHeight(0, 0)).toBeCloseTo(0.25, 5); // mid
    expect(map.sampleHeight(0.4, 0)).toBeCloseTo(0.45, 5); // near high edge
  });

  it("side rot=0 descends -Z from its HIGH y_level", () => {
    const map = makeMap([{ asset: "terrain_side", x: 0, z: 0, y_level: 1, rot: 0 }]);
    expect(map.sampleHeight(0, 0.4)).toBeCloseTo(0.45, 5); // near high edge (+Z)
    expect(map.sampleHeight(0, 0)).toBeCloseTo(0.25, 5);
    expect(map.sampleHeight(0, -0.4)).toBeCloseTo(0.05, 5); // near low edge (-Z)
  });

  it("sideCorner rot=90 rises diagonally toward +X+Z from its LOW y_level", () => {
    const map = makeMap([{ asset: "terrain_sideCorner", x: 0, z: 0, y_level: 0, rot: 90 }]);
    const high = map.sampleHeight(0.4, 0.4)!; // toward plateau-side corner
    const mid = map.sampleHeight(0, 0)!;
    const low = map.sampleHeight(-0.4, -0.4)!;
    expect(high).toBeCloseTo(0.5, 5); // diagonal ramp saturates at the corner
    expect(mid).toBeCloseTo(0.25, 5);
    expect(low).toBeLessThan(0.05);
  });

  it("rect_fills expand to every covered cell; later entries override earlier", () => {
    const map = makeMap(
      [{ asset: "terrain", x: 1, z: 1, y_level: 2 }],
      [{ asset: "terrain", x_min: 0, z_min: 0, x_max: 2, z_max: 2, y_level: 0, rot: 0 }]
    );
    expect(map.sampleHeight(0, 2)).toBe(0); // rect ground
    expect(map.sampleHeight(1, 1)).toBe(1.0); // overridden by the cell
  });
});
