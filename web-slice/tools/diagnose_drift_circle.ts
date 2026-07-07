// Diagnostic script (not a test) — reproduces kart.ts's per-tick wiring
// (smoothInput -> ContinuousDrift.update -> BicyclePhysics.step -> yaw/vel
// composition) OUTSIDE three.js, with an INSTRUMENTED copy of
// BicyclePhysics.step() that exposes every longitudinal-force term
// (thrust/drag/rolling/corneringDrag/brake/slopeForce) plus the internal
// driftIntensity/omega/kinematicBlend state each tick. Goal: find and
// numerically characterize the "speed dip 90-180deg into a sustained drift
// circle, then speeds back up" symptom from owner playtest point 5.
//
// The instrumented step is a verbatim transcription of bicyclePhysics.ts's
// step() (steps A-L) — kept in sync manually since the whole point is to see
// intermediate values step() normally throws away. Pure helper functions
// (tanh, computeAxleLateralVelocities, computeSlipRatio) are imported
// directly from the real module instead of re-derived, so at least the tire
// model itself can never drift from the source of truth.
//
// Run: npx tsx tools/diagnose_drift_circle.ts

import { tanh, computeAxleLateralVelocities, computeSlipRatio } from "../src/physics/bicyclePhysics";
import { ContinuousDrift } from "../src/physics/driftContinuous";
import { DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY } from "../src/physics/types";
import type { KartPhysicsParams, PhysicsInput } from "../src/physics/types";

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function smoothstep(lo: number, hi: number, x: number): number {
  if (lo === hi) return x < lo ? 0 : 1;
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}
function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

interface BikeState {
  omega: number;
  driftIntensity: number;
  isDriftingFlag: boolean;
}

interface DebugOut {
  newVelocity: { x: number; y: number; z: number };
  yawDelta: number;
  omega: number;
  fwdSpeed: number;
  sideSpeed: number;
  driftIntensity: number;
  thrust: number;
  drag: number;
  rolling: number;
  corneringDrag: number;
  brake: number;
  slopeForce: number;
  fFront: number;
  fRearTotal: number;
  torque: number;
  steerAngle: number;
  kinematicBlend: number;
  rearGripEff: number;
  slipRatio: number;
}

