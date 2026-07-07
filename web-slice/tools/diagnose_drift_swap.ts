// Diagnostic script (not a test) — reproduces kart.ts's EXACT per-tick wiring
// (smoothInput -> ContinuousDrift.update -> BicyclePhysics.step -> yaw/vel
// composition -> visual lean/yaw composition from updateSkidAndTelemetry +
// syncVisual) using the REAL production classes (BicyclePhysics,
// ContinuousDrift) — no re-transcribed formulas, so this can't silently drift
// from the source of truth the way an instrumented copy could.
//
// Goal (owner playtest 2.2): measure the S-transition (drift right -> drift
// left, throttle held) numerically against the ~0.6-0.8s full-body-reversal
// target read off the original SmashKarts.io video analysis, and identify
// which signal the player perceives as "instant" (no inertia).
//
// Run: npx tsx tools/diagnose_drift_swap.ts

import { BicyclePhysics } from "../src/physics/bicyclePhysics";
import { ContinuousDrift } from "../src/physics/driftContinuous";
import { DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY } from "../src/physics/types";
import type { PhysicsInput } from "../src/physics/types";

const params = { ...DEFAULT_KART_PHYSICS_PARAMS };
const wheelbase = DEFAULT_AXLE_GEOMETRY.wheelbase;
const bicycle = new BicyclePhysics(params, DEFAULT_AXLE_GEOMETRY);
const drift = new ContinuousDrift(params);

const DT = 1 / 120; // matches src/main.ts PHYS_STEP

let yaw = 0;
const vel = { x: 0, y: 0, z: 0 };
let throttleSm = 0;
let steerSm = 0;
let driftPenaltySlow = 0;
// Visual state — mirrors kart.ts's visualDriftAngle (smoothed omega-lean)
// and driftVisualYaw (single-stage, direct from ContinuousDrift output).
let visualDriftAngle = 0;
let driftVisualYaw = 0;

function forwardOf(y: number) {
  return { x: -Math.sin(y), z: -Math.cos(y) };
}
function rightOf(y: number) {
  return { x: Math.cos(y), z: -Math.sin(y) };
}

function smoothInput(rawSteer: number, rawThrottle: number): void {
  const slew = Math.abs(rawSteer) > Math.abs(steerSm) ? params.steerSlewRateIn : params.steerSlewRateOut;
  const steerAlpha = 1 - Math.exp(-slew * DT);
  steerSm += (rawSteer - steerSm) * steerAlpha;
  if (Math.abs(steerSm) < 0.01 && Math.abs(rawSteer) < 0.01) steerSm = 0;
  const thrAlpha = 1 - Math.exp(-params.throttleSlewRate * DT);
  throttleSm += (rawThrottle - throttleSm) * thrAlpha;
}

interface Row {
  t: number;
  phase: string;
  steerSm: number;
  fwdSpeed: number;
  speedXZ: number;
  sideSpeed: number;
  omegaDegPerSec: number;
  dFast: number;
  engageFactor: number;
  visualYawOffsetDeg: number; // drift.visualYawOffsetRad, direct
  visualDriftAngleDeg: number; // omega-lean, smoothed
  totalVisualYawDeg: number; // what syncVisual() actually applies to baseCar.rotation.y
  driftIntensity: number;
}
const rows: Row[] = [];

