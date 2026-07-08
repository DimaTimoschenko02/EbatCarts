// Regression tests for the terrain_sideCliff / terrain_sideCornerInner
// branches in heightCellFor (see docs/space-kit-terrain-catalog.md for the
// vertex-verified facts these encode). Uses Heightfield.fromMapJson directly
// — no THREE, no asset templates needed, since this module is pure math
// shared between the client renderer (map/mapLoader.ts wraps it) and the
// Colyseus match server (server/config/arena.ts).
import { describe, expect, it } from "vitest";
import { Heightfield, heightCellFor, normRot, type MapJson } from "./heightfield";

function makeHeightfield(cells: MapJson["cells"]): Heightfield {
  return Heightfield.fromMapJson({
    meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
    cells,
  });
}

describe("heightCellFor branch ordering (startsWith prefix traps)", () => {
  it("terrain_sideCliff does NOT fall into the generic terrain_side branch", () => {
    // Regression for the documented latent bug: "terrain_sideCliff".startsWith
    // ("terrain_side") is true, so a naive branch order would give it the
    // HIGH-edge (y_level*lh - lh) base formula instead of the correct
    // LOW-edge (y_level*lh) one — a full level_height (0.5) height error.
    const cliffCell = heightCellFor("terrain_sideCliff", 2, 0, 0.5);
    const plainSideCell = heightCellFor("terrain_side", 2, 0, 0.5);
    expect(cliffCell.base).toBeCloseTo(1.0, 6); // y_level * lh = LOW edge
    expect(plainSideCell.base).toBeCloseTo(0.5, 6); // y_level * lh - lh = HIGH edge
    expect(cliffCell.base).not.toBeCloseTo(plainSideCell.base, 1);
  });

  it("terrain_sideCornerInner does NOT fall into the generic terrain_sideCorner branch", () => {
    // "terrain_sideCornerInner".startsWith("terrain_sideCorner") is true —
    // must resolve to the two-gradient (ax2/az2) MAX shape, not the plain
    // single-diagonal CORNER_ASCENT shape.
    const innerCell = heightCellFor("terrain_sideCornerInner", 0, 0, 0.5);
    const outerCell = heightCellFor("terrain_sideCorner", 0, 0, 0.5);
    expect(innerCell.ax2).toBeDefined();
    expect(innerCell.az2).toBeDefined();
    expect(outerCell.ax2).toBeUndefined();
    expect(outerCell.az2).toBeUndefined();
    // Outer uses a diagonal unit gradient (1/sqrt2); inner uses axis-aligned
    // unit gradients (magnitude 1) — different shape entirely, not just a
    // relabeling.
    expect(Math.abs(innerCell.ax)).toBeCloseTo(1, 6);
    expect(Math.abs(outerCell.ax)).toBeCloseTo(Math.SQRT1_2, 6);
  });
});

describe("terrain_sideCliff: axial ascent like side, but y_level = LOW edge", () => {
  it("rot=0 profile (base=0, ascends +Z) matches plain side's rot=0 profile shifted one y_level down", () => {
    // side y_level=1 rot=0 (HIGH edge semantics) gives the exact same absolute
    // height numbers as cliff y_level=0 rot=0 (LOW edge semantics) — this is
    // the "shifted by one level_height" relationship documented in the catalog.
    const hf = makeHeightfield([{ asset: "terrain_sideCliff", x: 0, z: 0, y_level: 0, rot: 0 }]);
    expect(hf.sample(0, -0.4)).toBeCloseTo(0.05, 5); // near low edge (-Z)
    expect(hf.sample(0, 0)).toBeCloseTo(0.25, 5); // mid
    expect(hf.sample(0, 0.4)).toBeCloseTo(0.45, 5); // near high edge (+Z)
  });

  it("rot=0 exact low edge (z=-0.5) is exactly base, no rise", () => {
    // wz=-0.5 rounds (JS round-half-towards-+Inf on -0.5 → -0 → cell 0) into
    // this same cell rather than the (empty) neighbor, so this is an exact
    // boundary sample, not an approximation.
    const hf = makeHeightfield([{ asset: "terrain_sideCliff", x: 0, z: 0, y_level: 0, rot: 0 }]);
    expect(hf.sample(0, -0.5)).toBeCloseTo(0, 10);
  });

  it("rot=90 ascends +X (same table as terrain_side)", () => {
    const hf = makeHeightfield([{ asset: "terrain_sideCliff", x: 0, z: 0, y_level: 0, rot: 90 }]);
    expect(hf.sample(-0.4, 0)).toBeCloseTo(0.05, 5); // near low edge (-X)
    expect(hf.sample(0.4, 0)).toBeCloseTo(0.45, 5); // near high edge (+X)
  });
});

