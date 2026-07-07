// Diagnostic script (not a test) — reproduces kart.ts's per-tick wiring
// (smoothInput -> ContinuousDrift.update -> BicyclePhysics.step -> yaw/vel
// composition) OUTSIDE three.js, to quantify reverse vs forward acceleration,
// maneuverability (yaw rate / turn radius / 180-deg time), and input
// responsiveness, and to catalogue every place the physics code treats
// fwdSpeed<0 differently from fwdSpeed>0 (owner playtest: "reverse feels
// off" — no specific numbers given, this produces them).
//
// Run: npx tsx tools/diagnose_reverse.ts

import { BicyclePhysics } from "../src/physics/bicyclePhysics";
import { ContinuousDrift } from "../src/physics/driftContinuous";
import { DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY } from "../src/physics/types";
import type { KartPhysicsParams, PhysicsInput } from "../src/physics/types";

const DT = 1 / 120; // matches src/main.ts PHYS_STEP

function forwardOf(y: number) {
  return { x: -Math.sin(y), z: -Math.cos(y) };
}
function rightOf(y: number) {
  return { x: Math.cos(y), z: -Math.sin(y) };
}

interface SimState {
  params: KartPhysicsParams;
  bicycle: BicyclePhysics;
  drift: ContinuousDrift;
  yaw: number;
  vel: { x: number; y: number; z: number };
  throttleSm: number;
  steerSm: number;
}

function makeSim(): SimState {
  const params = { ...DEFAULT_KART_PHYSICS_PARAMS };
  return {
    params,
    bicycle: new BicyclePhysics(params, DEFAULT_AXLE_GEOMETRY),
    drift: new ContinuousDrift(params),
    yaw: 0,
    vel: { x: 0, y: 0, z: 0 },
    throttleSm: 0,
    steerSm: 0,
  };
}

interface TickResult {
  t: number;
  fwdSpeed: number;
  speedXZ: number;
  omegaDegPerSec: number;
  yawDeg: number;
  steerSm: number;
  throttleSm: number;
}

// One physics substep, wired exactly like kart.ts's update() (grounded, no
// map, flat ground -> groundSlopeRad=0, onFloor always true).
function tick(sim: SimState, t: number, rawSteer: number, rawThrottle: number): TickResult {
  const p = sim.params;
  const slew = Math.abs(rawSteer) > Math.abs(sim.steerSm) ? p.steerSlewRateIn : p.steerSlewRateOut;
  const steerAlpha = 1 - Math.exp(-slew * DT);
  sim.steerSm += (rawSteer - sim.steerSm) * steerAlpha;
  const thrAlpha = 1 - Math.exp(-p.throttleSlewRate * DT);
  sim.throttleSm += (rawThrottle - sim.throttleSm) * thrAlpha;

  const fwdDir = forwardOf(sim.yaw);
  const rightDir = rightOf(sim.yaw);
  const speed = Math.hypot(sim.vel.x, sim.vel.z);
  const fwdSigned = sim.vel.x * fwdDir.x + sim.vel.z * fwdDir.z;

  const drift = sim.drift.update(speed, sim.steerSm, true, sim.throttleSm, DT);

  const inp: PhysicsInput = {
    velocity: { ...sim.vel },
    forward: { x: fwdDir.x, y: 0, z: fwdDir.z },
    right: { x: rightDir.x, y: 0, z: rightDir.z },
    throttle: sim.throttleSm,
    steerInput: sim.steerSm,
    brakeHeld: rawThrottle < 0,
    onFloor: true,
    rearGripMultiplier: drift.rearGripMultiplier,
    groundSlopeRad: 0,
  };
  const st = sim.bicycle.step(inp, DT);
  sim.yaw += st.yawDelta + drift.yawBonusRadPerSec * DT;
  sim.vel.x = st.newVelocity.x;
  sim.vel.z = st.newVelocity.z;

  const assist = drift.forwardAssistForce + drift.exitBoostForce;
  if (Math.abs(assist) > 0 && fwdSigned >= 0) {
    const fwdAfter = forwardOf(sim.yaw);
    sim.vel.x += fwdAfter.x * assist * DT;
    sim.vel.z += fwdAfter.z * assist * DT;
  }

  return {
    t,
    fwdSpeed: st.fwdSpeed,
    speedXZ: Math.hypot(sim.vel.x, sim.vel.z),
    omegaDegPerSec: (st.omega * 180) / Math.PI,
    yawDeg: (sim.yaw * 180) / Math.PI,
    steerSm: sim.steerSm,
    throttleSm: sim.throttleSm,
  };
}