// Mirrors kart.ts update() step 4-7 + updateSkidAndTelemetry's visual-lean
// block + syncVisual's baseCar.rotation.y composition — verbatim wiring,
// just flattened into one function since this diagnostic has no three.js
// scene graph to sync into.
function tick(t: number, phase: string, rawSteer: number, rawThrottle: number): void {
  smoothInput(rawSteer, rawThrottle);

  const fwdDir = forwardOf(yaw);
  const rightDir = rightOf(yaw);
  const speed = Math.hypot(vel.x, vel.z);

  const driftOut = drift.update(speed, steerSm, true, throttleSm, DT);
  driftVisualYaw = driftOut.visualYawOffsetRad;

  const penaltyAlpha = 1 - Math.exp(-(1 / Math.max(params.driftPenaltyTau, 0.05)) * DT);
  driftPenaltySlow += (bicycle.getDriftIntensity() - driftPenaltySlow) * penaltyAlpha;

  const inp: PhysicsInput = {
    velocity: { ...vel },
    forward: { x: fwdDir.x, y: 0, z: fwdDir.z },
    right: { x: rightDir.x, y: 0, z: rightDir.z },
    throttle: throttleSm,
    steerInput: steerSm,
    brakeHeld: rawThrottle < 0,
    onFloor: true,
    rearGripMultiplier: driftOut.rearGripMultiplier,
    driftPenaltyFactor: driftPenaltySlow,
    groundSlopeRad: 0,
  };
  const out = bicycle.step(inp, DT);

  yaw += out.yawDelta + driftOut.yawBonusRadPerSec * DT;
  vel.x = out.newVelocity.x;
  vel.z = out.newVelocity.z;

  const fwdSigned = vel.x * fwdDir.x + vel.z * fwdDir.z; // pre-rotation forward, matches kart.ts's fwdSigned capture point
  const assist = driftOut.forwardAssistForce + driftOut.exitBoostForce;
  if (Math.abs(assist) > 0 && fwdSigned >= 0) {
    const fwdAfter = forwardOf(yaw);
    vel.x += fwdAfter.x * assist * DT;
    vel.z += fwdAfter.z * assist * DT;
  }

  // updateSkidAndTelemetry's visual-lean block (kart.ts lines ~436-440).
  const omegaNorm = Math.min(Math.max(out.omega / Math.max(params.omegaLeanScale, 0.01), -1), 1);
  const targetLean = ((out.driftIntensity * params.visualDriftMaxDeg * -omegaNorm) * Math.PI) / 180;
  const leanAlpha = 1 - Math.exp(-params.visualLeanRecoverySpeed * DT);
  visualDriftAngle += (targetLean - visualDriftAngle) * leanAlpha;

  const totalVisualYaw = visualDriftAngle + driftVisualYaw; // syncVisual()'s baseCar.rotation.y

  rows.push({
    t,
    phase,
    steerSm,
    fwdSpeed: out.fwdSpeed,
    speedXZ: Math.hypot(vel.x, vel.z),
    sideSpeed: out.sideSpeed,
    omegaDegPerSec: (out.omega * 180) / Math.PI,
    dFast: drift.getDFast(),
    engageFactor: driftOut.engageFactor,
    visualYawOffsetDeg: (driftVisualYaw * 180) / Math.PI,
    visualDriftAngleDeg: (visualDriftAngle * 180) / Math.PI,
    totalVisualYawDeg: (totalVisualYaw * 180) / Math.PI,
    driftIntensity: out.driftIntensity,
  });
}

// ─── Simulation ───────────────────────────────────────────────────────────
let t = 0;
// Phase 1: straight accel to cruise (3.5s — well past terminal velocity).
for (let i = 0; i < Math.round(3.5 * 120); i++) {
  tick(t, "accel", 0, 1);
  t += DT;
}
// Phase 2: drift RIGHT (steer=+1), held long enough to reach a settled
// circle (4s — diagnose_drift_circle.ts shows the entry transient settles
// well within ~2s at these params).
for (let i = 0; i < Math.round(4.0 * 120); i++) {
  tick(t, "drift_right", 1, 1);
  t += DT;
}

const swapIdx = rows.length; // index of the FIRST tick with the new (left) raw steer
const swapT = t;

// Phase 3: raw steer flips instantly +1 -> -1, throttle held at 1. Run 3s —
// comfortably past even a slow ~1s-class transition, with room to see the
// new steady-state circle settle.
for (let i = 0; i < Math.round(3.0 * 120); i++) {
  tick(t, "drift_left", -1, 1);
  t += DT;
}

// ─── Steady-state references ───────────────────────────────────────────────
// Pre-swap steady state: last 0.5s before the swap (drift_right phase is
// 4s long, well past the entry transient — see phase 2 comment above).
const preWindow = rows.slice(swapIdx - Math.round(0.5 * 120), swapIdx);
function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
const ss1 = {
  omega: mean(preWindow.map((r) => r.omegaDegPerSec)),
  sideSpeed: mean(preWindow.map((r) => r.sideSpeed)),
  visualYaw: mean(preWindow.map((r) => r.totalVisualYawDeg)),
  speed: mean(preWindow.map((r) => r.speedXZ)),
};

// Post-swap steady state: last 0.5s of the whole 3s left-drift window
// (i.e. it has 2.5s to settle before this window starts).
const postWindow = rows.slice(rows.length - Math.round(0.5 * 120));
const ss2 = {
  omega: mean(postWindow.map((r) => r.omegaDegPerSec)),
  sideSpeed: mean(postWindow.map((r) => r.sideSpeed)),
  visualYaw: mean(postWindow.map((r) => r.totalVisualYawDeg)),
  speed: mean(postWindow.map((r) => r.speedXZ)),
};

