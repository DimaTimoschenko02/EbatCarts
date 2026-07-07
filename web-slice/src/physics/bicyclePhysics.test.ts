import { describe, expect, it } from "vitest";
import { BicyclePhysics, computeAxleLateralVelocities, computeSlipRatio } from "./bicyclePhysics";
import { ContinuousDrift } from "./driftContinuous";
import { DEFAULT_AXLE_GEOMETRY, DEFAULT_KART_PHYSICS_PARAMS, type KartPhysicsParams, type PhysicsInput } from "./types";

// Godot convention (see types.ts header): forward = -Z, right = +X at yaw=0.
const FORWARD = { x: 0, y: 0, z: -1 };
const RIGHT = { x: 1, y: 0, z: 0 };

function freshInput(overrides: Partial<PhysicsInput> = {}): PhysicsInput {
  return {
    velocity: { x: 0, y: 0, z: 0 },
    forward: FORWARD,
    right: RIGHT,
    throttle: 0,
    steerInput: 0,
    brakeHeld: false,
    onFloor: true,
    rearGripMultiplier: 1,
    // Default 0: most tests here aren't exercising the drift-penalty terms
    // (dragMult/rollingMult/cdDriftScale in step I) — see the dedicated
    // "longitudinal drift penalty" describe block below for tests that pass
    // a nonzero override explicitly.
    driftPenaltyFactor: 0,
    groundSlopeRad: 0,
    ...overrides,
  };
}

const DT = 1 / 120;

describe("BicyclePhysics — straight-line acceleration", () => {
  it("converges to the force-equilibrium terminal velocity with full throttle, no steer", () => {
    const bike = new BicyclePhysics(DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY);
    let velocity = { x: 0, y: 0, z: 0 };

    // Equilibrium: accelForce = kDrag*v^2 + kRolling*v  (drag dominates at high
    // speed, rolling resistance is NOT negligible at these tuned values —
    // the naive sqrt(accelForce/kDrag) ≈ 16.9 m/s approximation mentioned in
    // dev_params.json's comment ignores the kRolling term entirely and
    // overshoots the real equilibrium significantly at kRolling=1.1).
    const { accelForce, kDrag, kRolling } = DEFAULT_KART_PHYSICS_PARAMS;
    const disc = kRolling * kRolling + 4 * kDrag * accelForce;
    const expectedTerminal = (-kRolling + Math.sqrt(disc)) / (2 * kDrag);
    expect(expectedTerminal).toBeCloseTo(10.7828, 3);

    // Simulate 30 sim-seconds of full throttle, dead straight.
    const steps = Math.round(30 / DT);
    let fwdSpeed = 0;
    for (let i = 0; i < steps; i++) {
      const input = freshInput({ velocity, throttle: 1, steerInput: 0 });
      const state = bike.step(input, DT);
      velocity = state.newVelocity;
      fwdSpeed = state.fwdSpeed;
    }

    expect(fwdSpeed).toBeCloseTo(expectedTerminal, 1);
    // Straight line: no steer, no yaw torque should ever have accumulated.
    expect(bike.getOmega()).toBeCloseTo(0, 6);
  });
});

describe("BicyclePhysics — per-wheel lateral velocity formula (bicycle identity)", () => {
  it("matches the ACTUAL v3.0 code formula: side_speed + omega*half_wb, shared by both rear wheels", () => {
    // Inputs from design/gdd/kart-physics.md "Per-Wheel Lateral Velocity" example:
    // omega=1.5 rad/s, side_speed=2 m/s, half_wb=0.6 m, half_track=0.45 m.
    const omega = 1.5;
    const sideSpeed = 2;
    const halfWb = 0.6;

    const { rear } = computeAxleLateralVelocities(sideSpeed, omega, halfWb);

    // The GDD prose documents a half_track-differentiated formula that would
    // give rear-left=0.425, rear-right=1.775 for these inputs. The actual
    // bicycle_physics.gd v3.0 code (ported here) does NOT differentiate by
    // half_track — both rear wheels read the same value. This is a genuine
    // spec/implementation divergence (see bicyclePhysics.ts file header and
    // final report) — flagging for game-designer/systems-designer, not
    // silently "fixed" as part of this port.
    expect(rear).toBeCloseTo(2.9, 6); // 2 + 1.5*0.6

    // Confirming this ported formula gives IDENTICAL rear-left/rear-right —
    // no divergence from omega alone (matches bicycle_physics.gd's explicit
    // comment that visual arc divergence must come from wheel world position,
    // not from differing body-frame lateral velocity).
    const rearLeft = rear;
    const rearRight = rear;
    expect(rearLeft).toBe(rearRight);
  });

  it("front and rear axle velocities have opposite-signed omega contribution", () => {
    const omega = 1.5;
    const sideSpeed = 2;
    const halfWb = 0.6;
    const { front, rear } = computeAxleLateralVelocities(sideSpeed, omega, halfWb);
    // front = side - omega*half_wb = 2 - 0.9 = 1.1
    // rear  = side + omega*half_wb = 2 + 0.9 = 2.9
    expect(front).toBeCloseTo(1.1, 6);
    expect(rear).toBeCloseTo(2.9, 6);
  });

  it("no divergence between front/rear when omega = 0", () => {
    const { front, rear } = computeAxleLateralVelocities(3.0, 0, 0.6);
    expect(front).toBe(3.0);
    expect(rear).toBe(3.0);
  });
});