function runPhases(sim: SimState, phases: { seconds: number; steer: number; throttle: number }[]): TickResult[] {
  const rows: TickResult[] = [];
  let t = 0;
  for (const ph of phases) {
    const ticks = Math.round(ph.seconds * 120);
    for (let i = 0; i < ticks; i++) {
      rows.push(tick(sim, t, ph.steer, ph.throttle));
      t += DT;
    }
  }
  return rows;
}

// ─── 1. Straight-line accel: forward vs reverse from rest ──────────────────

console.log("=== 1. STRAIGHT-LINE ACCEL FROM REST ===\n");

function accelTest(label: string, throttleSign: 1 | -1) {
  const sim = makeSim();
  const rows = runPhases(sim, [{ seconds: 8, steer: 0, throttle: throttleSign }]);
  const terminal = rows[rows.length - 1].fwdSpeed;
  const target95 = terminal * 0.95;
  let tTo95 = -1;
  for (const r of rows) {
    if (Math.abs(r.fwdSpeed) >= Math.abs(target95)) {
      tTo95 = r.t;
      break;
    }
  }
  console.log(`${label}: terminal fwdSpeed=${terminal.toFixed(3)} m/s, time to 95% terminal=${tTo95 < 0 ? "N/A" : tTo95.toFixed(3) + "s"}`);
  return { terminal, tTo95, rows };
}

const fwdAccel = accelTest("FORWARD (throttle=+1)", 1);
const revAccel = accelTest("REVERSE (throttle=-1)", -1);

console.log(`\nComparison: forward terminal=${fwdAccel.terminal.toFixed(2)} m/s (maxSpeed param=${DEFAULT_KART_PHYSICS_PARAMS.maxSpeed}), reverse terminal=${revAccel.terminal.toFixed(2)} m/s`);
console.log(`reverse/forward terminal ratio: ${(Math.abs(revAccel.terminal) / Math.abs(fwdAccel.terminal)).toFixed(3)} (reverseRatio param=${DEFAULT_KART_PHYSICS_PARAMS.reverseRatio})`);
console.log(`forward 0->95%: ${fwdAccel.tTo95.toFixed(3)}s   reverse 0->95%: ${revAccel.tTo95.toFixed(3)}s`);

// ─── 2. Maneuverability: yaw rate / turn radius / 180deg time ──────────────

console.log("\n\n=== 2. MANEUVERABILITY AT TERMINAL SPEED (steer applied after reaching cruise) ===\n");