console.log("=== Steady-state references ===");
console.log(
  `PRE  (drift right, last 0.5s before swap):  omega=${ss1.omega.toFixed(1)}deg/s  sideSpeed=${ss1.sideSpeed.toFixed(3)}  ` +
  `visualYaw=${ss1.visualYaw.toFixed(1)}deg  |v|=${ss1.speed.toFixed(3)}`
);
console.log(
  `POST (drift left, last 0.5s of sim):        omega=${ss2.omega.toFixed(1)}deg/s  sideSpeed=${ss2.sideSpeed.toFixed(3)}  ` +
  `visualYaw=${ss2.visualYaw.toFixed(1)}deg  |v|=${ss2.speed.toFixed(3)}`
);

// ─── Transition window (from swap onward) ──────────────────────────────────
const post = rows.slice(swapIdx);

function firstTimeSteerCrosses(target: number): number | null {
  // steerSm goes from +1 toward -0.9 — first tick where it's AT OR BELOW target.
  for (const r of post) {
    if (r.steerSm <= target) return r.t - swapT;
  }
  return null;
}

function firstTimeReaches90pct(
  getVal: (r: Row) => number,
  ssTarget: number
): number | null {
  // Generic: first tick where the signal has reached 90% of the way from its
  // PRE value toward ssTarget, matching ssTarget's SIGN (handles the sign
  // flip through zero cleanly regardless of which side we start on).
  const threshold = 0.9 * ssTarget;
  for (const r of post) {
    const v = getVal(r);
    if (Math.sign(ssTarget) >= 0 ? v >= threshold : v <= threshold) return r.t - swapT;
  }
  return null;
}

function firstZeroCrossing(getVal: (r: Row) => number, startSign: number): number | null {
  for (const r of post) {
    const v = getVal(r);
    if (startSign > 0 ? v <= 0 : v >= 0) return r.t - swapT;
  }
  return null;
}

// TRUE settling time: the "first time reaches 90%" metric above triggers on
// the FIRST crossing into the target band, which is wrong for a signal that
// overshoots past its new steady-state target before coming back (exactly
// what totalVisualYaw does here — see dense log). This instead finds the
// LAST tick the signal is still outside a +-10% tolerance band around ssTarget
// (scanning the whole post-swap run), i.e. the point after which it never
// leaves the band again.
function settlingTime(getVal: (r: Row) => number, ssTarget: number, tolFrac = 0.1): number | null {
  const band = Math.abs(ssTarget) * tolFrac;
  let lastOutsideIdx = -1;
  for (let i = 0; i < post.length; i++) {
    if (Math.abs(getVal(post[i]) - ssTarget) > band) lastOutsideIdx = i;
  }
  if (lastOutsideIdx === post.length - 1) return null; // never actually settles within the sim window
  return post[lastOutsideIdx + 1].t - swapT;
}

const t_steer = firstTimeSteerCrosses(-0.9);
const t_omega = firstTimeReaches90pct((r) => r.omegaDegPerSec, ss2.omega);
const t_visual = firstTimeReaches90pct((r) => r.totalVisualYawDeg, ss2.visualYaw);
const t_side_zero = firstZeroCrossing((r) => r.sideSpeed, Math.sign(ss1.sideSpeed));
const t_side_90 = firstTimeReaches90pct((r) => r.sideSpeed, ss2.sideSpeed);

const t_omega_settle = settlingTime((r) => r.omegaDegPerSec, ss2.omega);
const t_visual_settle = settlingTime((r) => r.totalVisualYawDeg, ss2.visualYaw);
const t_side_settle = settlingTime((r) => r.sideSpeed, ss2.sideSpeed);

// Peak overshoot of totalVisualYaw beyond ss2 during the transition (signed
// magnitude past the target, same sign as ss2 — 0 if it never overshoots).
let visualOvershootPeak = 0;
for (const r of post) {
  const past = ss2.visualYaw >= 0 ? r.totalVisualYawDeg - ss2.visualYaw : ss2.visualYaw - r.totalVisualYawDeg;
  if (past > visualOvershootPeak) visualOvershootPeak = past;
}