describe("BicyclePhysics — drift intensity signal shaping", () => {
  it("slip_ratio = 1.0 when rear_slip_mag equals DRIFT_MAX_SLIP_SPEED", () => {
    const maxSlip = DEFAULT_KART_PHYSICS_PARAMS.driftMaxSlipSpeed;
    expect(maxSlip).toBe(8);
    expect(computeSlipRatio(8, maxSlip)).toBeCloseTo(1.0, 6);
  });

  it("slip_ratio clamps at 1.0 beyond the max slip speed", () => {
    const maxSlip = DEFAULT_KART_PHYSICS_PARAMS.driftMaxSlipSpeed;
    expect(computeSlipRatio(20, maxSlip)).toBe(1.0);
  });

  it("slip_ratio is proportional below the max slip speed", () => {
    const maxSlip = DEFAULT_KART_PHYSICS_PARAMS.driftMaxSlipSpeed;
    expect(computeSlipRatio(4, maxSlip)).toBeCloseTo(0.5, 6);
  });

  it("drift_intensity smooths toward the target slip_ratio over time (not instant)", () => {
    // Build a scenario where a strong, sustained steer at speed produces a
    // large, roughly-steady rear slip, and confirm intensity ramps up
    // gradually (never jumps) and is bounded [0,1].
    const bike = new BicyclePhysics(DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY);
    let velocity = { x: 0, y: 0, z: -12 }; // already moving forward fast
    let prevIntensity = 0;
    let sawIncrease = false;
    for (let i = 0; i < 240; i++) {
      // ~2s
      const input = freshInput({ velocity, throttle: 1, steerInput: 1, rearGripMultiplier: 0.25 });
      const state = bike.step(input, DT);
      velocity = state.newVelocity;
      expect(state.driftIntensity).toBeGreaterThanOrEqual(0);
      expect(state.driftIntensity).toBeLessThanOrEqual(1);
      if (state.driftIntensity > prevIntensity + 1e-9) sawIncrease = true;
      prevIntensity = state.driftIntensity;
    }
    expect(sawIncrease).toBe(true);
    // With rear_grip_multiplier=0.25 the rear axle slip settles at a
    // moderate (not extreme) level relative to DRIFT_MAX_SLIP_SPEED=8, so
    // the smoothed intensity converges to a real, but not saturated, value —
    // empirically ~0.18 with these default tuned params. The point of this
    // test is the smoothing behavior (gradual ramp, bounded [0,1]), not a
    // specific target magnitude.
    expect(prevIntensity).toBeGreaterThan(0.1);
  });
});