// Verbatim transcription of BicyclePhysics.step() (see bicyclePhysics.ts),
// mutating `st` in place like the real class's private fields.
function instrumentedStep(
  st: BikeState,
  p: KartPhysicsParams,
  wheelbase: number,
  inp: PhysicsInput,
  delta: number
): DebugOut {
  const fwdDir = inp.forward;
  const sideDir = inp.right;
  let fwdSpeed = inp.velocity.x * fwdDir.x + inp.velocity.z * fwdDir.z;
  let sideSpeed = inp.velocity.x * sideDir.x + inp.velocity.z * sideDir.z;

  const maxAngleRad = degToRad(p.maxSteerAngleDeg);
  const spdRatio = clamp(Math.abs(fwdSpeed) / Math.max(p.maxSpeed, 0.01), 0, 1);
  const steerMult = lerp(p.steerLowSpeedMult, p.steerHighSpeedMult, spdRatio);
  const reverseGate = smoothstep(-1.0, 0.5, fwdSpeed);
  const reverseSteerMult = lerp(p.reverseSteerGain, 1, reverseGate);
  const steerAngle = inp.steerInput * maxAngleRad * steerMult * reverseSteerMult;

  const halfWb = wheelbase * 0.5;
  const { front: vLatFront, rear: vLatRear } = computeAxleLateralVelocities(sideSpeed, st.omega, halfWb);

  const vWheelLatFront = vLatFront * Math.cos(steerAngle) + fwdSpeed * Math.sin(steerAngle);

  const sat = Math.max(p.tireSaturationSpeed, 0.1);
  const rearGripEff = p.rearGripStiffness * Math.max(inp.rearGripMultiplier, 0);
  const fFront = -p.frontGripStiffness * tanh(vWheelLatFront / sat) * sat;
  const fRearPerWheel = -rearGripEff * tanh(vLatRear / sat) * sat;
  const fRearTotal = 2 * fRearPerWheel;

  const torque = (fRearTotal - fFront) * halfWb;
  const moi = p.mass * (halfWb * halfWb) * Math.max(p.inertiaScale, 0.01);
  const omegaAccel = torque / Math.max(moi, 0.001);
  let omegaDynamic = st.omega + omegaAccel * delta;
  omegaDynamic *= Math.exp(-p.omegaDamping * delta);

  const kinematicOmega = (fwdSpeed / wheelbase) * Math.tan(steerAngle);
  const kinematicBlend = smoothstep(p.kinematicBlendLoSpeed, p.kinematicBlendHiSpeed, Math.abs(fwdSpeed));
  st.omega = lerp(kinematicOmega, omegaDynamic, kinematicBlend);

  const lateralMute = lerp(p.kinematicLateralMute, 1, kinematicBlend);
  const fTotalLat = fFront + fRearTotal;
  sideSpeed += ((fTotalLat * lateralMute) / Math.max(p.mass, 0.001)) * delta;

  let thrust = 0;
  if (inp.throttle > 0.01) {
    thrust = inp.throttle * p.accelForce;
  } else if (inp.throttle < -0.01) {
    const reverseEngageGate = smoothstep(p.reverseEngageSpeed, 0, fwdSpeed);
    thrust = inp.throttle * p.accelForce * p.reverseRatio * reverseEngageGate;
  }

  // Fix 1 sync (see bicyclePhysics.ts step I comment): these three terms now
  // read inp.driftPenaltyFactor (the caller's slow "heat" signal) instead of
  // st.driftIntensity (fast, measured-slip-derived).
  const penalty = clamp(inp.driftPenaltyFactor, 0, 1);
  const dragMult = lerp(1, p.driftDragMultiplier, penalty);
  const rollingMult = lerp(1, p.driftRollingMultiplier, penalty);
  const drag = -Math.sign(fwdSpeed) * p.kDrag * dragMult * fwdSpeed * fwdSpeed;
  const rolling = -p.kRolling * rollingMult * fwdSpeed;

  let corneringDrag = 0;
  if (p.corneringDragCoeff > 0) {
    const cdBlend = smoothstep(0, 0.2, Math.abs(fwdSpeed));
    const cdDriftScale = lerp(1, p.corneringDragDriftMult, penalty);
    corneringDrag = -Math.sign(fwdSpeed) * p.corneringDragCoeff * cdDriftScale * Math.abs(sideSpeed) * 0.5 * cdBlend;
  }

  let brake = 0;
  if (inp.brakeHeld) {
    const brakeBlend = smoothstep(0, 0.6, fwdSpeed);
    brake = -p.brakeForce * brakeBlend;
  }

  const slopeForce = -p.slopeGravityAccel * Math.sin(inp.groundSlopeRad);

  fwdSpeed += (thrust + drag + rolling + corneringDrag + brake + slopeForce) * delta;
  if (Math.abs(thrust) < 0.01 && Math.abs(slopeForce) < 0.01 && Math.abs(fwdSpeed) < 0.1) {
    fwdSpeed = 0;
  }

  const rearSlipMag = Math.abs(vLatRear);
  const slipRatio = computeSlipRatio(rearSlipMag, p.driftMaxSlipSpeed);

  let targetIntensity = 0;
  if (Math.abs(fwdSpeed) >= p.driftMinSpeed) targetIntensity = slipRatio;
  const alpha = 1 - Math.exp(-p.slipSmoothing * delta);
  st.driftIntensity = clamp(lerp(st.driftIntensity, targetIntensity, alpha), 0, 1);

  const hystHigh = p.driftActiveThreshold + 0.02;
  const hystLow = p.driftActiveThreshold - 0.02;
  if (st.isDriftingFlag) {
    if (st.driftIntensity < hystLow) st.isDriftingFlag = false;
  } else {
    if (st.driftIntensity > hystHigh) st.isDriftingFlag = true;
  }

  const newVelocity = {
    x: fwdDir.x * fwdSpeed + sideDir.x * sideSpeed,
    y: inp.velocity.y,
    z: fwdDir.z * fwdSpeed + sideDir.z * sideSpeed,
  };

  return {
    newVelocity,
    yawDelta: st.omega * delta,
    omega: st.omega,
    fwdSpeed,
    sideSpeed,
    driftIntensity: st.driftIntensity,
    thrust,
    drag,
    rolling,
    corneringDrag,
    brake,
    slopeForce,
    fFront,
    fRearTotal,
    torque,
    steerAngle,
    kinematicBlend,
    rearGripEff,
    slipRatio,
  };
}

// ─── Simulation harness (mirrors kart.ts wiring exactly) ────────────────────

