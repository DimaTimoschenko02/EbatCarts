// Tests for ContinuousDrift v4.0 — smoothness bounds are the whole point of
// this design, so they are asserted numerically here, per the systems-designer
// spec's "metrics for smoothness" section.
import { describe, expect, it } from "vitest";
import { ContinuousDrift } from "./driftContinuous";
import { DEFAULT_KART_PHYSICS_PARAMS } from "./types";

const DT = 1 / 120;

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

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
    // 2s at DEFAULT_KART_PHYSICS_PARAMS.driftEngageInRate (req 4: fast
    // engage, no ~1s waiting) — derived from the param, not hardcoded, so
    // this test doesn't silently go stale the next time the rate is tuned.
    const expected = 1 - Math.exp(-DEFAULT_KART_PHYSICS_PARAMS.driftEngageInRate * 2);
    expect(outs[outs.length - 1].engageFactor).toBeGreaterThan(expected - 0.05);
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
    // v3.1's exit snap could move grip by ~1.2 within a couple frames. The
    // continuous model's per-tick change is bounded by how fast dFast itself
    // can move (2 * max(inRate,outRate) * dt on a full-range flick, same
    // bound as metric 1 above) times grip's sensitivity to dFast
    // (|1 - driftRearGripMult|). Derived from the params (not hardcoded) so
    // tuning driftEngageInRate/OutRate doesn't make this test stale — this
    // is still WAY below v3.1's ~1.2 snap regardless of rate tuning.
    const p = DEFAULT_KART_PHYSICS_PARAMS;
    const gripDeltaBound = Math.abs(1 - p.driftRearGripMult) * 2 * Math.max(p.driftEngageInRate, p.driftEngageOutRate) * DT * 1.5;
    expect(maxStep).toBeLessThan(gripDeltaBound);
    expect(maxStep).toBeLessThan(0.3); // still nowhere near v3.1's ~1.2 snap
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

    // short tap → release: boost negligible, no threshold param needed.
    // "Short" is relative to driftEngageInRate — at the faster v4.1 default
    // (req 4: near-instant engage) a 0.2s tap is no longer short enough to
    // stay clearly below full engagement, so this uses a tap duration tied
    // to the rate's own time constant instead of a fixed tick count.
    const tap = makeDrift();
    const tapTicks = Math.max(2, Math.round(0.15 / DEFAULT_KART_PHYSICS_PARAMS.driftEngageInRate / DT));
    run(tap, tapTicks, { speed: 15, steer: 1, throttle: 1 });
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

describe("ContinuousDrift v4.0 — req 3: yaw effects die out with CURRENT speed, not just intent", () => {
  it("v=0 + full steer/throttle produces zero yaw bonus, zero visual offset, zero forward assist, even with a hot dFast", () => {
    const drift = makeDrift();
    // Spin up a strong drift at speed first, so dFast/heat/energy are all
    // saturated — this is exactly the "drift on the spot" bug scenario: can
    // a car that WAS drifting keep yawing once speed drops to zero?
    run(drift, 240, { speed: 15, steer: 1, throttle: 1 });
    expect(Math.abs(drift.getDFast())).toBeGreaterThan(0.7); // confirm it's genuinely engaged

    // Now speed instantaneously reads 0 (e.g. car slammed into a wall) while
    // steer/throttle are still held — the OUTPUT must reflect current speed
    // immediately, not wait for dFast to decay.
    const out = drift.update(0, 1, true, 1, DT);
    expect(out.yawBonusRadPerSec).toBeCloseTo(0, 6);
    expect(out.visualYawOffsetRad).toBeCloseTo(0, 6);
    expect(out.forwardAssistForce).toBeCloseTo(0, 6);
    expect(out.exitBoostForce).toBeCloseTo(0, 6);
  });

  it("yaw bonus fades continuously (no jump) as speed ramps down through the speed gate", () => {
    const drift = makeDrift();
    run(drift, 240, { speed: 15, steer: 1, throttle: 1 }); // saturate dFast at high speed
    const p = DEFAULT_KART_PHYSICS_PARAMS;
    const speeds: number[] = [];
    // Ramp speed down from well above gateHi to 0 over 1s (60 ticks at DT).
    const steps = 60;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      speeds.push(lerpNum(p.driftSpeedGateHi + 3, 0, t));
    }
    const yawBonuses: number[] = [];
    for (const s of speeds) {
      yawBonuses.push(drift.update(s, 1, true, 1, DT).yawBonusRadPerSec);
    }
    // Monotonically non-increasing overall (speed only drops) and ends at ~0.
    // Small tolerance: dFast itself can still be inching toward saturation
    // during the early part of the ramp (while speedGate is still ~1), which
    // can offset the speed-driven decrease by a tiny fraction — the metric
    // that actually matters (no discrete JUMP) is asserted separately below.
    let prev = Infinity;
    for (const y of yawBonuses) {
      expect(y).toBeLessThanOrEqual(prev + 1e-3);
      prev = y;
    }
    expect(yawBonuses[yawBonuses.length - 1]).toBeCloseTo(0, 3);
    // No discrete jump anywhere in the descent.
    let maxStep = 0;
    for (let i = 1; i < yawBonuses.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(yawBonuses[i - 1] - yawBonuses[i]));
    }
    expect(maxStep).toBeLessThan(0.3);
  });
});

describe("ContinuousDrift v4.0 — req 4: low-speed drift pickup (no ~1s wait)", () => {
  it("full steer+throttle at a low, drift-gate-open speed (~2.5 m/s) engages substantially within a few tenths of a second", () => {
    const drift = makeDrift();
    const p = DEFAULT_KART_PHYSICS_PARAMS;
    const speed = 2.5; // within [driftSpeedGateLo, driftSpeedGateHi] = [1.5, 3] by default
    const outs = run(drift, Math.round(0.35 / DT), { speed, steer: 1, throttle: 1 }); // 0.35s
    expect(outs[outs.length - 1].engageFactor).toBeGreaterThan(0.5);
    // and it actually produces a nonzero yaw bonus at this speed (speedGate is open)
    expect(Math.abs(outs[outs.length - 1].yawBonusRadPerSec)).toBeGreaterThan(0);
    void p;
  });

  it("stays gated near-zero just below driftSpeedGateLo, confirming the pickup above isn't from steer/throttle gates alone", () => {
    const drift = makeDrift();
    const p = DEFAULT_KART_PHYSICS_PARAMS;
    const speed = p.driftSpeedGateLo - 0.3;
    const outs = run(drift, Math.round(0.5 / DT), { speed, steer: 1, throttle: 1 });
    expect(outs[outs.length - 1].engageFactor).toBeLessThan(0.05);
  });
});
