// Diagnostic script (not a test) — reproduces kart.ts's per-tick wiring
// (smoothInput → ContinuousDrift.update → BicyclePhysics.step → yaw/visual
// composition) OUTSIDE three.js/THREE.Object3D, to isolate exactly which
// term is responsible for the "nose partially returns after releasing
// steer mid-drift" symptom reported by the owner.
//
// Run: npx tsx tools/diagnose_drift_release.ts
//
// Scenario: accelerate straight 2s -> hold full steer+throttle (drift) 2s
// -> release steer, keep throttle, coast 1.5s. Logs, every tick:
//   physicalYawDeg   — state.yaw (group rotation; what the CAMERA follows)
//   visualOffsetDeg  — driftVisualYaw only (baseCar rotation.y drift term)
//   leanDeg          — visualDriftAngle only (baseCar rotation.y lean term)
//   visibleNoseDeg   — physicalYawDeg + visualOffsetDeg + leanDeg (what the
//                      PLAYER actually sees as the kart's nose direction)
//   dFast, omega
//
// The "nose returns" symptom = visibleNoseDeg decreasing after release even
// though physicalYawDeg is flat/still-increasing. This isolates whether
// that's candidate (a) visual-offset decay, (b) kinematic omega collapse,
// or (c) physical counter-yaw from grip recovery.

import { BicyclePhysics } from "../src/physics/bicyclePhysics";
import { ContinuousDrift } from "../src/physics/driftContinuous";
import { DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY } from "../src/physics/types";
import type { PhysicsInput } from "../src/physics/types";

const params = { ...DEFAULT_KART_PHYSICS_PARAMS };
const bicycle = new BicyclePhysics(params, DEFAULT_AXLE_GEOMETRY);
const drift = new ContinuousDrift(params);

const dt = 1 / 60;
let yaw = 0;
const vel = { x: 0, y: 0, z: 0 };
let throttleSm = 0;
let steerSm = 0;
let visualDriftAngle = 0;

function forwardOf(y: number) {
  return { x: -Math.sin(y), z: -Math.cos(y) };
}
function rightOf(y: number) {
  return { x: Math.cos(y), z: -Math.sin(y) };
}
function smoothInput(rawSteer: number, rawThrottle: number) {
  const slew = Math.abs(rawSteer) > Math.abs(steerSm) ? params.steerSlewRateIn : params.steerSlewRateOut;
  const steerAlpha = 1 - Math.exp(-slew * dt);
  steerSm += (rawSteer - steerSm) * steerAlpha;
  const thrAlpha = 1 - Math.exp(-params.throttleSlewRate * dt);
  throttleSm += (rawThrottle - throttleSm) * thrAlpha;
}

interface Row {
  t: number;
  phase: string;
  physicalYawDeg: number;
  visualOffsetDeg: number;
  leanDeg: number;
  visibleNoseDeg: number;
  dFast: number;
  omega: number;
  fwdSpeed: number;
}
const rows: Row[] = [];

function tick(t: number, phase: string, rawSteer: number, rawThrottle: number) {
  smoothInput(rawSteer, rawThrottle);
  const fwdDir = forwardOf(yaw);
  const rightDir = rightOf(yaw);
  const speed = Math.hypot(vel.x, vel.z);
  const out = drift.update(speed, steerSm, true, throttleSm, dt);
  const driftVisualYaw = out.visualYawOffsetRad;

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
  const st = bicycle.step(inp, dt);
  yaw += st.yawDelta + out.yawBonusRadPerSec * dt;
  vel.x = st.newVelocity.x;
  vel.z = st.newVelocity.z;
  const fwdSigned = vel.x * fwdDir.x + vel.z * fwdDir.z; // approx pre-rotation fwd speed
  const assist = out.forwardAssistForce + out.exitBoostForce;
  if (Math.abs(assist) > 0 && fwdSigned >= 0) {
    const fwdAfter = forwardOf(yaw);
    vel.x += fwdAfter.x * assist * dt;
    vel.z += fwdAfter.z * assist * dt;
  }

  const omegaNorm = Math.min(Math.max(st.omega / Math.max(params.omegaLeanScale, 0.01), -1), 1);
  const targetLean = (st.driftIntensity * params.visualDriftMaxDeg * -omegaNorm) * Math.PI / 180;
  const leanAlpha = 1 - Math.exp(-params.visualLeanRecoverySpeed * dt);
  visualDriftAngle += (targetLean - visualDriftAngle) * leanAlpha;

  const physicalYawDeg = (yaw * 180) / Math.PI;
  const visualOffsetDeg = (driftVisualYaw * 180) / Math.PI;
  const leanDeg = (visualDriftAngle * 180) / Math.PI;
  rows.push({
    t,
    phase,
    physicalYawDeg,
    visualOffsetDeg,
    leanDeg,
    visibleNoseDeg: physicalYawDeg + visualOffsetDeg + leanDeg,
    dFast: drift.getDFast(),
    omega: st.omega,
    fwdSpeed: st.fwdSpeed,
  });
}