function maneuverTest(label: string, cruiseThrottle: 1 | -1, steerHoldSeconds: number) {
  const sim = makeSim();
  // Phase 1: reach terminal cruise straight.
  runPhases(sim, [{ seconds: 6, steer: 0, throttle: cruiseThrottle }]);
  const cruiseSpeed = sim.vel.x * forwardOf(sim.yaw).x + sim.vel.z * forwardOf(sim.yaw).z;
  // Phase 2: full steer, same throttle held (keeps speed from decaying).
  const rows = runPhases(sim, [{ seconds: steerHoldSeconds, steer: 1, throttle: cruiseThrottle }]);

  // Steady state = last 1s of the hold.
  const steadyRows = rows.filter((r) => r.t >= steerHoldSeconds - 1.0);
  const meanOmega = steadyRows.reduce((s, r) => s + r.omegaDegPerSec, 0) / steadyRows.length;
  const meanSpeed = steadyRows.reduce((s, r) => s + Math.abs(r.fwdSpeed), 0) / steadyRows.length;
  const turnRadius = Math.abs(meanOmega) > 0.01 ? meanSpeed / (Math.abs(meanOmega) * (Math.PI / 180)) : Infinity;

  // Time to accumulate |180deg| of yaw change since steer was applied.
  const yawStart = rows[0].yawDeg;
  let tTo180 = -1;
  for (const r of rows) {
    if (Math.abs(r.yawDeg - yawStart) >= 180) {
      tTo180 = r.t;
      break;
    }
  }

  console.log(
    `${label}: cruiseSpeed=${cruiseSpeed.toFixed(2)} m/s | steady omega=${meanOmega.toFixed(1)} deg/s | ` +
    `steady |fwdSpeed|=${meanSpeed.toFixed(2)} m/s | turn radius=${turnRadius.toFixed(2)} m | ` +
    `time to 180deg=${tTo180 < 0 ? "N/A (didn't complete within window)" : tTo180.toFixed(3) + "s"}`
  );
  return { cruiseSpeed, meanOmega, meanSpeed, turnRadius, tTo180 };
}

const fwdManeuverOwnTerminal = maneuverTest("FORWARD @ own terminal (~24.x m/s)", 1, 5);
const revManeuverOwnTerminal = maneuverTest("REVERSE @ own terminal (~-X m/s)", -1, 5);

// Apples-to-apples: forward held at a throttle-limited speed matching the
// reverse terminal magnitude, so the ONLY difference is the sign of
// fwdSpeed flowing through the physics (steerMult spdRatio normalizes to
// maxSpeed either way, kinematicBlend uses abs(fwdSpeed), tire-force sign
// terms use raw fwdSpeed).
function maneuverAtMatchedSpeed(label: string, targetSpeedMag: number, throttleSign: 1 | -1, steerHoldSeconds: number) {
  const sim = makeSim();
  // Ramp to just under the target magnitude by cutting throttle once close,
  // coasting the rest of the way (simple bang-bang speed governor — good
  // enough for this diagnostic, not meant to be perfectly steady).
  let t = 0;
  const rampRows: TickResult[] = [];
  for (let i = 0; i < 20 * 120; i++) {
    const curSpeed = Math.hypot(sim.vel.x, sim.vel.z);
    const throttle = curSpeed < targetSpeedMag * 0.98 ? throttleSign : 0;
    rampRows.push(tick(sim, t, 0, throttle));
    t += DT;
    if (curSpeed >= targetSpeedMag * 0.98) break;
  }
  const reachedSpeed = Math.hypot(sim.vel.x, sim.vel.z);
  // Phase 2: full steer, throttle held at a light maintenance level (same
  // sign) so speed doesn't bleed off from cornering drag mid-test.
  const rows = runPhases(sim, [{ seconds: steerHoldSeconds, steer: 1, throttle: throttleSign }]);
  const steadyRows = rows.filter((r) => r.t >= steerHoldSeconds - 1.0);
  const meanOmega = steadyRows.reduce((s, r) => s + r.omegaDegPerSec, 0) / steadyRows.length;
  const meanSpeed = steadyRows.reduce((s, r) => s + Math.abs(r.fwdSpeed), 0) / steadyRows.length;
  const turnRadius = Math.abs(meanOmega) > 0.01 ? meanSpeed / (Math.abs(meanOmega) * (Math.PI / 180)) : Infinity;
  const yawStart = rows[0].yawDeg;
  let tTo180 = -1;
  for (const r of rows) {
    if (Math.abs(r.yawDeg - yawStart) >= 180) {
      tTo180 = r.t;
      break;
    }
  }
  console.log(
    `${label}: reachedSpeed=${reachedSpeed.toFixed(2)} m/s (target ${targetSpeedMag.toFixed(2)}) | ` +
    `steady omega=${meanOmega.toFixed(1)} deg/s | steady |fwdSpeed|=${meanSpeed.toFixed(2)} m/s | ` +
    `turn radius=${turnRadius.toFixed(2)} m | time to 180deg=${tTo180 < 0 ? "N/A" : tTo180.toFixed(3) + "s"}`
  );
  return { meanOmega, meanSpeed, turnRadius, tTo180 };
}

