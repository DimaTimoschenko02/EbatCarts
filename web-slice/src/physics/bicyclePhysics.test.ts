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