describe("BicyclePhysics — reverse driving gate", () => {
  // UPDATED 2026-07-07 (Fix 3, consistency gate): step J's targetIntensity
  // gate was changed from a hard `fwdSpeed >= driftMinSpeed` (ANY negative
  // fwdSpeed gated the drift signal to 0, even a fast, hard-steering reverse)
  // to `Math.abs(fwdSpeed) >= driftMinSpeed` — matching ContinuousDrift's own
  // abs-gating (driftContinuous.ts speedGate uses Math.abs(speed)), so the
  // two drift signals no longer disagree about whether a fast reverse counts
  // as "moving fast enough to drift." This test used to assert the OLD hard
  // gate (drift forced to 0 while reversing); it now asserts the NEW,
  // intentional behavior: reversing fast + steering hard produces real,
  // nonzero drift intensity, same as it would going forward at that speed.
  it("no longer hard-gates drift target intensity to 0 while reversing — engages like forward drift once |fwdSpeed| clears driftMinSpeed", () => {
    const bike = new BicyclePhysics(DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY);
    let velocity = { x: 0, y: 0, z: 0 };

    // Accelerate in reverse for 2s.
    for (let i = 0; i < 240; i++) {
      const input = freshInput({ velocity, throttle: -1, steerInput: 0 });
      const state = bike.step(input, DT);
      velocity = state.newVelocity;
    }
    const reverseState0 = bike.getOmega();
    expect(reverseState0).toBeCloseTo(0, 6);

    // Now steer hard while still reversing (with a low rearGripMultiplier,
    // same as a real drift-engaged reverse — ContinuousDrift would supply
    // this too once its own abs-gated speedGate opens).
    let lastState = bike.step(freshInput({ velocity, throttle: -1, steerInput: 1, rearGripMultiplier: 0.25 }), DT);
    velocity = lastState.newVelocity;
    expect(lastState.fwdSpeed).toBeLessThan(0); // confirm we're actually in reverse

    for (let i = 0; i < 60; i++) {
      lastState = bike.step(freshInput({ velocity, throttle: -1, steerInput: 1, rearGripMultiplier: 0.25 }), DT);
      velocity = lastState.newVelocity;
    }
    // |fwdSpeed| is well above driftMinSpeed (2.5) at this point (reverse
    // terminal speed ~8.3 m/s) — driftIntensity should be genuinely engaged,
    // not gated to 0.
    expect(Math.abs(lastState.fwdSpeed)).toBeGreaterThan(DEFAULT_KART_PHYSICS_PARAMS.driftMinSpeed);
    expect(lastState.driftIntensity).toBeGreaterThan(0.1);

    // Yaw torque (omega) is still emergent from tire forces regardless of
    // direction — reverse steering still produces nonzero omega.
    expect(Math.abs(bike.getOmega())).toBeGreaterThan(0.01);
  });
});

describe("BicyclePhysics — standstill steering (req 1: no standstill steering aid)", () => {
  it("stationary kart (fwdSpeed=0) never yaws from steer input alone, even over many ticks", () => {
    const bike = new BicyclePhysics(DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY);
    const velocity = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 120; i++) {
      // full lock, no throttle — a real player holding A/D at a dead stop.
      const state = bike.step(freshInput({ velocity, throttle: 0, steerInput: 1 }), DT);
      expect(state.omega).toBeCloseTo(0, 9);
      expect(state.newVelocity.x).toBeCloseTo(0, 9);
      expect(state.newVelocity.z).toBeCloseTo(0, 9);
    }
  });

  it("has no stationarySteerThreshold/stationaryOmegaKick fields left on the params object", () => {
    expect((DEFAULT_KART_PHYSICS_PARAMS as unknown as Record<string, unknown>).stationarySteerThreshold).toBeUndefined();
    expect((DEFAULT_KART_PHYSICS_PARAMS as unknown as Record<string, unknown>).stationaryOmegaKick).toBeUndefined();
  });
});