console.log("\n--- Matched-speed comparison (both at |speed| = reverse terminal) ---");
const matchedSpeedMag = Math.abs(revAccel.terminal);
const fwdManeuverMatched = maneuverAtMatchedSpeed("FORWARD @ matched speed", matchedSpeedMag, 1, 5);
const revManeuverMatched = maneuverAtMatchedSpeed("REVERSE @ matched speed", matchedSpeedMag, -1, 5);

// ─── 3. Steering responsiveness: time to 50% of peak yaw rate ──────────────

console.log("\n\n=== 3. STEER RESPONSIVENESS (steer slammed from 0->1 at cruise) ===\n");

function responsivenessTest(label: string, throttleSign: 1 | -1) {
  const sim = makeSim();
  runPhases(sim, [{ seconds: 6, steer: 0, throttle: throttleSign }]); // reach cruise
  const rows = runPhases(sim, [{ seconds: 2, steer: 1, throttle: throttleSign }]);
  let peakOmega = 0;
  for (const r of rows) {
    if (Math.abs(r.omegaDegPerSec) > Math.abs(peakOmega)) peakOmega = r.omegaDegPerSec;
  }
  const target = peakOmega * 0.5;
  let tTo50 = -1;
  for (const r of rows) {
    if (Math.abs(r.omegaDegPerSec) >= Math.abs(target)) {
      tTo50 = r.t;
      break;
    }
  }
  console.log(`${label}: peak omega=${peakOmega.toFixed(1)} deg/s, time to 50% peak=${tTo50 < 0 ? "N/A" : (tTo50 * 1000).toFixed(1) + "ms"}`);
  return { peakOmega, tTo50 };
}

const fwdResp = responsivenessTest("FORWARD cruise, steer slam", 1);
const revResp = responsivenessTest("REVERSE cruise, steer slam", -1);

// ─── 4. Direction-reversal delay asymmetry ──────────────────────────────────
// Forward cruise -> hold S (reverse intent) vs Reverse cruise -> hold W
// (forward intent). Measures: time for fwdSpeed to cross 0, and time to
// reach 95% of the OPPOSITE direction's terminal speed.

console.log("\n\n=== 4. DIRECTION-REVERSAL ASYMMETRY (forward cruise -> hold S, vs reverse cruise -> hold W) ===\n");

function reversalTest(label: string, cruiseThrottle: 1 | -1, reversalThrottle: 1 | -1) {
  const sim = makeSim();
  runPhases(sim, [{ seconds: 6, steer: 0, throttle: cruiseThrottle }]);
  const cruiseSpeed = sim.vel.x * forwardOf(sim.yaw).x + sim.vel.z * forwardOf(sim.yaw).z;
  const rows = runPhases(sim, [{ seconds: 8, steer: 0, throttle: reversalThrottle }]);
  let tToZero = -1;
  let tToOppositeTerminal95 = -1;
  const finalSpeed = rows[rows.length - 1].fwdSpeed;
  const target95 = finalSpeed * 0.95;
  for (const r of rows) {
    if (tToZero < 0 && Math.sign(r.fwdSpeed) === Math.sign(reversalThrottle) && Math.abs(r.fwdSpeed) > 0.02) {
      tToZero = r.t;
    }
    if (tToOppositeTerminal95 < 0 && Math.abs(r.fwdSpeed) >= Math.abs(target95) && Math.sign(r.fwdSpeed) === Math.sign(reversalThrottle)) {
      tToOppositeTerminal95 = r.t;
    }
  }
  console.log(
    `${label}: cruiseSpeed=${cruiseSpeed.toFixed(2)} m/s -> reversalThrottle=${reversalThrottle} | ` +
    `time fwdSpeed crosses to new-direction sign: ${tToZero < 0 ? "N/A" : tToZero.toFixed(3) + "s"} | ` +
    `time to 95% of new terminal (${finalSpeed.toFixed(2)} m/s): ${tToOppositeTerminal95 < 0 ? "N/A" : tToOppositeTerminal95.toFixed(3) + "s"}`
  );
  // Dense trace of the first 1.5s of the reversal.
  for (let i = 0; i < rows.length && rows[i].t <= 1.5; i += 12) {
    console.log(`  t+${rows[i].t.toFixed(3)}s fwdSpeed=${rows[i].fwdSpeed.toFixed(3)}`);
  }
  return { tToZero, tToOppositeTerminal95 };
}

