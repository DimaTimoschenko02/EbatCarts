// Tests for ContinuousDrift v4.0 — smoothness bounds are the whole point of
// this design, so they are asserted numerically here, per the systems-designer
// spec's "metrics for smoothness" section.
import { describe, expect, it } from "vitest";
import { ContinuousDrift } from "./driftContinuous";
import { DEFAULT_KART_PHYSICS_PARAMS } from "./types";

const DT = 1 / 120;

function makeDrift(overrides: Partial<typeof DEFAULT_KART_PHYSICS_PARAMS> = {}) {
  return new ContinuousDrift({ ...DEFAULT_KART_PHYSICS_PARAMS, ...overrides });
}

// Drive N ticks with constant inputs, collecting outputs.
function run(
  drift: ContinuousDrift,
  ticks: number,
  inp: { speed: number; steer: number; throttle: number; onFloor?: boolean }
) {
  const outs = [];
  for (let i = 0; i < ticks; i++) {
    outs.push(drift.update(inp.speed, inp.steer, inp.onFloor ?? true, inp.throttle, DT));
  }
  return outs;
}

describe("ContinuousDrift v4.0 — engagement", () => {
  it("engages under sustained high steer + speed + throttle, proportionally (no state flip)", () => {
    const drift = makeDrift();
    const outs = run(drift, 240, { speed: 15, steer: 1, throttle: 1 }); // 2 s
    // engage grows monotonically toward 1, never jumps
    let prev = 0;
    for (const o of outs) {
      expect(o.engageFactor).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = o.engageFactor;
    }
    // after 2 s at inRate=1: 1 - e^-2 ≈ 0.86
    expect(outs[outs.length - 1].engageFactor).toBeGreaterThan(0.8);
    expect(outs[outs.length - 1].direction).toBe(1);
  });

  it("does not engage below the steer gate LO, partially engages inside the gate window", () => {
    const below = makeDrift();
    const outsBelow = run(below, 240, { speed: 15, steer: 0.3, throttle: 1 }); // < gateLo 0.35
    expect(outsBelow[outsBelow.length - 1].engageFactor).toBeLessThan(0.001);

    const mid = makeDrift();
    const outsMid = run(mid, 600, { speed: 15, steer: 0.45, throttle: 1 }); // inside [0.35, 0.55]
    const engaged = outsMid[outsMid.length - 1].engageFactor;
    expect(engaged).toBeGreaterThan(0.05); // partially on — continuous ramp, not a threshold
    expect(engaged).toBeLessThan(0.9);
  });

  it("passes through zero smoothly on direction flip (no re-arm)", () => {
    const drift = makeDrift();
    run(drift, 240, { speed: 15, steer: 1, throttle: 1 });
    const outs = run(drift, 600, { speed: 15, steer: -1, throttle: 1 });
    // dFast must cross zero and re-engage the other way — continuously
    expect(outs[outs.length - 1].direction).toBe(-1);
    expect(outs[outs.length - 1].engageFactor).toBeGreaterThan(0.7);
  });

  it("releases the intent when airborne (target drops, filter smooths)", () => {
    const drift = makeDrift();
    run(drift, 240, { speed: 15, steer: 1, throttle: 1 });
    const before = drift.getDFast();
    const outs = run(drift, 120, { speed: 15, steer: 1, throttle: 1, onFloor: false });
    expect(Math.abs(outs[outs.length - 1].engageFactor)).toBeLessThan(Math.abs(before));
  });
});