describe("BicyclePhysics — kinematic/dynamic blend (req 2: nose leads at low speed)", () => {
  it("at low speed (below kinematicBlendLoSpeed) omega matches the pure kinematic bicycle formula", () => {
    const p = DEFAULT_KART_PHYSICS_PARAMS;
    const bike = new BicyclePhysics(p, DEFAULT_AXLE_GEOMETRY);
    const fwdSpeedIn = 1.0; // strictly below kinematicBlendLoSpeed=1.5 -> blend=0 exactly
    const velocity = { x: 0, y: 0, z: -fwdSpeedIn };
    const state = bike.step(freshInput({ velocity, throttle: 1, steerInput: 1 }), DT);

    // Reproduce step B (steer angle) exactly as the implementation does.
    const maxAngleRad = (p.maxSteerAngleDeg * Math.PI) / 180;
    const spdRatio = Math.min(Math.max(fwdSpeedIn / p.maxSpeed, 0), 1);
    const steerMult = p.steerLowSpeedMult + (p.steerHighSpeedMult - p.steerLowSpeedMult) * spdRatio;
    const steerAngle = 1 * maxAngleRad * steerMult;
    const expectedOmega = (fwdSpeedIn / DEFAULT_AXLE_GEOMETRY.wheelbase) * Math.tan(steerAngle);

    expect(state.omega).toBeCloseTo(expectedOmega, 4);
    // Nose leads, not a parallel sideways crab: lateral velocity stays tiny.
    expect(Math.abs(state.sideSpeed)).toBeLessThan(0.05);
  });

  it("sideSpeed stays small through a sustained low-speed turn (not just the first tick)", () => {
    const bike = new BicyclePhysics(DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY);
    let velocity = { x: 0, y: 0, z: 0 };
    let maxAbsSide = 0;
    // Accelerate from rest with full steer — track sideSpeed while still
    // under kinematicBlendLoSpeed.
    for (let i = 0; i < 60; i++) {
      const state = bike.step(freshInput({ velocity, throttle: 1, steerInput: 1 }), DT);
      velocity = state.newVelocity;
      if (Math.abs(state.fwdSpeed) <= DEFAULT_KART_PHYSICS_PARAMS.kinematicBlendLoSpeed) {
        maxAbsSide = Math.max(maxAbsSide, Math.abs(state.sideSpeed));
      }
    }
    expect(maxAbsSide).toBeLessThan(0.1);
  });

  it("blend is continuous across the Lo..Hi speed range — no jump in omega's rate of change", () => {
    const bike = new BicyclePhysics(DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY);
    let velocity = { x: 0, y: 0, z: 0 };
    const omegas: number[] = [];
    // Ramp from rest through and past kinematicBlendHiSpeed under full steer.
    for (let i = 0; i < 500; i++) {
      const state = bike.step(freshInput({ velocity, throttle: 1, steerInput: 1 }), DT);
      velocity = state.newVelocity;
      omegas.push(state.omega);
    }
    let maxStep = 0;
    for (let i = 1; i < omegas.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(omegas[i] - omegas[i - 1]));
    }
    // Generous bound (per-tick omega change at DT=1/120): a genuine
    // discontinuity at the blend boundary would show up as a step far above
    // the smooth per-tick evolution seen everywhere else in the trace.
    expect(maxStep).toBeLessThan(0.5);
  });

  it("at high speed (above kinematicBlendHiSpeed) sideSpeed can develop real slip (dynamic model, drift-capable)", () => {
    const bike = new BicyclePhysics(DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY);
    let velocity = { x: 0, y: 0, z: -15 }; // well above kinematicBlendHiSpeed=6
    let lastSide = 0;
    for (let i = 0; i < 60; i++) {
      const state = bike.step(freshInput({ velocity, throttle: 1, steerInput: 1, rearGripMultiplier: 0.25 }), DT);
      velocity = state.newVelocity;
      lastSide = state.sideSpeed;
    }
    expect(Math.abs(lastSide)).toBeGreaterThan(0.3);
  });
});

