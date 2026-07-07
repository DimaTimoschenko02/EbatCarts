// Diagnostic (not a test) — isolates the braking asymmetry from owner
// feedback point 3: "forward, then hold S -> stops almost instantly; but
// reverse -> forward has proper inertia." Straight-line only (steerInput=0),
// no THREE dependency.
//
// Run: npx tsx tools/diagnose_longitudinal.ts

import { BicyclePhysics } from "../src/physics/bicyclePhysics";
import { DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY } from "../src/physics/types";
import type { PhysicsInput, KartPhysicsParams } from "../src/physics/types";

const FORWARD = { x: 0, y: 0, z: -1 };
const RIGHT = { x: 1, y: 0, z: 0 };
const DT = 1 / 120;

function simulate(
  params: KartPhysicsParams,
  label: string,
  phases: { ticks: number; throttle: number; brakeHeld: boolean }[]
) {
  const bike = new BicyclePhysics(params, DEFAULT_AXLE_GEOMETRY);
  let velocity = { x: 0, y: 0, z: 0 };
  let t = 0;
  const rows: { t: number; fwdSpeed: number; throttle: number }[] = [];
  for (const ph of phases) {
    for (let i = 0; i < ph.ticks; i++) {
      const inp: PhysicsInput = {
        velocity,
        forward: FORWARD,
        right: RIGHT,
        throttle: ph.throttle,
        steerInput: 0,
        brakeHeld: ph.brakeHeld,
        onFloor: true,
        rearGripMultiplier: 1,
        driftPenaltyFactor: 0,
        groundSlopeRad: 0,
      };
      const st = bike.step(inp, DT);
      velocity = st.newVelocity;
      t += DT;
      rows.push({ t, fwdSpeed: st.fwdSpeed, throttle: ph.throttle });
    }
  }
  console.log(`\n=== ${label} ===`);
  // Find time to cross under 3 m/s ("low speed") and under 1 m/s from the
  // moment braking/reverse-throttle phase started.
  const brakeStartIdx = phases[0].ticks; // first phase is "cruise", second is the maneuver
  const cruiseSpeed = rows[brakeStartIdx - 1].fwdSpeed;
  let tTo3 = -1, tTo1 = -1, tTo0 = -1;
  for (let i = brakeStartIdx; i < rows.length; i++) {
    const dt = rows[i].t - rows[brakeStartIdx - 1].t;
    if (tTo3 < 0 && Math.abs(rows[i].fwdSpeed) <= Math.abs(cruiseSpeed) - 3) tTo3 = dt;
    if (tTo1 < 0 && Math.abs(rows[i].fwdSpeed) <= Math.abs(cruiseSpeed) - 1) tTo1 = dt;
    if (tTo0 < 0 && Math.abs(rows[i].fwdSpeed) <= 0.05) tTo0 = dt;
  }
  console.log(`cruise speed at maneuver start: ${cruiseSpeed.toFixed(2)} m/s`);
  console.log(`time to <=3 m/s: ${tTo3 < 0 ? "N/A" : tTo3.toFixed(3)}s`);
  console.log(`time to <=1 m/s: ${tTo1 < 0 ? "N/A" : tTo1.toFixed(3)}s`);
  console.log(`time to ~0: ${tTo0 < 0 ? "N/A" : tTo0.toFixed(3)}s`);
  // dense print for first 1s of the maneuver
  for (let i = brakeStartIdx; i < Math.min(rows.length, brakeStartIdx + 130); i += 6) {
    console.log(`  t+${(rows[i].t - rows[brakeStartIdx - 1].t).toFixed(3)}s fwdSpeed=${rows[i].fwdSpeed.toFixed(2)}`);
  }
}

const p = DEFAULT_KART_PHYSICS_PARAMS;

// Scenario A: cruise to terminal-ish speed, then hold S (throttle=-1, brakeHeld=true) — CURRENT behavior.
simulate(p, "CURRENT: cruise -> hold S (reverse thrust + brake simultaneously)", [
  { ticks: 240, throttle: 1, brakeHeld: false }, // 2s accel
  { ticks: 180, throttle: -1, brakeHeld: true }, // 1.5s hold S
]);

// Scenario B: reverse to forward (the "correct-feeling" baseline) for comparison.
simulate(p, "BASELINE: reverse cruise -> hold W (forward thrust only, no brake)", [
  { ticks: 240, throttle: -1, brakeHeld: false }, // 2s reverse accel
  { ticks: 180, throttle: 1, brakeHeld: false }, // 1.5s hold W
]);

// Scenario C: coast only (throttle=0, no brake) — natural drag/rolling deceleration, for reference.
simulate(p, "REFERENCE: cruise -> coast (throttle=0, no brake)", [
  { ticks: 240, throttle: 1, brakeHeld: false },
  { ticks: 180, throttle: 0, brakeHeld: false },
]);
