import { describe, expect, it } from "vitest";
import { JitterResampler, SnapshotBuffer } from "./snapshotBuffer";

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

describe("JitterResampler", () => {
  it("passes the first arrival through unchanged (nothing to smooth against yet)", () => {
    const r = new JitterResampler();
    expect(r.resample(1000)).toBe(1000);
  });

  it("smooths jittery arrival times toward a near-uniform 30Hz grid when the average rate is stable", () => {
    const r = new JitterResampler();
    const nominalInterval = 1000 / 30;
    // +-15ms jitter around the nominal interval, but a stable AVERAGE rate —
    // this is the "steady sender, noisy network/timer" case the resampler
    // targets. Real jitter isn't literally this pattern, but any zero-mean
    // noise around a stable rate should be smoothed similarly.
    // Sums to exactly 0 over one cycle so the long-run average rate is truly
    // stable, isolating "jitter smoothing" from "rate estimation".
    const jitters = [0, 10, -8, 15, -12, 5, -5, 12, -10, -7];
    let arrival = 0;
    const outputs: number[] = [];
    for (let i = 0; i < 60; i++) {
      arrival += nominalInterval + jitters[i % jitters.length];
      outputs.push(r.resample(arrival));
    }
    // Drop the warm-up window while the EMA is still converging.
    const settled = outputs.slice(20);
    const deltas: number[] = [];
    for (let i = 1; i < settled.length; i++) deltas.push(settled[i] - settled[i - 1]);
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const variance = deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length;
    // Raw jitter stdev here is ~9-10ms; resampled output must be dramatically
    // smoother than the raw arrival deltas it was fed.
    expect(Math.sqrt(variance)).toBeLessThan(3);
    expect(mean).toBeCloseTo(nominalInterval, 0);
  });

  it("does not drift permanently away from real time when the true rate differs from the assumed nominal", () => {
    const r = new JitterResampler();
    // Sender is actually steady at 25Hz (40ms), not the assumed 30Hz default
    // — phase correction should pull the nominal clock back toward reality
    // over time instead of accumulating an ever-growing offset.
    let arrival = 0;
    let out = 0;
    for (let i = 0; i < 200; i++) {
      arrival += 40;
      out = r.resample(arrival);
    }
    expect(Math.abs(out - arrival)).toBeLessThan(50);
  });
});
