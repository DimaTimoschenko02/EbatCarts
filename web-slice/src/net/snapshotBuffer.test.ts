import { describe, expect, it } from "vitest";
import { SnapshotBuffer } from "./snapshotBuffer";

describe("SnapshotBuffer", () => {
  it("returns null before anything is pushed", () => {
    const buf = new SnapshotBuffer();
    expect(buf.sample(0)).toBeNull();
  });

  it("interpolates linearly at the midpoint of two snapshots", () => {
    const buf = new SnapshotBuffer();
    buf.push({ t: 0, x: 0, y: 0, z: 0, yaw: 0 });
    buf.push({ t: 100, x: 10, y: 0, z: 20, yaw: 0 });
    const s = buf.sample(50);
    expect(s).not.toBeNull();
    expect(s!.x).toBeCloseTo(5, 6);
    expect(s!.z).toBeCloseTo(10, 6);
  });

  it("interpolates yaw the short way across the +-PI wrap boundary", () => {
    const buf = new SnapshotBuffer();
    const almostPi = Math.PI - 0.1;
    const almostNegPi = -Math.PI + 0.1;
    buf.push({ t: 0, x: 0, y: 0, z: 0, yaw: almostPi });
    buf.push({ t: 100, x: 0, y: 0, z: 0, yaw: almostNegPi });
    const s = buf.sample(50)!;
    // Short way across the wrap goes THROUGH +-PI, not back through 0 —
    // so the midpoint magnitude should stay close to PI, not collapse to 0.
    expect(Math.abs(s.yaw)).toBeGreaterThan(Math.PI - 0.2);
  });

  it("clamps to the oldest snapshot when sampling before the buffered range", () => {
    const buf = new SnapshotBuffer();
    buf.push({ t: 100, x: 1, y: 0, z: 1, yaw: 0 });
    buf.push({ t: 200, x: 2, y: 0, z: 2, yaw: 0 });
    const s = buf.sample(0)!;
    expect(s.x).toBe(1);
    expect(s.z).toBe(1);
  });

  it("clamps to the newest snapshot when sampling after the buffered range (no extrapolation)", () => {
    const buf = new SnapshotBuffer();
    buf.push({ t: 100, x: 1, y: 0, z: 1, yaw: 0 });
    buf.push({ t: 200, x: 2, y: 0, z: 2, yaw: 0 });
    const s = buf.sample(10_000)!;
    expect(s.x).toBe(2);
    expect(s.z).toBe(2);
  });

  it("returns the single snapshot when only one has been pushed", () => {
    const buf = new SnapshotBuffer();
    buf.push({ t: 50, x: 3, y: 0, z: 4, yaw: 1 });
    const s = buf.sample(999)!;
    expect(s.x).toBe(3);
    expect(s.yaw).toBe(1);
  });

  it("evicts the oldest entry once the buffer exceeds its cap", () => {
    const buf = new SnapshotBuffer();
    for (let i = 0; i < 40; i++) buf.push({ t: i * 50, x: i, y: 0, z: 0, yaw: 0 });
    expect(buf.length).toBeLessThanOrEqual(32);
  });
});