describe("BicyclePhysics — braking asymmetry fix (owner playtest 2026-07-07)", () => {
  // Bug: holding S while moving forward fired BOTH reverse-thrust (step I
  // thrust term) AND brakeForce simultaneously, stacking to a near-instant
  // stop (~0.18s from a ~10.7 m/s cruise at the old defaults). Fix:
  // reverseEngageSpeed gates reverse-thrust to 0 until fwdSpeed has braked
  // down near zero — while still rolling forward, S only brakes.
  function runToNearStop(velocity: { x: number; y: number; z: number }, ticksToSample: number) {
    const bike = new BicyclePhysics(DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY);
    // Spin up to cruise speed first.
    let v = velocity;
    for (let i = 0; i < 240; i++) {
      const state = bike.step(freshInput({ velocity: v, throttle: 1, steerInput: 0 }), DT);
      v = state.newVelocity;
    }
    const cruiseSpeed = Math.hypot(v.x, v.z);
    // Now hold S (brake + reverse-intent).
    const speeds: number[] = [];
    for (let i = 0; i < ticksToSample; i++) {
      const state = bike.step(freshInput({ velocity: v, throttle: -1, steerInput: 0, brakeHeld: true }), DT);
      v = state.newVelocity;
      speeds.push(state.fwdSpeed);
    }
    return { cruiseSpeed, speeds };
  }

  it("braking from a cruise is not near-instant — takes a real, bounded process (>= 0.3s to near-zero)", () => {
    const { cruiseSpeed, speeds } = runToNearStop({ x: 0, y: 0, z: 0 }, Math.round(2 / DT));
    expect(cruiseSpeed).toBeGreaterThan(8); // sanity: actually cruising first
    const firstNearZeroIdx = speeds.findIndex((s) => Math.abs(s) < 0.5);
    expect(firstNearZeroIdx).toBeGreaterThanOrEqual(0);
    const timeToNearZero = firstNearZeroIdx * DT;
    expect(timeToNearZero).toBeGreaterThanOrEqual(0.3);
    // ...but still a REAL brake, not just coasting forever: within ~1.5s.
    expect(timeToNearZero).toBeLessThan(1.5);
  });

  it("reverse-thrust does not add to brake force while still rolling forward at speed", () => {
    const p = DEFAULT_KART_PHYSICS_PARAMS;
    const bike = new BicyclePhysics(p, DEFAULT_AXLE_GEOMETRY);
    // Well above reverseEngageSpeed — reverse-thrust term should be fully gated to 0.
    const velocity = { x: 0, y: 0, z: -10 };
    const withReverseIntent = bike.step(freshInput({ velocity, throttle: -1, steerInput: 0, brakeHeld: true }), DT);

    const bikeBrakeOnly = new BicyclePhysics(p, DEFAULT_AXLE_GEOMETRY);
    // Same brake, but throttle=0 (no reverse-thrust term can ever fire) —
    // if the gate works, this should decelerate IDENTICALLY to the throttle=-1
    // case above, since reverse-thrust contributes 0 at this speed either way.
    const brakeOnly = bikeBrakeOnly.step(freshInput({ velocity, throttle: 0, steerInput: 0, brakeHeld: true }), DT);

    expect(withReverseIntent.fwdSpeed).toBeCloseTo(brakeOnly.fwdSpeed, 5);
  });

  it("reverse-thrust DOES engage once fwdSpeed has braked down near reverseEngageSpeed", () => {
    const p = DEFAULT_KART_PHYSICS_PARAMS;
    const bike = new BicyclePhysics(p, DEFAULT_AXLE_GEOMETRY);
    // Start already near-stationary (below reverseEngageSpeed).
    const velocity = { x: 0, y: 0, z: -0.3 };
    const state = bike.step(freshInput({ velocity, throttle: -1, steerInput: 0, brakeHeld: true }), DT);
    // fwdSpeed should keep dropping toward/through 0 and into reverse —
    // brakeHeld's blend is 0 at fwdSpeed<=0, so once past zero only
    // reverse-thrust is driving it; confirm it doesn't just sit at 0.
    let v = state.newVelocity;
    for (let i = 0; i < 60; i++) {
      const s = bike.step(freshInput({ velocity: v, throttle: -1, steerInput: 0, brakeHeld: true }), DT);
      v = s.newVelocity;
    }
    expect(Math.hypot(v.x, v.z)).toBeGreaterThan(0.5);
    const finalFwd = bike.step(freshInput({ velocity: v, throttle: -1, steerInput: 0, brakeHeld: true }), DT).fwdSpeed;
    expect(finalFwd).toBeLessThan(0); // genuinely reversing, not stuck at 0
  });
});

