// Regression coverage for owner playtest feedback (2026-07-07): "nose
// partially returns after releasing steer mid-drift, creating a strange
// jerk." Root cause diagnosis (see session report / tools/diagnose_drift_release.ts):
// the PHYSICAL heading (state.yaw in kart.ts) never reverses in this model —
// the swing was entirely in the baseCar-local VISUAL composition
// (ContinuousDrift's visualYawOffsetRad + kart.ts's omega-driven lean), which
// decays back toward 0 as dFast fades on release. This file replicates
// kart.ts's exact per-tick wiring (smoothInput -> ContinuousDrift.update ->
// BicyclePhysics.step -> yaw/visual composition) at the physics-module level
// (no THREE/Kart instantiation needed).
//
// 2026-07-07 follow-up: camera.ts was reworked to follow a velocity/yaw-
// blended heading instead of rigid physical yaw (see camera.ts file header),
// which removed the reason driftVisualOffsetDeg had to stay small (10deg) —
// it's back up to 30deg (types.ts). A big cosmetic offset decaying back
// toward 0 on release is now DESIGN INTENT, so the assertions below no
// longer bound the release SWING's amplitude (that scales with
// driftVisualOffsetDeg by design) — they bound the swing's SMOOTHNESS
// (derivative continuity / no thrashing), which is amplitude-independent and
// is what "strange jerk" actually describes.
import { describe, expect, it } from "vitest";
import { BicyclePhysics } from "./bicyclePhysics";
import { ContinuousDrift } from "./driftContinuous";
import { DEFAULT_AXLE_GEOMETRY, DEFAULT_KART_PHYSICS_PARAMS } from "./types";
import type { KartPhysicsParams, PhysicsInput } from "./types";

const DT = 1 / 60;

function forwardOf(yaw: number) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}
function rightOf(yaw: number) {
  return { x: Math.cos(yaw), z: -Math.sin(yaw) };
}

// Mirrors kart.ts's smoothInput / update / updateSkidAndTelemetry composition
// exactly (steer/throttle slew, ContinuousDrift.update, BicyclePhysics.step,
// yaw += yawDelta + yawBonus*dt, omega-driven lean) but as a free function
// over plain numbers instead of a THREE.Object3D-backed Kart.
function runDriftReleaseScenario(params: KartPhysicsParams, driftHoldTicks: number, releaseTicks: number, steerDuringDrift = 1) {
  const bicycle = new BicyclePhysics(params, DEFAULT_AXLE_GEOMETRY);
  const drift = new ContinuousDrift(params);
  let yaw = 0;
  const vel = { x: 0, y: 0, z: 0 };
  let throttleSm = 0;
  let steerSm = 0;
  let visualDriftAngle = 0;

  function tick(rawSteer: number, rawThrottle: number) {
    const slew = Math.abs(rawSteer) > Math.abs(steerSm) ? params.steerSlewRateIn : params.steerSlewRateOut;
    steerSm += (rawSteer - steerSm) * (1 - Math.exp(-slew * DT));
    throttleSm += (rawThrottle - throttleSm) * (1 - Math.exp(-params.throttleSlewRate * DT));

    const fwdDir = forwardOf(yaw);
    const rightDir = rightOf(yaw);
    const speed = Math.hypot(vel.x, vel.z);
    const out = drift.update(speed, steerSm, true, throttleSm, DT);

    const inp: PhysicsInput = {
      velocity: { ...vel },
      forward: { x: fwdDir.x, y: 0, z: fwdDir.z },
      right: { x: rightDir.x, y: 0, z: rightDir.z },
      throttle: throttleSm,
      steerInput: steerSm,
      brakeHeld: rawThrottle < 0,
      onFloor: true,
      rearGripMultiplier: out.rearGripMultiplier,
      groundSlopeRad: 0,
    };
    const st = bicycle.step(inp, DT);
    yaw += st.yawDelta + out.yawBonusRadPerSec * DT;
    vel.x = st.newVelocity.x;
    vel.z = st.newVelocity.z;

    const omegaNorm = Math.min(Math.max(st.omega / Math.max(params.omegaLeanScale, 0.01), -1), 1);
    const targetLean = ((st.driftIntensity * params.visualDriftMaxDeg * -omegaNorm) * Math.PI) / 180;
    visualDriftAngle += (targetLean - visualDriftAngle) * (1 - Math.exp(-params.visualLeanRecoverySpeed * DT));

    return {
      physicalYawDeg: (yaw * 180) / Math.PI,
      visibleOffsetDeg: ((out.visualYawOffsetRad + visualDriftAngle) * 180) / Math.PI,
    };
  }

  // Accelerate straight 1.5s, then drift, then release.
  let last = { physicalYawDeg: 0, visibleOffsetDeg: 0 };
  for (let i = 0; i < 90; i++) last = tick(0, 1);
  for (let i = 0; i < driftHoldTicks; i++) last = tick(steerDuringDrift, 1);
  const atRelease = last;
  const trace: { physicalYawDeg: number; visibleOffsetDeg: number }[] = [];
  for (let i = 0; i < releaseTicks; i++) trace.push(tick(0, 1));
  return { atRelease, trace };
}

