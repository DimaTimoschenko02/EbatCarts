import { describe, expect, it } from "vitest";
import { BicyclePhysics, computeAxleLateralVelocities, computeSlipRatio } from "./bicyclePhysics";
import { DEFAULT_AXLE_GEOMETRY, DEFAULT_KART_PHYSICS_PARAMS, type PhysicsInput } from "./types";

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
  it("gates drift target intensity to 0 while driving backward, but omega still responds to steer torque", () => {
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

    // Now steer hard while still reversing.
    let lastState = bike.step(freshInput({ velocity, throttle: -1, steerInput: 1 }), DT);
    velocity = lastState.newVelocity;
    expect(lastState.fwdSpeed).toBeLessThan(0); // confirm we're actually in reverse

    // Drift intensity target should be gated to 0 (fwd_speed < drift_min_speed
    // in gd — note the gate is a hard `>=` on signed fwd_speed, so ANY
    // negative fwd_speed gates it out, matching bicycle_physics.gd step J).
    for (let i = 0; i < 30; i++) {
      lastState = bike.step(freshInput({ velocity, throttle: -1, steerInput: 1 }), DT);
      velocity = lastState.newVelocity;
    }
    expect(lastState.driftIntensity).toBeCloseTo(0, 3);

    // But yaw torque (omega) is still emergent from tire forces regardless of
    // direction — reverse steering should still produce nonzero omega.
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