describe("ContinuousDrift v4.0 — smoothness metrics (spec §5)", () => {
  it("metric 1: |ΔD_fast| per tick bounded by 2 * max(inRate, outRate) * dt * 1.2", () => {
    const p = DEFAULT_KART_PHYSICS_PARAMS;
    // ΔD ≈ (target - D) * rate * dt; |target - D| ≤ 2 on a full flick
    // (signed range [-1,1]), hence the factor 2 vs the spec's unsigned bound.
    const bound = 2 * Math.max(p.driftEngageInRate, p.driftEngageOutRate) * DT * 1.2;
    const drift = makeDrift();
    // stress trace: ramp in, hold, flick to other side, release, re-tap
    const phases = [
      { ticks: 120, steer: 1, throttle: 1 },
      { ticks: 240, steer: 1, throttle: 1 },
      { ticks: 60, steer: -1, throttle: 1 },
      { ticks: 60, steer: 0, throttle: 1 },
      { ticks: 36, steer: 1, throttle: 1 },
      { ticks: 24, steer: 0, throttle: 0 },
    ];
    let prev = drift.getDFast();
    for (const ph of phases) {
      for (let i = 0; i < ph.ticks; i++) {
        drift.update(15, ph.steer, true, ph.throttle, DT);
        const cur = drift.getDFast();
        expect(Math.abs(cur - prev)).toBeLessThanOrEqual(bound);
        prev = cur;
      }
    }
  });

  it("metric 2: rear_grip_mult changes are bounded (no snap-grip anywhere, incl. exit)", () => {
    const drift = makeDrift();
    const grips: number[] = [];
    const record = (o: { rearGripMultiplier: number }) => grips.push(o.rearGripMultiplier);
    run(drift, 360, { speed: 15, steer: 1, throttle: 1 }).forEach(record); // deep drift
    run(drift, 360, { speed: 15, steer: 0, throttle: 1 }).forEach(record); // release — v3.1 snapped here
    let maxStep = 0;
    for (let i = 1; i < grips.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(grips[i] - grips[i - 1]));
    }
    // v3.1's exit snap could move grip by ~1.2 within a couple frames.
    // Continuous model: per-tick change stays tiny.
    expect(maxStep).toBeLessThan(0.02);
    // and grip fully recovers to 1 after release settles
    expect(grips[grips.length - 1]).toBeGreaterThan(0.97);
  });

  it("metric 6/boost: zero while holding, fires only on release, scales with hold time", () => {
    // long drift → release
    const long = makeDrift();
    const holdOuts = run(long, 600, { speed: 15, steer: 1, throttle: 1 }); // 5 s hold
    for (const o of holdOuts.slice(300)) {
      expect(o.exitBoostForce).toBe(0); // E chasing rising/steady |D| → no release
    }
    const longRelease = run(long, 240, { speed: 15, steer: 0, throttle: 1 });
    const longPeak = Math.max(...longRelease.map(o => o.exitBoostForce));
    expect(longPeak).toBeGreaterThan(1); // meaningful boost after sustained drift

    // short tap → release: boost negligible, no threshold param needed
    const tap = makeDrift();
    run(tap, 24, { speed: 15, steer: 1, throttle: 1 }); // 0.2 s tap
    const tapRelease = run(tap, 240, { speed: 15, steer: 0, throttle: 1 });
    const tapPeak = Math.max(...tapRelease.map(o => o.exitBoostForce));
    expect(tapPeak).toBeLessThan(longPeak * 0.25);
  });

  it("metric 7: rapid re-tap stress — all internal signals stay in bounds", () => {
    const drift = makeDrift();
    for (let cycle = 0; cycle < 5; cycle++) {
      run(drift, 36, { speed: 15, steer: 1, throttle: 1 }); // 0.3 s on
      run(drift, 24, { speed: 15, steer: 0, throttle: 1 }); // 0.2 s off
      expect(Math.abs(drift.getDFast())).toBeLessThanOrEqual(1);
      expect(drift.getHeat()).toBeGreaterThanOrEqual(0);
      expect(drift.getHeat()).toBeLessThanOrEqual(1);
      expect(drift.getEnergy()).toBeGreaterThanOrEqual(0);
      expect(drift.getEnergy()).toBeLessThanOrEqual(1);
    }
  });

  it("metric 8: steady-state convergence — grip settles to lerp(1, rearGripMult, 1) by 5×heatTau", () => {
    const p = DEFAULT_KART_PHYSICS_PARAMS;
    const drift = makeDrift();
    const ticks = Math.ceil((5 * p.driftHeatTau + 5 / p.driftEngageInRate) / DT);
    const outs = run(drift, ticks, { speed: 15, steer: 1, throttle: 1 });
    const settled = outs[outs.length - 1].rearGripMultiplier;
    expect(Math.abs(settled - p.driftRearGripMult)).toBeLessThan(0.01);
  });
});

describe("ContinuousDrift v4.0 — thermal fade (wide entry)", () => {
  it("grip dips BELOW steady-state right after engagement, then recovers (wide arc → circle)", () => {
    const p = { ...DEFAULT_KART_PHYSICS_PARAMS, driftEngageInRate: 4 }; // fast engage exaggerates the gap
    const drift = new ContinuousDrift(p);
    const outs = run(drift, Math.ceil(6 / DT), { speed: 15, steer: 1, throttle: 1 });
    const grips = outs.map(o => o.rearGripMultiplier);
    const minGrip = Math.min(...grips);
    const settled = grips[grips.length - 1];
    // early dip (thermal release) must undershoot the settled value noticeably
    // (measured: dip 0.2025 vs settled 0.2499 at these params — margin 0.03)
    expect(minGrip).toBeLessThan(settled - 0.03);
    // and the dip happens early (first 1.5 s), recovery after
    const minIdx = grips.indexOf(minGrip);
    expect(minIdx * DT).toBeLessThan(1.5);
  });

  it("no thermal effect during exit (heat above intent → gap clamps to 0)", () => {
    const drift = makeDrift();
    run(drift, 600, { speed: 15, steer: 1, throttle: 1 });
    const outs = run(drift, 300, { speed: 15, steer: 0, throttle: 1 });
    // during release grip must recover monotonically — no dip below current base
    let prev = outs[0].rearGripMultiplier;
    for (const o of outs) {
      expect(o.rearGripMultiplier).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = o.rearGripMultiplier;
    }
  });
});