const params = { ...DEFAULT_KART_PHYSICS_PARAMS };
const wheelbase = DEFAULT_AXLE_GEOMETRY.wheelbase;
const drift = new ContinuousDrift(params);
const bikeState: BikeState = { omega: 0, driftIntensity: 0, isDriftingFlag: false };

const DT = 1 / 120; // matches src/main.ts PHYS_STEP
let yaw = 0;
const vel = { x: 0, y: 0, z: 0 };
let throttleSm = 0;
let steerSm = 0;
// Slow low-pass of bikeState.driftIntensity, mirrors kart.ts's driftPenaltySlow.
let driftPenaltySlow = 0;

function forwardOf(y: number) {
  return { x: -Math.sin(y), z: -Math.cos(y) };
}
function rightOf(y: number) {
  return { x: Math.cos(y), z: -Math.sin(y) };
}
function smoothInput(rawSteer: number, rawThrottle: number) {
  const slew = Math.abs(rawSteer) > Math.abs(steerSm) ? params.steerSlewRateIn : params.steerSlewRateOut;
  const steerAlpha = 1 - Math.exp(-slew * DT);
  steerSm += (rawSteer - steerSm) * steerAlpha;
  const thrAlpha = 1 - Math.exp(-params.throttleSlewRate * DT);
  throttleSm += (rawThrottle - throttleSm) * thrAlpha;
}

interface Row {
  t: number;
  phase: string;
  angleSinceDriftStart: number; // deg, unwrapped cumulative
  fwdSpeed: number;
  speedXZ: number;
  driftIntensity: number; // bicycle-internal (state.driftIntensity)
  dFast: number;
  engageFactor: number;
  heat: number;
  energy: number;
  rearGripMult: number;
  thrust: number;
  drag: number;
  rolling: number;
  corneringDrag: number;
  brake: number;
  slopeForce: number;
  omegaDegPerSec: number;
}
const rows: Row[] = [];

let driftStartYaw = 0;
let driftStarted = false;

function tick(t: number, phase: string, rawSteer: number, rawThrottle: number) {
  smoothInput(rawSteer, rawThrottle);
  const fwdDir = forwardOf(yaw);
  const rightDir = rightOf(yaw);
  const speed = Math.hypot(vel.x, vel.z);
  const fwdSigned = vel.x * fwdDir.x + vel.z * fwdDir.z;

  const out = drift.update(speed, steerSm, true, throttleSm, DT);

  // Slow low-pass of driftIntensity itself (see kart.ts step 4a2 / types.ts
  // PhysicsInput.driftPenaltyFactor doc comment) — one-tick lag, reads
  // bikeState.driftIntensity BEFORE this tick's instrumentedStep() call.
  const penaltyAlpha = 1 - Math.exp(-(1 / Math.max(params.driftPenaltyTau, 0.05)) * DT);
  driftPenaltySlow += (bikeState.driftIntensity - driftPenaltySlow) * penaltyAlpha;

  const inp: PhysicsInput = {
    velocity: { ...vel },
    forward: { x: fwdDir.x, y: 0, z: fwdDir.z },
    right: { x: rightDir.x, y: 0, z: rightDir.z },
    throttle: throttleSm,
    steerInput: steerSm,
    brakeHeld: rawThrottle < 0,
    onFloor: true,
    rearGripMultiplier: out.rearGripMultiplier,
    driftPenaltyFactor: driftPenaltySlow,
    groundSlopeRad: 0,
  };
  const st = instrumentedStep(bikeState, params, wheelbase, inp, DT);
  yaw += st.yawDelta + out.yawBonusRadPerSec * DT;
  vel.x = st.newVelocity.x;
  vel.z = st.newVelocity.z;

  const assist = out.forwardAssistForce + out.exitBoostForce;
  if (Math.abs(assist) > 0 && fwdSigned >= 0) {
    const fwdAfter = forwardOf(yaw);
    vel.x += fwdAfter.x * assist * DT;
    vel.z += fwdAfter.z * assist * DT;
  }

  if (phase === "drift" && !driftStarted) {
    driftStarted = true;
    driftStartYaw = yaw;
  }
  const angleSinceDriftStart = driftStarted ? ((yaw - driftStartYaw) * 180) / Math.PI : 0;

  rows.push({
    t,
    phase,
    angleSinceDriftStart,
    fwdSpeed: st.fwdSpeed,
    speedXZ: Math.hypot(vel.x, vel.z),
    driftIntensity: st.driftIntensity,
    dFast: drift.getDFast(),
    engageFactor: out.engageFactor,
    heat: drift.getHeat(),
    energy: drift.getEnergy(),
    rearGripMult: out.rearGripMultiplier,
    thrust: st.thrust,
    drag: st.drag,
    rolling: st.rolling,
    corneringDrag: st.corneringDrag,
    brake: st.brake,
    slopeForce: st.slopeForce,
    omegaDegPerSec: (st.omega * 180) / Math.PI,
  });
}