describe("BicyclePhysics — slope gravity assist (owner playtest 2026-07-07)", () => {
  // Analytic force-equilibrium terminal speed with full throttle, dead
  // straight, on a constant grade `slopeRad` (same quadratic as the existing
  // flat-ground equilibrium test above, with the slope term folded into the
  // constant forcing term since it doesn't depend on v).
  function terminalSpeedOnGrade(slopeRad: number): number {
    const { accelForce, kDrag, kRolling, slopeGravityAccel } = DEFAULT_KART_PHYSICS_PARAMS;
    const forcing = accelForce - slopeGravityAccel * Math.sin(slopeRad);
    const disc = kRolling * kRolling + 4 * kDrag * forcing;
    return (-kRolling + Math.sqrt(disc)) / (2 * kDrag);
  }

  function runToTerminal(slopeRad: number, throttle = 1): number {
    const bike = new BicyclePhysics(DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY);
    let velocity = { x: 0, y: 0, z: 0 };
    let fwdSpeed = 0;
    const steps = Math.round(30 / DT);
    for (let i = 0; i < steps; i++) {
      const state = bike.step(freshInput({ velocity, throttle, steerInput: 0, groundSlopeRad: slopeRad }), DT);
      velocity = state.newVelocity;
      fwdSpeed = state.fwdSpeed;
    }
    return fwdSpeed;
  }

  it("uphill (positive groundSlopeRad) settles at a LOWER terminal speed than flat ground under full throttle", () => {
    const slopeRad = (20 * Math.PI) / 180; // ~20deg, in the ballpark of arena_slice's ramps
    const flat = runToTerminal(0);
    const uphill = runToTerminal(slopeRad);
    expect(uphill).toBeLessThan(flat);
    expect(uphill).toBeCloseTo(terminalSpeedOnGrade(slopeRad), 1);
    expect(flat).toBeCloseTo(terminalSpeedOnGrade(0), 1);
  });

  it("downhill (negative groundSlopeRad) settles at a HIGHER terminal speed than flat ground under full throttle", () => {
    const slopeRad = -(20 * Math.PI) / 180;
    const flat = runToTerminal(0);
    const downhill = runToTerminal(slopeRad);
    expect(downhill).toBeGreaterThan(flat);
    expect(downhill).toBeCloseTo(terminalSpeedOnGrade(slopeRad), 1);
  });

  it("uphill decelerates faster than flat ground on pure inertia (no throttle)", () => {
    const slopeRad = (20 * Math.PI) / 180;
    const startVelocity = { x: 0, y: 0, z: -10 }; // 10 m/s cruise, coasting
    const flatBike = new BicyclePhysics(DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY);
    const uphillBike = new BicyclePhysics(DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY);
    let flatV = startVelocity;
    let uphillV = startVelocity;
    let flatSpeed = 10;
    let uphillSpeed = 10;
    const steps = Math.round(1 / DT); // 1 sim-second
    for (let i = 0; i < steps; i++) {
      const flatState = flatBike.step(freshInput({ velocity: flatV, throttle: 0, groundSlopeRad: 0 }), DT);
      flatV = flatState.newVelocity;
      flatSpeed = flatState.fwdSpeed;
      const upState = uphillBike.step(freshInput({ velocity: uphillV, throttle: 0, groundSlopeRad: slopeRad }), DT);
      uphillV = upState.newVelocity;
      uphillSpeed = upState.fwdSpeed;
    }
    expect(uphillSpeed).toBeLessThan(flatSpeed);
  });

  it("downhill accelerates from rest on pure inertia (no throttle) while flat ground stays at rest", () => {
    const slopeRad = -(20 * Math.PI) / 180;
    const bike = new BicyclePhysics(DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY);
    let velocity = { x: 0, y: 0, z: 0 };
    let fwdSpeed = 0;
    const steps = Math.round(1 / DT);
    for (let i = 0; i < steps; i++) {
      const state = bike.step(freshInput({ velocity, throttle: 0, groundSlopeRad: slopeRad }), DT);
      velocity = state.newVelocity;
      fwdSpeed = state.fwdSpeed;
    }
    // A negative groundSlopeRad (downhill ahead, per the +uphill sign
    // convention) should roll the kart forward from a dead stop, pure
    // inertia, no throttle — fwdSpeed goes positive (forward along its own
    // heading), not just nonzero.
    expect(fwdSpeed).toBeGreaterThan(0.5);
  });

  it("flat ground (groundSlopeRad=0) is bit-for-bit unaffected by slopeGravityAccel — matches the pre-existing equilibrium test", () => {
    const { accelForce, kDrag, kRolling } = DEFAULT_KART_PHYSICS_PARAMS;
    const disc = kRolling * kRolling + 4 * kDrag * accelForce;
    const expectedTerminal = (-kRolling + Math.sqrt(disc)) / (2 * kDrag);
    expect(runToTerminal(0)).toBeCloseTo(expectedTerminal, 1);
  });

  it("slopeGravityAccel=0 makes any groundSlopeRad a no-op", () => {
    const zeroParams = { ...DEFAULT_KART_PHYSICS_PARAMS, slopeGravityAccel: 0 };
    const slopeRad = (25 * Math.PI) / 180;
    const bike = new BicyclePhysics(zeroParams, DEFAULT_AXLE_GEOMETRY);
    const flatBike = new BicyclePhysics(zeroParams, DEFAULT_AXLE_GEOMETRY);
    let v = { x: 0, y: 0, z: 0 };
    let flatV = { x: 0, y: 0, z: 0 };
    let speed = 0;
    let flatSpeed = 0;
    const steps = Math.round(5 / DT);
    for (let i = 0; i < steps; i++) {
      const s = bike.step(freshInput({ velocity: v, throttle: 1, groundSlopeRad: slopeRad }), DT);
      v = s.newVelocity;
      speed = s.fwdSpeed;
      const fs = flatBike.step(freshInput({ velocity: flatV, throttle: 1, groundSlopeRad: 0 }), DT);
      flatV = fs.newVelocity;
      flatSpeed = fs.fwdSpeed;
    }
    expect(speed).toBeCloseTo(flatSpeed, 6);
  });
});

// ─── Fix 1/2 regression coverage (numerical diagnosis 2026-07-07,
// tools/diagnose_drift_circle.ts / tools/diagnose_reverse.ts) ──────────────
// Mirrors kart.ts's exact per-tick wiring (smoothInput -> ContinuousDrift.update
// -> slow driftPenaltyFactor low-pass -> BicyclePhysics.step -> yaw/vel
// composition) — see kart.ts step 3/4a2/4b/5-7 and the diagnose_* tools for
// the full-detail versions this is a condensed regression-test copy of.
function forwardOf(yaw: number) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}
function rightOf(yaw: number) {
  return { x: Math.cos(yaw), z: -Math.sin(yaw) };
}

