import { describe, expect, it } from "vitest";
import { Heightfield } from "../../src/shared/heightfield";
import { WEAPON_TYPES } from "../../src/weapons/stats";
import {
  computeAoeDamage,
  computeLaunchPitchRad,
  computeMuzzleDirections,
  findProximityHit,
  isBlockedByTerrain,
  stepRocket,
  tiltDirection3D,
} from "./rocketSim";

const ROCKET = WEAPON_TYPES.rocket;

describe("computeMuzzleDirections", () => {
  it("volleyCount=3 fans -spreadDeg/0/+spreadDeg around yaw=0 (forward = -Z)", () => {
    const dirs = computeMuzzleDirections(0, ROCKET);
    expect(dirs).toHaveLength(3);
    expect(dirs[1].dx).toBeCloseTo(0, 5);
    expect(dirs[1].dz).toBeCloseTo(-1, 5); // center: straight forward (-Z)
    expect(dirs[0].yawOffsetRad).toBeCloseTo((-10 * Math.PI) / 180, 5);
    expect(dirs[2].yawOffsetRad).toBeCloseTo((10 * Math.PI) / 180, 5);
    // Side rockets still point mostly forward, just angled.
    expect(dirs[0].dz).toBeLessThan(0);
    expect(dirs[2].dz).toBeLessThan(0);
  });

  it("volleyCount=1 fires straight ahead only", () => {
    const single = { ...ROCKET, volleyCount: 1 };
    const dirs = computeMuzzleDirections(0, single);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].yawOffsetRad).toBe(0);
  });
});

describe("stepRocket", () => {
  it("advances position along direction at speed*dt (3D, flat launch)", () => {
    const next = stepRocket({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 40, 0.5);
    expect(next).toEqual({ x: 0, y: 1, z: -20 });
  });

  it("advances vertically too when dir has a Y component (pitched launch)", () => {
    const next = stepRocket({ x: 0, y: 1, z: 0 }, { x: 0, y: 0.5, z: -0.5 }, 10, 1);
    expect(next).toEqual({ x: 0, y: 6, z: -5 });
  });
});

describe("isBlockedByTerrain", () => {
  const hf = Heightfield.fromMapJson({
    meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
    cells: [
      { asset: "terrain", x: 0, z: 0, y_level: 0 },
      { asset: "terrain", x: 1, z: 0, y_level: 2 }, // 1.0m wall
    ],
  });

  it("flies over flat ground below its current altitude", () => {
    expect(isBlockedByTerrain({ x: 0, y: 0.5, z: 0 }, hf)).toBe(false);
  });

  it("explodes against terrain taller than the rocket's current altitude", () => {
    expect(isBlockedByTerrain({ x: 1, y: 0.5, z: 0 }, hf)).toBe(true);
  });

  it("explodes when it leaves the map (null height = wall)", () => {
    expect(isBlockedByTerrain({ x: 50, y: 0.5, z: 50 }, hf)).toBe(true);
  });
});

describe("computeLaunchPitchRad", () => {
  // Ramp climbing toward +z (see .claude/rules/map-building.md ramp table):
  // cell (0,0) at y_level=0 (ground 0.0m), cell (0,1) at y_level=1 (ground
  // 0.5m) — a straight uphill slope along +Z.
  const uphillHf = Heightfield.fromMapJson({
    meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
    cells: [
      { asset: "terrain", x: 0, z: 0, y_level: 0 },
      { asset: "terrain", x: 0, z: 1, y_level: 1 },
    ],
  });

  it("returns a positive (uphill) pitch when firing up a slope", () => {
    const pitch = computeLaunchPitchRad(0, 0, 0, 1, uphillHf, 0.5);
    expect(pitch).toBeGreaterThan(0);
  });

  it("returns a negative (downhill) pitch when firing down the same slope", () => {
    // Standing at the high end (z=1, 0.5m) firing back toward the low end
    // (z=0, 0.0m) — the mirror image of the uphill case above. Lookahead
    // bumped to 0.6 so the sample point (z=0.4) clearly lands in cell z=0
    // rather than sitting exactly on the round()-to-1 boundary at z=0.5.
    const pitch = computeLaunchPitchRad(0, 1, 0, -1, uphillHf, 0.6);
    expect(pitch).toBeLessThan(0);
  });

  it("returns 0 on flat ground", () => {
    const flatHf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "terrain", x: 0, z: 0, y_level: 1 },
        { asset: "terrain", x: 0, z: 1, y_level: 1 },
      ],
    });
    expect(computeLaunchPitchRad(0, 0, 0, 1, flatHf, 0.5)).toBeCloseTo(0, 5);
  });

  it("falls back to 0 when a sample point is off the map", () => {
    expect(computeLaunchPitchRad(0, 0, 0, 1, uphillHf, 50)).toBe(0);
  });

  it("clamps extreme slopes to a maximum launch pitch (cliff-edge safety)", () => {
    const cliffHf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "terrain", x: 0, z: 0, y_level: 0 },
        { asset: "terrain", x: 0, z: 1, y_level: 40 }, // absurd 20m wall right ahead
      ],
    });
    const pitch = computeLaunchPitchRad(0, 0, 0, 1, cliffHf, 0.5);
    expect(pitch).toBeCloseTo(Math.PI / 4, 5);
  });
});