let t = 0;
// Phase 1: accelerate straight to cruise speed (3.5s, well past terminal
// velocity settling — see diagnose_longitudinal.ts terminal-speed numbers).
for (let i = 0; i < Math.round(3.5 * 120); i++) {
  tick(t, "accel", 0, 1);
  t += DT;
}
// Phase 2: full steer + full throttle held for 12s — several drift circles.
for (let i = 0; i < Math.round(12 * 120); i++) {
  tick(t, "drift", 1, 1);
  t += DT;
}

// ─── Analysis ────────────────────────────────────────────────────────────────

const driftRows = rows.filter((r) => r.phase === "drift");

console.log("=== Dense log: first 3s of drift phase (every 4th tick, ~30/s) ===");
for (let i = 0; i < driftRows.length && driftRows[i].t - driftRows[0].t <= 3.0; i += 4) {
  const r = driftRows[i];
  console.log(
    `t+${(r.t - driftRows[0].t).toFixed(3)}s ang=${r.angleSinceDriftStart.toFixed(1)}deg ` +
    `fwdSpd=${r.fwdSpeed.toFixed(3)} |v|=${r.speedXZ.toFixed(3)} ` +
    `driftInt=${r.driftIntensity.toFixed(3)} dFast=${r.dFast.toFixed(3)} rearGrip=${r.rearGripMult.toFixed(3)} ` +
    `thrust=${r.thrust.toFixed(2)} drag=${r.drag.toFixed(2)} roll=${r.rolling.toFixed(2)} cdrag=${r.corneringDrag.toFixed(2)} ` +
    `omega=${r.omegaDegPerSec.toFixed(1)}deg/s`
  );
}

// Find the dip within the first 400deg of turning: local min of fwdSpeed
// after the initial peak (right at drift entry, throttle/steer just slammed
// to full, speed is still near cruise).
const startSpeed = driftRows[0].fwdSpeed;
let dipIdx = -1;
let dipSpeed = Infinity;
for (const r of driftRows) {
  if (r.angleSinceDriftStart > 400) break;
  if (r.fwdSpeed < dipSpeed) {
    dipSpeed = r.fwdSpeed;
    dipIdx = driftRows.indexOf(r);
  }
}
const dipRow = driftRows[dipIdx];

// Recovery: first tick after the dip where fwdSpeed gets back within 2% of
// the eventual steady-state mean (computed below) OR peaks again.
const steadyWindow = driftRows.filter((r) => r.t - driftRows[0].t >= 8.0); // last 4s of the 12s hold
const steadyMean = steadyWindow.reduce((s, r) => s + r.fwdSpeed, 0) / steadyWindow.length;
const steadyMin = Math.min(...steadyWindow.map((r) => r.fwdSpeed));
const steadyMax = Math.max(...steadyWindow.map((r) => r.fwdSpeed));

let recoverIdx = -1;
for (let i = dipIdx; i < driftRows.length; i++) {
  if (driftRows[i].fwdSpeed >= steadyMean * 0.98) {
    recoverIdx = i;
    break;
  }
}
const recoverRow = recoverIdx >= 0 ? driftRows[recoverIdx] : null;

// Oscillation period on the steady window: find zero-crossings of
// (fwdSpeed - steadyMean).
const crossings: number[] = [];
for (let i = 1; i < steadyWindow.length; i++) {
  const a = steadyWindow[i - 1].fwdSpeed - steadyMean;
  const b = steadyWindow[i].fwdSpeed - steadyMean;
  if (a < 0 !== b < 0) crossings.push(steadyWindow[i].t);
}
let periodEstimate = -1;
if (crossings.length >= 2) {
  // Each full oscillation = 2 zero-crossings.
  const span = crossings[crossings.length - 1] - crossings[0];
  const halfPeriods = crossings.length - 1;
  periodEstimate = (span / halfPeriods) * 2;
}