// Speed loss during the transition (window: swap -> swap+1.5s, generously
// covering any of the above transition times).
const transitionWindow = post.filter((r) => r.t - swapT <= 1.5);
const minSpeedInTransition = Math.min(...transitionWindow.map((r) => r.speedXZ));
const speedLossVsPre = ss1.speed - minSpeedInTransition;

// Monotonicity check: sign flips in the discrete derivative of omega and
// totalVisualYaw during the transition window, ignoring tiny numerical
// noise (threshold scaled to each signal's own swing).
function countDerivativeSignFlips(getVal: (r: Row) => number, noiseFloor: number): number {
  const vals = transitionWindow.map(getVal);
  const derivs: number[] = [];
  for (let i = 1; i < vals.length; i++) derivs.push(vals[i] - vals[i - 1]);
  let flips = 0;
  let lastSign = 0;
  for (const d of derivs) {
    if (Math.abs(d) < noiseFloor) continue; // ignore sub-noise wobble
    const s = Math.sign(d);
    if (lastSign !== 0 && s !== lastSign) flips++;
    lastSign = s;
  }
  return flips;
}
const omegaSwing = Math.abs(ss2.omega - ss1.omega);
const visualSwing = Math.abs(ss2.visualYaw - ss1.visualYaw);
const omegaFlips = countDerivativeSignFlips((r) => r.omegaDegPerSec, omegaSwing * 0.01);
const visualFlips = countDerivativeSignFlips((r) => r.totalVisualYawDeg, visualSwing * 0.01);

console.log("\n=== Measured transition times (from the instant raw steer flips) ===");
console.log(`t_steer  (steerSm +1 -> -0.9):                    ${t_steer !== null ? t_steer.toFixed(3) + "s" : "NEVER within 3s window"}`);
console.log(`t_omega  (omega steady -> 90% of new steady):     ${t_omega !== null ? t_omega.toFixed(3) + "s" : "NEVER within 3s window"}`);
console.log(`t_visual (total visual yaw -> 90% of new steady): ${t_visual !== null ? t_visual.toFixed(3) + "s" : "NEVER within 3s window"}`);
console.log(`t_side   (sideSpeed crosses zero):                ${t_side_zero !== null ? t_side_zero.toFixed(3) + "s" : "NEVER within 3s window"}`);
console.log(`t_side   (sideSpeed -> 90% of new steady):        ${t_side_90 !== null ? t_side_90.toFixed(3) + "s" : "NEVER within 3s window"}`);

console.log("\n=== TRUE settling time (last exit from +-10% band around new steady state, i.e. never leaves again) ===");
console.log(`omega settles:     ${t_omega_settle !== null ? t_omega_settle.toFixed(3) + "s" : "never settles within 3s window"}`);
console.log(`visual yaw settles: ${t_visual_settle !== null ? t_visual_settle.toFixed(3) + "s" : "never settles within 3s window"}`);
console.log(`sideSpeed settles:  ${t_side_settle !== null ? t_side_settle.toFixed(3) + "s" : "never settles within 3s window"}`);
console.log(`visual yaw peak overshoot past new steady (${ss2.visualYaw.toFixed(1)}deg): ${visualOvershootPeak.toFixed(1)}deg`);

console.log("\n=== Speed loss during transition ===");
console.log(`pre-swap steady |v|: ${ss1.speed.toFixed(3)} m/s`);
console.log(`min |v| in swap+1.5s window: ${minSpeedInTransition.toFixed(3)} m/s`);
console.log(`speed loss: ${speedLossVsPre.toFixed(3)} m/s (${((speedLossVsPre / ss1.speed) * 100).toFixed(1)}%)`);

console.log("\n=== Monotonicity / judder check (transition window, swap -> swap+1.5s) ===");
console.log(`omega derivative sign flips (noise floor ${(omegaSwing * 0.01).toFixed(2)} deg/s per tick): ${omegaFlips}`);
console.log(`visual yaw derivative sign flips (noise floor ${(visualSwing * 0.01).toFixed(3)} deg per tick): ${visualFlips}`);