describe("terrain_sideCornerInner: two-gradient MAX shape, y_level = LOW corner", () => {
  it("rot=0: low corner (+X-Z) near-corner probe is close to base (low)", () => {
    const hf = makeHeightfield([{ asset: "terrain_sideCornerInner", x: 0, z: 0, y_level: 0, rot: 0 }]);
    // Probe near, not exactly at, the low corner — same ±0.4 convention as
    // the existing sideCorner test in mapLoader.test.ts (exact ±0.5 rounds
    // into the empty neighbor cell).
    const nearCorner = hf.sample(0.4, -0.4)!;
    expect(nearCorner).toBeCloseTo(0.05, 5);
  });

  it("rot=0: center sits exactly halfway (where both edge-ramps agree) — NOT full rise", () => {
    // Both gradients evaluate to t=0.5 at the cell center (lx=lz=0), so
    // MAX(0.5, 0.5) = 0.5 — same center value a single diagonal gradient
    // would also give. The two-gradient MAX only changes behavior away from
    // the center, along the two straight high edges (see next test) — that
    // is the actual bug this shape variant fixes, not the center value.
    const hf = makeHeightfield([{ asset: "terrain_sideCornerInner", x: 0, z: 0, y_level: 0, rot: 0 }]);
    expect(hf.sample(0, 0)).toBeCloseTo(0.25, 5); // base(0) + rise(0.5) * 0.5
  });

  it("rot=0: the -X high edge reaches EXACTLY full rise at the boundary (the fix vs. a single diagonal gradient)", () => {
    // wx=-0.5 rounds (JS round-half-towards-+Inf on -0.5 → -0 → cell 0) into
    // this cell, giving an exact (not approximated) boundary sample.
    const hf = makeHeightfield([{ asset: "terrain_sideCornerInner", x: 0, z: 0, y_level: 0, rot: 0 }]);
    expect(hf.sample(-0.5, 0)).toBeCloseTo(0.5, 10); // base(0) + rise(0.5) * 1.0 exactly

    // Contrast: a single-diagonal gradient of the same magnitude convention
    // as CORNER_ASCENT (1/sqrt2 per axis) would undershoot badly at this same
    // point — computed inline here (not imported) purely to document the
    // magnitude of the bug the max2 shape fixes.
    const D = Math.SQRT1_2;
    const singleDiagonalT = Math.min(Math.max(0.5 + -0.5 * -D + 0 * D, 0), 1);
    const singleDiagonalHeight = 0 + 0.5 * singleDiagonalT;
    expect(singleDiagonalHeight).toBeCloseTo(0.5 * (0.5 + 0.5 * D), 5);
    expect(singleDiagonalHeight).toBeLessThan(0.43); // well short of the 0.5 full-rise the real mesh has here
  });

  it("rot=0: the +Z high edge also approaches full rise (near-boundary probe, ties resolve away from this cell)", () => {
    const hf = makeHeightfield([{ asset: "terrain_sideCornerInner", x: 0, z: 0, y_level: 0, rot: 0 }]);
    expect(hf.sample(0, 0.49)).toBeCloseTo(0.5, 1);
  });

  it("rot=90/180/270 low-corner directions match the catalog table", () => {
    // Sanity check the whole CORNER_INNER_ASCENT table via near-corner probes
    // for each rotation, per docs/space-kit-terrain-catalog.md:
    //   rot=0   low corner +X-Z
    //   rot=90  low corner +X+Z
    //   rot=180 low corner -X+Z
    //   rot=270 low corner -X-Z
    const cases: Array<{ rot: number; x: number; z: number }> = [
      { rot: 90, x: 0.4, z: 0.4 },
      { rot: 180, x: -0.4, z: 0.4 },
      { rot: 270, x: -0.4, z: -0.4 },
    ];
    for (const c of cases) {
      const hf = makeHeightfield([{ asset: "terrain_sideCornerInner", x: 0, z: 0, y_level: 0, rot: c.rot }]);
      expect(hf.sample(c.x, c.z)).toBeCloseTo(0.05, 5);
    }
  });
});

describe("normRot / heightCellFor exports used directly by the diagnostic scan script", () => {
  it("normRot wraps to [0, 360)", () => {
    expect(normRot(-90)).toBe(270);
    expect(normRot(450)).toBe(90);
  });
});