// Attribute cause at the dip moment: compare each longitudinal term's
// magnitude vs its steady-state value.
const steadyTermsMean = {
  drag: steadyWindow.reduce((s, r) => s + r.drag, 0) / steadyWindow.length,
  rolling: steadyWindow.reduce((s, r) => s + r.rolling, 0) / steadyWindow.length,
  corneringDrag: steadyWindow.reduce((s, r) => s + r.corneringDrag, 0) / steadyWindow.length,
};

console.log("\n=== SUMMARY: drift circle speed dip ===");
console.log(`fwdSpeed at drift-entry (t=0 of phase 2): ${startSpeed.toFixed(3)} m/s`);
console.log(
  `DIP: fwdSpeed=${dipRow.fwdSpeed.toFixed(3)} m/s at angle=${dipRow.angleSinceDriftStart.toFixed(1)}deg, ` +
  `t+${(dipRow.t - driftRows[0].t).toFixed(3)}s into drift phase`
);
console.log(`  dip depth vs entry speed: ${(startSpeed - dipRow.fwdSpeed).toFixed(3)} m/s`);
console.log(`  dip depth vs eventual steady mean: ${(steadyMean - dipRow.fwdSpeed).toFixed(3)} m/s`);
console.log(
  `  at dip: driftIntensity=${dipRow.driftIntensity.toFixed(3)} dFast=${dipRow.dFast.toFixed(3)} ` +
  `rearGrip=${dipRow.rearGripMult.toFixed(3)}`
);
console.log(
  `  at dip: drag=${dipRow.drag.toFixed(2)} rolling=${dipRow.rolling.toFixed(2)} corneringDrag=${dipRow.corneringDrag.toFixed(2)} thrust=${dipRow.thrust.toFixed(2)}`
);
console.log(
  `  steady-state mean terms: drag=${steadyTermsMean.drag.toFixed(2)} rolling=${steadyTermsMean.rolling.toFixed(2)} corneringDrag=${steadyTermsMean.corneringDrag.toFixed(2)}`
);
if (recoverRow) {
  console.log(
    `RECOVERY: back to 98% of steady mean at angle=${recoverRow.angleSinceDriftStart.toFixed(1)}deg, ` +
    `t+${(recoverRow.t - driftRows[0].t).toFixed(3)}s (duration since dip: ${(recoverRow.t - dipRow.t).toFixed(3)}s, ` +
    `${(recoverRow.angleSinceDriftStart - dipRow.angleSinceDriftStart).toFixed(1)}deg of extra turning)`
  );
} else {
  console.log("RECOVERY: never reached 98% of steady mean within the simulated window.");
}

console.log(`\n=== SUMMARY: steady-state circle (last 4s of 12s hold) ===`);
console.log(`mean fwdSpeed=${steadyMean.toFixed(3)} m/s, min=${steadyMin.toFixed(3)}, max=${steadyMax.toFixed(3)}, amplitude=${((steadyMax - steadyMin) / 2).toFixed(3)} m/s`);
console.log(`oscillation period estimate: ${periodEstimate < 0 ? "no clear oscillation detected (monotonic/settled)" : periodEstimate.toFixed(3) + "s"}`);
const meanOmega = steadyWindow.reduce((s, r) => s + r.omegaDegPerSec, 0) / steadyWindow.length;
console.log(`mean omega (steady): ${meanOmega.toFixed(2)} deg/s -> full 360deg circle takes ${(360 / Math.abs(meanOmega)).toFixed(3)}s`);

// Which term's steady-state deviation best explains the dip: compare
// dip-vs-steady delta for each term (bigger |delta| = bigger contributor).
const dragDelta = dipRow.drag - steadyTermsMean.drag;
const rollingDelta = dipRow.rolling - steadyTermsMean.rolling;
const cdragDelta = dipRow.corneringDrag - steadyTermsMean.corneringDrag;
console.log(`\n=== Term deltas at dip vs steady-state (negative = extra braking force at the dip) ===`);
console.log(`drag delta: ${dragDelta.toFixed(3)} N-equiv`);
console.log(`rolling delta: ${rollingDelta.toFixed(3)} N-equiv`);
console.log(`corneringDrag delta: ${cdragDelta.toFixed(3)} N-equiv`);
const biggest = [
  { name: "drag", v: Math.abs(dragDelta) },
  { name: "rolling", v: Math.abs(rollingDelta) },
  { name: "corneringDrag", v: Math.abs(cdragDelta) },
].sort((a, b) => b.v - a.v)[0];
console.log(`Biggest single-term contributor to the dip: ${biggest.name}`);
