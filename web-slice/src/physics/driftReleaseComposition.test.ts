// Regression coverage for owner playtest feedback (2026-07-07): "nose
// partially returns after releasing steer mid-drift, creating a strange
// jerk." Root cause diagnosis (see session report / tools/diagnose_drift_release.ts):
// the PHYSICAL heading (state.yaw in kart.ts, the only thing camera.ts
// follows) never reverses in this model — the swing was entirely in the
// baseCar-local VISUAL composition (ContinuousDrift's visualYawOffsetRad +
// kart.ts's omega-driven lean), which decays back toward 0 as dFast fades on
// release. This file replicates kart.ts's exact per-tick wiring (smoothInput
// -> ContinuousDrift.update -> BicyclePhysics.step -> yaw/visual composition)
// at the physics-module level (no THREE/Kart instantiation needed) so the
// fix (driftVisualOffsetDeg 39 -> 10, see types.ts) has a durable regression
// guard independent of the exact tuned magnitude.
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

  it("combined visible offset (drift visual yaw + omega lean) does not swing back more than a few degrees within 1s of release", () => {
    const { atRelease, trace } = runDriftReleaseScenario(DEFAULT_KART_PHYSICS_PARAMS, 60, 60); // 1s drift, 1s release
    const oneSecondAfter = trace[trace.length - 1];
    const swing = oneSecondAfter.visibleOffsetDeg - atRelease.visibleOffsetDeg;
    // Bound is generous (not "must be exactly 0") — the point is this used to
    // be a ~20-39deg backward swing at the old driftVisualOffsetDeg=39
    // default; a few degrees of residual lean settling is fine, a double-
    // digit un-turn is the regression this guards against.
    expect(Math.abs(swing)).toBeLessThan(8);
  });

  it("regression bound: at the OLD driftVisualOffsetDeg=39 default the swing WOULD have exceeded 8deg (sanity-checks the test itself catches the bug)", () => {
    const oldParams = { ...DEFAULT_KART_PHYSICS_PARAMS, driftVisualOffsetDeg: 39 };
    const { atRelease, trace } = runDriftReleaseScenario(oldParams, 60, 60);
    const oneSecondAfter = trace[trace.length - 1];
    const swing = oneSecondAfter.visibleOffsetDeg - atRelease.visibleOffsetDeg;
    expect(Math.abs(swing)).toBeGreaterThan(8);
  });
});