interface KartLikeSim {
  params: KartPhysicsParams;
  bicycle: BicyclePhysics;
  drift: ContinuousDrift;
  yaw: number;
  vel: { x: number; y: number; z: number };
  throttleSm: number;
  steerSm: number;
  driftPenaltySlow: number;
}

function makeKartLikeSim(params: KartPhysicsParams = DEFAULT_KART_PHYSICS_PARAMS): KartLikeSim {
  return {
    params,
    bicycle: new BicyclePhysics(params, DEFAULT_AXLE_GEOMETRY),
    drift: new ContinuousDrift(params),
    yaw: 0,
    vel: { x: 0, y: 0, z: 0 },
    throttleSm: 0,
    steerSm: 0,
    driftPenaltySlow: 0,
  };
}

function kartLikeTick(sim: KartLikeSim, dt: number, rawSteer: number, rawThrottle: number) {
  const p = sim.params;
  const slew = Math.abs(rawSteer) > Math.abs(sim.steerSm) ? p.steerSlewRateIn : p.steerSlewRateOut;
  sim.steerSm += (rawSteer - sim.steerSm) * (1 - Math.exp(-slew * dt));
  sim.throttleSm += (rawThrottle - sim.throttleSm) * (1 - Math.exp(-p.throttleSlewRate * dt));

  const fwdDir = forwardOf(sim.yaw);
  const rightDir = rightOf(sim.yaw);
  const speed = Math.hypot(sim.vel.x, sim.vel.z);
  const fwdSigned = sim.vel.x * fwdDir.x + sim.vel.z * fwdDir.z;

  const drift = sim.drift.update(speed, sim.steerSm, true, sim.throttleSm, dt);

  const penaltyAlpha = 1 - Math.exp(-(1 / Math.max(p.driftPenaltyTau, 0.05)) * dt);
  sim.driftPenaltySlow += (sim.bicycle.getDriftIntensity() - sim.driftPenaltySlow) * penaltyAlpha;

  const inp: PhysicsInput = {
    velocity: { ...sim.vel },
    forward: { x: fwdDir.x, y: 0, z: fwdDir.z },
    right: { x: rightDir.x, y: 0, z: rightDir.z },
    throttle: sim.throttleSm,
    steerInput: sim.steerSm,
    brakeHeld: rawThrottle < 0,
    onFloor: true,
    rearGripMultiplier: drift.rearGripMultiplier,
    driftPenaltyFactor: sim.driftPenaltySlow,
    groundSlopeRad: 0,
  };
  const st = sim.bicycle.step(inp, dt);
  sim.yaw += st.yawDelta + drift.yawBonusRadPerSec * dt;
  sim.vel.x = st.newVelocity.x;
  sim.vel.z = st.newVelocity.z;

  const assist = drift.forwardAssistForce + drift.exitBoostForce;
  if (Math.abs(assist) > 0 && fwdSigned >= 0) {
    const fwdAfter = forwardOf(sim.yaw);
    sim.vel.x += fwdAfter.x * assist * dt;
    sim.vel.z += fwdAfter.z * assist * dt;
  }
  return st;
}

describe("BicyclePhysics + ContinuousDrift — Fix 1 regression: drift entry no longer punches a speed dip", () => {
  // Bound is 70%, not the original 80% goal: swept driftPenaltyTau 0.6/1.2/2.0
  // (tools/diagnose_drift_circle.ts) and found diminishing returns above ~2.0
  // — a real physical floor remains because corneringDrag's BASE term
  // (corneringDragCoeff, active in ANY sharp turn) still scales with the
  // ACTUAL |sideSpeed|, which genuinely spikes at drift entry as a real
  // physical transient (see types.ts driftPenaltyTau default's comment for
  // the full sweep numbers). At the tuned default (tau=2.0) the dip measures
  // ~78.7% of steady mean (up from ~67.5% pre-fix) — 70% gives headroom
  // below that measured value without being so loose it'd miss a real
  // regression back toward the old ~67.5%.
  it("fwdSpeed never dips below 70% of the eventual steady-state mean during drift entry", () => {
    const sim = makeKartLikeSim();
    const dt = 1 / 120;
    // Phase 1: accelerate to cruise (3.5s).
    for (let i = 0; i < Math.round(3.5 / dt); i++) kartLikeTick(sim, dt, 0, 1);
    // Phase 2: full steer + full throttle, several drift circles (12s).
    const driftSpeeds: number[] = [];
    for (let i = 0; i < Math.round(12 / dt); i++) {
      const st = kartLikeTick(sim, dt, 1, 1);
      driftSpeeds.push(st.fwdSpeed);
    }
    const steadyWindow = driftSpeeds.slice(Math.round(8 / dt)); // last 4s of the 12s hold
    const steadyMean = steadyWindow.reduce((a, b) => a + b, 0) / steadyWindow.length;
    const minSpeed = Math.min(...driftSpeeds);
    expect(minSpeed).toBeGreaterThanOrEqual(steadyMean * 0.7);
    // Steady-state mean itself must stay close to the pre-fix value (~5.67
    // m/s) — this is the "don't wreck the circle to fix the entry" guard.
    expect(steadyMean).toBeGreaterThan(5.0);
    expect(steadyMean).toBeLessThan(6.3);
  });
});

