import { describe, expect, it } from "vitest";
import { Heightfield } from "../../src/shared/heightfield";
import { WEAPON_TYPES } from "../../src/weapons/stats";
import {
  computeAoeDamage,
  computeMuzzleDirections,
  findProximityHit,
  isBlockedByTerrain,
  stepRocket,
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
  it("advances position along direction at speed*dt", () => {
    const next = stepRocket({ x: 0, z: 0 }, { x: 0, z: -1 }, 40, 0.5);
    expect(next).toEqual({ x: 0, z: -20 });
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

  it("flies over flat ground below flight height", () => {
    expect(isBlockedByTerrain({ x: 0, z: 0 }, 0.5, hf)).toBe(false);
  });

  it("explodes against terrain taller than the flight height", () => {
    expect(isBlockedByTerrain({ x: 1, z: 0 }, 0.5, hf)).toBe(true);
  });

  it("explodes when it leaves the map (null height = wall)", () => {
    expect(isBlockedByTerrain({ x: 50, z: 50 }, 0.5, hf)).toBe(true);
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