describe("tiltDirection3D", () => {
  it("stays a unit vector and matches the flat direction at pitch=0", () => {
    const dir = tiltDirection3D(0, -1, 0);
    expect(dir).toEqual({ x: 0, y: 0, z: -1 });
  });

  it("adds a positive Y component and shrinks horizontal reach for an uphill pitch", () => {
    const dir = tiltDirection3D(0, 1, Math.PI / 4);
    expect(dir.y).toBeCloseTo(Math.SQRT1_2, 5);
    expect(dir.z).toBeCloseTo(Math.SQRT1_2, 5);
    const length = Math.hypot(dir.x, dir.y, dir.z);
    expect(length).toBeCloseTo(1, 5);
  });
});

describe("findProximityHit", () => {
  const players = [
    { id: "shooter", x: 0, z: -1 },
    { id: "victim", x: 0, z: -5 },
  ];

  it("excludes the shooter when selfDamage is false", () => {
    const hit = findProximityHit({ x: 0, z: -1 }, players, 1.0, "shooter", false);
    expect(hit).toBeNull();
  });

  it("includes the shooter when selfDamage is true", () => {
    const hit = findProximityHit({ x: 0, z: -1 }, players, 1.0, "shooter", true);
    expect(hit).toBe("shooter");
  });

  it("finds a non-shooter victim within hitRadius", () => {
    const hit = findProximityHit({ x: 0, z: -5.3 }, players, 1.0, "shooter", false);
    expect(hit).toBe("victim");
  });

  it("returns null when nobody is within range", () => {
    const hit = findProximityHit({ x: 100, z: 100 }, players, 1.0, "shooter", false);
    expect(hit).toBeNull();
  });
});

describe("computeAoeDamage", () => {
  const players = [
    { id: "shooter", x: 0, z: 0 },
    { id: "close", x: 0, z: 0 }, // point-blank
    { id: "mid", x: 1.75, z: 0 }, // half the 3.5m radius
    { id: "far", x: 4, z: 0 }, // outside the radius
  ];

  it("floor(baseDamage * falloff), skips the shooter, skips out-of-range", () => {
    const dmg = computeAoeDamage({ x: 0, z: 0 }, players, ROCKET, "shooter");
    expect(dmg.get("shooter")).toBeUndefined();
    expect(dmg.get("close")).toBe(40); // dist=0 -> falloff=1 -> floor(40)=40
    expect(dmg.get("mid")).toBe(20); // falloff=0.5 -> floor(20)=20
    expect(dmg.has("far")).toBe(false);
  });

  it("includes the shooter when selfDamage is true", () => {
    const selfDamageOn = { ...ROCKET, selfDamage: true };
    const dmg = computeAoeDamage({ x: 0, z: 0 }, players, selfDamageOn, "shooter");
    expect(dmg.get("shooter")).toBe(40);
  });
});