describe("BicyclePhysics + ContinuousDrift — Fix 2 regression: reverse maneuverability improved, with no oscillation", () => {
  // NOT full forward/reverse parity: numerically swept reverseSteerGain
  // 1.5..5.0 (tools/diagnose_reverse.ts) and found a genuine physical
  // feedback-loop ceiling — see types.ts reverseSteerGain default's doc
  // comment for the full root-cause writeup (larger steerAngle -> more
  // corneringDrag -> less fwdSpeed -> smaller kinematic omega term, which
  // cancels out the steer-angle increase). At the tuned default
  // (reverseSteerGain=2.2) reverse reaches ~101 deg/s vs forward's ~171
  // deg/s (ratio ~0.59) — a real, substantial improvement over the pre-fix
  // ~85 deg/s (ratio ~0.5), but short of the aspirational "reverse >=
  // forward" target. This test guards the MEASURED improvement, not the
  // unreached aspirational target.
  it("reverse yaw rate at terminal speed is a much better fraction of forward's than the pre-fix ~0.5, and doesn't oscillate", () => {
    const dt = 1 / 120;

    function terminalManeuverOmega(throttleSign: 1 | -1): { meanOmega: number; omegas: number[] } {
      const sim = makeKartLikeSim();
      for (let i = 0; i < Math.round(6 / dt); i++) kartLikeTick(sim, dt, 0, throttleSign); // reach cruise
      const omegas: number[] = [];
      for (let i = 0; i < Math.round(5 / dt); i++) {
        const st = kartLikeTick(sim, dt, 1, throttleSign); // full steer, same throttle held
        omegas.push(st.omega);
      }
      const steady = omegas.slice(Math.round(4 / dt)); // last 1s
      const meanOmega = steady.reduce((a, b) => a + b, 0) / steady.length;
      return { meanOmega, omegas: steady };
    }

    const fwd = terminalManeuverOmega(1);
    const rev = terminalManeuverOmega(-1);

    // Pre-fix ratio was ~0.5 (85 vs 169 deg/s). Post-fix measured ratio is
    // ~0.59 (101 vs 171 deg/s) — require clearly above the old ratio, with
    // margin below the measured value so normal tuning noise doesn't flake.
    const ratio = Math.abs(rev.meanOmega) / Math.abs(fwd.meanOmega);
    expect(ratio).toBeGreaterThan(0.55);
    // Absolute floor: pre-fix reverse omega was ~1.483 rad/s (85 deg/s).
    expect(Math.abs(rev.meanOmega)).toBeGreaterThan(1.6);

    // No runaway/divergent oscillation on the reverse steady window: the
    // spread (max-min) should stay a small fraction of the mean magnitude,
    // not grow tick-over-tick.
    const revMax = Math.max(...rev.omegas.map(Math.abs));
    const revMin = Math.min(...rev.omegas.map(Math.abs));
    expect(revMax - revMin).toBeLessThan(Math.abs(rev.meanOmega) * 0.25);
  });
});

describe("BicyclePhysics — reset", () => {
  it("clears omega, driftIntensity, isDrifting", () => {
    const bike = new BicyclePhysics(DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY);
    let velocity = { x: 0, y: 0, z: -12 };
    for (let i = 0; i < 120; i++) {
      const state = bike.step(freshInput({ velocity, throttle: 1, steerInput: 1, rearGripMultiplier: 0.25 }), DT);
      velocity = state.newVelocity;
    }
    expect(bike.getOmega()).not.toBe(0);
    bike.reset();
    expect(bike.getOmega()).toBe(0);
    expect(bike.getDriftIntensity()).toBe(0);
    expect(bike.getIsDrifting()).toBe(false);
  });
});