let t = 0;
// Phase 1: accelerate straight 2s.
for (let i = 0; i < 120; i++) { tick(t, "accel", 0, 1); t += dt; }
// Phase 2: full steer + throttle (drift) 2s.
for (let i = 0; i < 120; i++) { tick(t, "drift", 1, 1); t += dt; }
// Phase 3: release steer, keep throttle, 1.5s.
for (let i = 0; i < 90; i++) { tick(t, "release", 0, 1); t += dt; }

// Print every 5th row (12/s) plus every row for the first 0.5s after release
// (the critical window).
const releaseStartIdx = 240;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const sinceRelease = i - releaseStartIdx;
  const dense = sinceRelease >= 0 && sinceRelease <= 40;
  if (i % 5 === 0 || dense) {
    console.log(
      `t=${r.t.toFixed(2)} [${r.phase.padEnd(7)}] yaw=${r.physicalYawDeg.toFixed(2)}deg ` +
      `visOff=${r.visualOffsetDeg.toFixed(2)}deg lean=${r.leanDeg.toFixed(2)}deg ` +
      `NOSE=${r.visibleNoseDeg.toFixed(2)}deg dFast=${r.dFast.toFixed(3)} omega=${r.omega.toFixed(2)} spd=${r.fwdSpeed.toFixed(2)}`
    );
  }
}

// Summary: peak nose during drift vs nose 1.0s after release.
const peakDuringDrift = Math.max(...rows.slice(120, 240).map((r) => r.visibleNoseDeg));
const noseAtRelease = rows[releaseStartIdx].visibleNoseDeg;
const noseAt1s = rows[Math.min(releaseStartIdx + 60, rows.length - 1)].visibleNoseDeg;
const physYawAtRelease = rows[releaseStartIdx].physicalYawDeg;
const physYawAt1s = rows[Math.min(releaseStartIdx + 60, rows.length - 1)].physicalYawDeg;
console.log("\n--- SUMMARY ---");
console.log(`nose at release moment: ${noseAtRelease.toFixed(2)}deg`);
console.log(`nose 1.0s after release: ${noseAt1s.toFixed(2)}deg  (delta=${(noseAt1s - noseAtRelease).toFixed(2)}deg)`);
console.log(`physical yaw at release: ${physYawAtRelease.toFixed(2)}deg`);
console.log(`physical yaw 1.0s after release: ${physYawAt1s.toFixed(2)}deg  (delta=${(physYawAt1s - physYawAtRelease).toFixed(2)}deg)`);
console.log(`visualOffset at release: ${rows[releaseStartIdx].visualOffsetDeg.toFixed(2)}deg -> at +1s: ${rows[Math.min(releaseStartIdx+60,rows.length-1)].visualOffsetDeg.toFixed(2)}deg`);
console.log(`lean at release: ${rows[releaseStartIdx].leanDeg.toFixed(2)}deg -> at +1s: ${rows[Math.min(releaseStartIdx+60,rows.length-1)].leanDeg.toFixed(2)}deg`);