console.log("\n=== Dense log: swap -> swap+2.4s, every 12th tick (~10/s) ===");
for (let i = 0; i < post.length && post[i].t - swapT <= 2.4; i += 12) {
  const r = post[i];
  console.log(
    `t+${(r.t - swapT).toFixed(3)}s steerSm=${r.steerSm.toFixed(3)} omega=${r.omegaDegPerSec.toFixed(1)}deg/s ` +
    `sideSpd=${r.sideSpeed.toFixed(3)} dFast=${r.dFast.toFixed(3)} engage=${r.engageFactor.toFixed(3)} ` +
    `visYawOff=${r.visualYawOffsetDeg.toFixed(1)}deg leanAngle=${r.visualDriftAngleDeg.toFixed(1)}deg totalVisYaw=${r.totalVisualYawDeg.toFixed(1)}deg ` +
    `fwdSpd=${r.fwdSpeed.toFixed(3)} |v|=${r.speedXZ.toFixed(3)} driftInt=${r.driftIntensity.toFixed(3)}`
  );
}

console.log("\n=== Target from video analysis ===");
console.log("Full S-transition (direction reversal, no speed loss): ~0.6-0.8s");

// ─── Fresh-entry regression check ──────────────────────────────────────────
// driftReversalRate (and its reversalMemory helper filter, see
// driftContinuous.ts step 3) is designed to ONLY slow down dFast on a
// mid-drift direction FLIP. A drift engaged from a standing start (dFast===0,
// no opposing sign to react against) must reach full engagement at the
// UNCHANGED driftEngageInRate — this section runs an independent fresh
// instance and confirms that timing didn't regress.
{
  const freshBicycle = new BicyclePhysics(params, DEFAULT_AXLE_GEOMETRY);
  const freshDrift = new ContinuousDrift(params);
  let fYaw = 0;
  const fVel = { x: 0, y: 0, z: 0 };
  let fThrottleSm = 0;
  let fSteerSm = 0;
  let fPenaltySlow = 0;
  let ft = 0;
  let entryStartT: number | null = null;
  let reachedT: number | null = null;
  const FDT = DT;
  for (let i = 0; i < Math.round(4.5 * 120); i++) {
    const rawSteer = i < Math.round(3.5 * 120) ? 0 : 1; // straight accel, then steer to +1 at t=3.5s
    const rawThrottle = 1;
    if (entryStartT === null && rawSteer !== 0) entryStartT = ft;

    const slew = Math.abs(rawSteer) > Math.abs(fSteerSm) ? params.steerSlewRateIn : params.steerSlewRateOut;
    fSteerSm += (rawSteer - fSteerSm) * (1 - Math.exp(-slew * FDT));
    if (Math.abs(fSteerSm) < 0.01 && Math.abs(rawSteer) < 0.01) fSteerSm = 0;
    fThrottleSm += (rawThrottle - fThrottleSm) * (1 - Math.exp(-params.throttleSlewRate * FDT));

    const fwdDir = forwardOf(fYaw);
    const rightDir = rightOf(fYaw);
    const speed = Math.hypot(fVel.x, fVel.z);
    const driftOut = freshDrift.update(speed, fSteerSm, true, fThrottleSm, FDT);

    const penaltyAlpha = 1 - Math.exp(-(1 / Math.max(params.driftPenaltyTau, 0.05)) * FDT);
    fPenaltySlow += (freshBicycle.getDriftIntensity() - fPenaltySlow) * penaltyAlpha;

    const inp: PhysicsInput = {
      velocity: { ...fVel },
      forward: { x: fwdDir.x, y: 0, z: fwdDir.z },
      right: { x: rightDir.x, y: 0, z: rightDir.z },
      throttle: fThrottleSm,
      steerInput: fSteerSm,
      brakeHeld: false,
      onFloor: true,
      rearGripMultiplier: driftOut.rearGripMultiplier,
      driftPenaltyFactor: fPenaltySlow,
      groundSlopeRad: 0,
    };
    const out = freshBicycle.step(inp, FDT);
    fYaw += out.yawDelta + driftOut.yawBonusRadPerSec * FDT;
    fVel.x = out.newVelocity.x;
    fVel.z = out.newVelocity.z;

    if (entryStartT !== null && reachedT === null && freshDrift.getDFast() >= 0.9) {
      reachedT = ft - entryStartT;
    }
    ft += FDT;
  }
  console.log("\n=== Fresh-entry regression (dFast === 0 -> steer flips to +1, no prior drift) ===");
  console.log(
    `time for dFast to reach 0.9 from a standing start: ${reachedT !== null ? reachedT.toFixed(3) + "s" : "NEVER within window"} ` +
    `(should match driftEngageInRate=${params.driftEngageInRate}/s timing, unaffected by driftReversalRate=${params.driftReversalRate}/s)`
  );
}