describe("Drift release — nose does not visually 'un-turn' (owner playtest 2026-07-07)", () => {
  it("physical yaw (what the camera follows) never decreases after releasing steer mid-drift", () => {
    const { trace } = runDriftReleaseScenario(DEFAULT_KART_PHYSICS_PARAMS, 60, 90); // 1s drift, 1.5s release
    let prev = -Infinity;
    for (const row of trace) {
      expect(row.physicalYawDeg).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = row.physicalYawDeg;
    }
  });

  // 2026-07-07 REWRITE: the camera no longer follows physical yaw (see
  // camera.ts), so a big driftVisualOffsetDeg (10 -> 30) decaying back
  // toward 0 on release is now DESIGN INTENT, not a bug — the old "swing <
  // 8deg" amplitude bound would fail purely because the offset got bigger by
  // design, without anything actually being wrong. What the owner's original
  // complaint ("nose partially returns... a strange JERK") was really about
  // is smoothness of the release curve, not its total amplitude: a
  // discontinuous derivative (a snap/judder) reads as wrong regardless of
  // how far the offset ultimately travels. These two metrics are amplitude-
  // INVARIANT (same normal range whether driftVisualOffsetDeg is 10, 30, or
  // 45 — verified against all three empirically before picking the bounds
  // below), so they catch a REINTRODUCED discontinuity bug without needing
  // to be re-tuned every time the offset default changes.
  it("combined visible offset (drift visual yaw + omega lean) decays without a derivative discontinuity ('jerk') on release", () => {
    const { atRelease, trace } = runDriftReleaseScenario(DEFAULT_KART_PHYSICS_PARAMS, 60, 60); // 1s drift, 1s release
    const values = [atRelease.visibleOffsetDeg, ...trace.map(t => t.visibleOffsetDeg)];
    const deltas = values.slice(1).map((v, i) => v - values[i]);
    const netChange = Math.abs(values[values.length - 1] - values[0]);
    // maxJerk = biggest frame-to-frame change in the delta itself (discrete
    // second derivative). Normalized by netChange so the bound doesn't need
    // retuning if driftVisualOffsetDeg (or any other tunable feeding this
    // curve) changes the overall scale of the release — a smooth exponential-
    // style decay keeps this ratio roughly constant (~0.04-0.05 measured at
    // driftVisualOffsetDeg=10/30/39); a snap/judder bug (e.g. a binary-target
    // lerp reintroduced per .claude/rules/smooth-values.md #5) spikes it at
    // the exact tick the discontinuity happens.
    const maxJerk = Math.max(...deltas.slice(1).map((d, i) => Math.abs(d - deltas[i])));
    expect(maxJerk / netChange).toBeLessThan(0.15);
  });

  it("combined visible offset does not thrash back and forth on release (bounded total variation vs net change)", () => {
    const { atRelease, trace } = runDriftReleaseScenario(DEFAULT_KART_PHYSICS_PARAMS, 60, 60);
    const values = [atRelease.visibleOffsetDeg, ...trace.map(t => t.visibleOffsetDeg)];
    const deltas = values.slice(1).map((v, i) => v - values[i]);
    const totalVariation = deltas.reduce((sum, d) => sum + Math.abs(d), 0);
    const netChange = Math.abs(values[values.length - 1] - values[0]);
    // totalVariation/netChange == 1 for a perfectly monotonic curve. Real
    // physics has a little wobble (omega settling) even in the non-buggy
    // case — measured ~1.0-1.12 at driftVisualOffsetDeg=10/30/39. A genuine
    // "un-turn then swing back" (non-monotonic return, the other half of the
    // owner's original complaint) would push this well above that.
    expect(totalVariation / netChange).toBeLessThan(1.5);
  });

  it("regression sanity: a hand-crafted single-tick snap (binary-target-lerp discontinuity) IS caught by the jerk metric above", () => {
    // Proves the jerk metric actually has teeth, independent of physics
    // internals: a smooth decay with one artificial discontinuity injected
    // (simulating the smooth-values.md #5 bug class — a target that itself
    // jumps, fed into a lerp) must fail the same bound the real trace passes.
    const smoothDecay = Array.from({ length: 60 }, (_, i) => 20 * Math.exp(-i / 15));
    const withSnap = [...smoothDecay];
    withSnap[30] += 8; // inject a one-tick discontinuity mid-decay
    const deltas = withSnap.slice(1).map((v, i) => v - withSnap[i]);
    const netChange = Math.abs(withSnap[withSnap.length - 1] - withSnap[0]);
    const maxJerk = Math.max(...deltas.slice(1).map((d, i) => Math.abs(d - deltas[i])));
    expect(maxJerk / netChange).toBeGreaterThan(0.15);
  });
});
