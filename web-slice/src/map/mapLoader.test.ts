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

// Static prop collision (large decorative rocks get a physics circle, small
// ones stay pure decoration) — see gameplay-programmer brief and
// .claude/rules/map-building.md "Props" section for the asset catalog.
describe("GameMap static prop obstacles", () => {
  // A template's footprint is whatever geometry it carries — real asset
  // templates are recentered on XZ by assetLoader.ts before they ever reach
  // GameMap, so a Box3 built here (already centered at the mesh's local
  // origin) is representative of what placeProp() actually sees at runtime.
  function boxTemplate(sizeX: number, sizeZ: number): THREE.Group {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(sizeX, 1, sizeZ)));
    return group;
  }

  function libWithProps(): Map<string, THREE.Group> {
    return new Map<string, THREE.Group>([
      ["terrain", new THREE.Group()],
      ["rock_largeA", boxTemplate(2.0, 1.2)], // non-square footprint, max dim = x
      ["rock_crystalsLargeA", boxTemplate(1.0, 1.6)], // max dim = z
      ["rock", boxTemplate(0.6, 0.6)], // small decorative rock — no collision
      ["rocks_smallA", boxTemplate(0.8, 0.8)], // small scatter — no collision
    ]);
  }

  function makePropMap(props: MapJson["props"], originOffset: [number, number, number] = [0, 0, 0]): GameMap {
    return GameMap.fromJson(
      {
        meta: { tile_size: 1, level_height: 0.5, origin_offset: originOffset },
        props,
      },
      libWithProps()
    );
  }

  it("large prop (rock_largeA) gets a collision circle at its world position, scaled and shrunk", () => {
    const map = makePropMap([{ asset: "rock_largeA", x: 3, z: -2, y_level: 1, scale: 0.8 }], [-1, 0, 0.5]);
    const obstacles = map.getStaticObstacles();
    expect(obstacles).toHaveLength(1);
    // world x = 3*1 + (-1) = 2, world z = -2*1 + 0.5 = -1.5.
    expect(obstacles[0].x).toBeCloseTo(2, 6);
    expect(obstacles[0].z).toBeCloseTo(-1.5, 6);
    expect(obstacles[0].alive).toBe(true);
    // footprint max(size.x, size.z) = max(2.0, 1.2) = 2.0 → radius = (2.0/2) * 0.8(scale) * 0.8(shrink) = 0.64.
    expect(obstacles[0].radius).toBeCloseTo(0.64, 6);
  });

  it("uses max(size.x, size.z) regardless of which axis is longer", () => {
    const map = makePropMap([{ asset: "rock_crystalsLargeA", x: 0, z: 0, y_level: 0, scale: 1 }]);
    // footprint max(1.0, 1.6) = 1.6 → radius = (1.6/2) * 1 * 0.8 = 0.64.
    expect(map.getStaticObstacles()[0].radius).toBeCloseTo(0.64, 6);
  });

  it("small decorative props (rock, rocks_smallA) get NO collision circle", () => {
    const map = makePropMap([
      { asset: "rock", x: 1, z: 1, y_level: 0 },
      { asset: "rocks_smallA", x: 2, z: 2, y_level: 0 },
    ]);
    expect(map.getStaticObstacles()).toHaveLength(0);
  });

  it("defaults to scale 1 when a large prop omits it", () => {
    const map = makePropMap([{ asset: "rock_largeA", x: 0, z: 0, y_level: 0 }]);
    // radius = (2.0/2) * 1(default scale) * 0.8 = 0.8.
    expect(map.getStaticObstacles()[0].radius).toBeCloseTo(0.8, 6);
  });

  it("a map with no large props exposes an empty static obstacle list", () => {
    const map = makeMap([{ asset: "terrain", x: 0, z: 0, y_level: 0 }]);
    expect(map.getStaticObstacles()).toEqual([]);
  });
});
