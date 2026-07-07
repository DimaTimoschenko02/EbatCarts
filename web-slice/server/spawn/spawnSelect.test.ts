import { describe, expect, it } from "vitest";
import { faceCenterYaw, pickInitialSpawn, pickRespawnSpawn } from "./spawnSelect";

const POINTS = [
  { x: -9.5, z: -9.5 },
  { x: 9.5, z: -9.5 },
  { x: -9.5, z: 9.5 },
  { x: 9.5, z: 9.5 },
];

describe("pickInitialSpawn", () => {
  it("cycles round-robin through the points", () => {
    expect(pickInitialSpawn(POINTS, 0)).toBe(POINTS[0]);
    expect(pickInitialSpawn(POINTS, 1)).toBe(POINTS[1]);
    expect(pickInitialSpawn(POINTS, 4)).toBe(POINTS[0]); // wraps
    expect(pickInitialSpawn(POINTS, 5)).toBe(POINTS[1]);
  });
});

describe("pickRespawnSpawn", () => {
  it("with no enemies alive, returns the first point (all tie at Infinity)", () => {
    expect(pickRespawnSpawn(POINTS, [])).toBe(POINTS[0]);
  });

  it("picks the point farthest from the single nearest enemy", () => {
    // Enemy sits right on top of POINTS[0] — every other point should beat it,
    // and the opposite corner (POINTS[3]) is farthest.
    const enemy = { x: -9.4, z: -9.4 };
    expect(pickRespawnSpawn(POINTS, [enemy])).toBe(POINTS[3]);
  });

  it("with multiple enemies, picks the point maximizing the minimum distance", () => {
    // Enemies near POINTS[0] and POINTS[3] (the two ends of one diagonal) —
    // the other diagonal's points should be preferred over either corner.
    const enemies = [{ x: -9.4, z: -9.4 }, { x: 9.4, z: 9.4 }];
    const pick = pickRespawnSpawn(POINTS, enemies);
    expect(pick === POINTS[1] || pick === POINTS[2]).toBe(true);
  });
});

describe("faceCenterYaw", () => {
  it("origin spawn defaults to yaw 0", () => {
    expect(faceCenterYaw({ x: 0, z: 0 })).toBe(0);
  });

  it("spawn south of center (+Z) faces north (yaw=0, forward = -Z)", () => {
    expect(faceCenterYaw({ x: 0, z: 9.5 })).toBeCloseTo(0, 5);
  });

  it("spawn north of center (-Z) faces south (yaw=PI)", () => {
    const yaw = faceCenterYaw({ x: 0, z: -9.5 });
    expect(Math.abs(yaw)).toBeCloseTo(Math.PI, 5);
  });

  it("spawn east of center (+X) faces west (yaw=+PI/2, forward = -X)", () => {
    expect(faceCenterYaw({ x: 9.5, z: 0 })).toBeCloseTo(Math.PI / 2, 5);
  });

  it("spawn west of center (-X) faces east (yaw=-PI/2, forward = +X)", () => {
    expect(faceCenterYaw({ x: -9.5, z: 0 })).toBeCloseTo(-Math.PI / 2, 5);
  });
});