const fwdToReverse = reversalTest("Forward cruise -> hold S (brake then reverse)", 1, -1);
console.log();
const revToForward = reversalTest("Reverse cruise -> hold W (thrust immediately opposes)", -1, 1);

// ─── Final summary tables ────────────────────────────────────────────────────

console.log("\n\n=== FINAL SUMMARY TABLE ===\n");
console.log("Straight accel from rest:");
console.log(`  forward: terminal=${fwdAccel.terminal.toFixed(2)} m/s, t->95%=${fwdAccel.tTo95.toFixed(3)}s`);
console.log(`  reverse: terminal=${revAccel.terminal.toFixed(2)} m/s, t->95%=${revAccel.tTo95.toFixed(3)}s`);

console.log("\nManeuverability @ own terminal speed:");
console.log(`  forward: omega=${fwdManeuverOwnTerminal.meanOmega.toFixed(1)} deg/s, radius=${fwdManeuverOwnTerminal.turnRadius.toFixed(2)} m, t->180deg=${fwdManeuverOwnTerminal.tTo180 < 0 ? "N/A" : fwdManeuverOwnTerminal.tTo180.toFixed(3) + "s"}`);
console.log(`  reverse: omega=${revManeuverOwnTerminal.meanOmega.toFixed(1)} deg/s, radius=${revManeuverOwnTerminal.turnRadius.toFixed(2)} m, t->180deg=${revManeuverOwnTerminal.tTo180 < 0 ? "N/A" : revManeuverOwnTerminal.tTo180.toFixed(3) + "s"}`);

console.log("\nManeuverability @ matched |speed| (reverse terminal magnitude):");
console.log(`  forward: omega=${fwdManeuverMatched.meanOmega.toFixed(1)} deg/s, radius=${fwdManeuverMatched.turnRadius.toFixed(2)} m, t->180deg=${fwdManeuverMatched.tTo180 < 0 ? "N/A" : fwdManeuverMatched.tTo180.toFixed(3) + "s"}`);
console.log(`  reverse: omega=${revManeuverMatched.meanOmega.toFixed(1)} deg/s, radius=${revManeuverMatched.turnRadius.toFixed(2)} m, t->180deg=${revManeuverMatched.tTo180 < 0 ? "N/A" : revManeuverMatched.tTo180.toFixed(3) + "s"}`);

console.log("\nSteer responsiveness (time to 50% peak omega):");
console.log(`  forward: ${(fwdResp.tTo50 * 1000).toFixed(1)}ms (peak omega ${fwdResp.peakOmega.toFixed(1)} deg/s)`);
console.log(`  reverse: ${(revResp.tTo50 * 1000).toFixed(1)}ms (peak omega ${revResp.peakOmega.toFixed(1)} deg/s)`);

console.log("\nDirection-reversal delay:");
console.log(`  forward->reverse (hold S from forward cruise): t->new-dir-95%=${fwdToReverse.tToOppositeTerminal95 < 0 ? "N/A" : fwdToReverse.tToOppositeTerminal95.toFixed(3) + "s"}`);
console.log(`  reverse->forward (hold W from reverse cruise): t->new-dir-95%=${revToForward.tToOppositeTerminal95 < 0 ? "N/A" : revToForward.tToOppositeTerminal95.toFixed(3) + "s"}`);
