// Two-axle bicycle physics model with saturating tire forces.
//
// 1:1 TypeScript port of scripts/physics/bicycle_physics.gd (v3.0). Pure
// compute module — no scene graph / three.js Object3D access. Caller builds
// a PhysicsInput each tick, calls step(), then applies the returned
// PhysicsState back to its own body representation.
//
// Persistent state between ticks: _omega, _driftIntensity, _isDrifting —
// mirrors the GDScript class's instance fields.
//
// KNOWN DIVERGENCE FROM design/gdd/kart-physics.md (flagged, not fixed here):
// The GDD's "Per-Wheel Lateral Velocity" section documents rear-left/rear-right
// lateral velocities differentiated by `± omega * half_track`. The actual
// bicycle_physics.gd implementation (ported faithfully below) does NOT apply
// a half_track term — both rear wheels read the same v_lat_rear value, with
// an inline comment explaining that visual arc divergence is expected to
// come from per-wheel WORLD POSITION combined with body rotation, not from
// different body-frame lateral velocities. This port follows the actual
// .gd code (source of truth for a straight port), not the GDD prose. See
// the accompanying test file for the concrete numbers and a flag for
// game-designer/systems-designer to reconcile the doc.

import type { AxleGeometry, KartPhysicsParams, PhysicsInput, PhysicsState, Vec3 } from "./types";
import { DEFAULT_AXLE_GEOMETRY } from "./types";

function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// smoothstep(lo, hi, x) — same semantics as Godot's built-in.
function smoothstep(lo: number, hi: number, x: number): number {
  if (lo === hi) return x < lo ? 0 : 1;
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

export class BicyclePhysics {
  private params: KartPhysicsParams;
  private wheelbase: number;
  private halfTrack: number;

  private omega = 0; // yaw angular velocity (rad/s)
  private driftIntensity = 0; // smoothed [0..1]
  private isDriftingFlag = false; // hysteresis flag

  constructor(params: KartPhysicsParams, geometry: AxleGeometry = DEFAULT_AXLE_GEOMETRY) {
    this.params = params;
    this.wheelbase = Math.max(geometry.wheelbase, 0.1);
    this.halfTrack = Math.max(geometry.trackWidth * 0.5, 0.05);
  }

  setAxleGeometry(wheelbase: number, trackWidth: number): void {
    this.wheelbase = Math.max(wheelbase, 0.1);
    this.halfTrack = Math.max(trackWidth * 0.5, 0.05);
  }

  reset(): void {
    this.omega = 0;
    this.driftIntensity = 0;
    this.isDriftingFlag = false;
  }

  getOmega(): number {
    return this.omega;
  }

  getDriftIntensity(): number {
    return this.driftIntensity;
  }

  getIsDrifting(): boolean {
    return this.isDriftingFlag;
  }

  // ─── Main step ─────────────────────────────────────────────────────────────
  step(inp: PhysicsInput, delta: number): PhysicsState {
    const p = this.params;

    // A. Decompose velocity in current basis.
    const fwdDir = inp.forward;
    const sideDir = inp.right;
    let fwdSpeed = dot(inp.velocity, fwdDir);
    let sideSpeed = dot(inp.velocity, sideDir);

    // B. Steer angle from input. Speed-dependent reduction: full lock at
    // standstill, narrower lock at top speed.
    const maxAngleRad = degToRad(p.maxSteerAngleDeg);
    const spdRatio = clamp(Math.abs(fwdSpeed) / Math.max(p.maxSpeed, 0.01), 0, 1);
    const steerMult = lerp(p.steerLowSpeedMult, p.steerHighSpeedMult, spdRatio);
    const steerAngle = inp.steerInput * maxAngleRad * steerMult;

    // C. Per-axle lateral velocities. Bicycle model: v_at_point = v_body + ω × r_point.
    // Godot conventions: forward = -Z, right = +X, up = +Y. See bicycle_physics.gd
    // header comment for the full sign derivation.
    const halfWb = this.wheelbase * 0.5;
    const { front: vLatFront, rear: vLatRear } = computeAxleLateralVelocities(sideSpeed, this.omega, halfWb);

    // D. Front tire lateral velocity in WHEEL frame (rotated from body by steer_angle).
    const vWheelLatFront = vLatFront * Math.cos(steerAngle) + fwdSpeed * Math.sin(steerAngle);

    // E. Saturating tire lateral forces. f = -grip * tanh(v_lat / sat) * sat.
    const sat = Math.max(p.tireSaturationSpeed, 0.1);
    const rearGripEff = p.rearGripStiffness * Math.max(inp.rearGripMultiplier, 0);
    const fFront = -p.frontGripStiffness * tanh(vWheelLatFront / sat) * sat;
    const fRearPerWheel = -rearGripEff * tanh(vLatRear / sat) * sat;
    const fRearTotal = 2 * fRearPerWheel; // both rear wheels share the same body-frame lat vel

    // Slip angles (debug output only).
    const fwdClamp = Math.max(Math.abs(fwdSpeed), 0.5);
    const alphaFront = Math.atan2(vLatFront, fwdClamp) - steerAngle;
    const alphaRear = Math.atan2(vLatRear, fwdClamp);
    // Per-rear-wheel slip exposed for VFX. See class-level comment: both
    // wheels currently share the same body-frame lat vel in this port,
    // matching bicycle_physics.gd exactly.
    const vLatRearL = vLatRear;
    const vLatRearR = vLatRear;

    // F. Yaw torque integration (dynamic / tire-slip model).
    // τ_y = -half_wb × F_front_x + half_wb × F_rear_x = half_wb × (F_rear - F_front)
    const torque = (fRearTotal - fFront) * halfWb;
    const moi = p.mass * (halfWb * halfWb) * Math.max(p.inertiaScale, 0.01);
    const omegaAccel = torque / Math.max(moi, 0.001);
    let omegaDynamic = this.omega + omegaAccel * delta;

    // Angular damping — framerate-independent exponential decay.
    omegaDynamic *= Math.exp(-p.omegaDamping * delta);

    // G. Kinematic bicycle blend (low-speed nose-tracking).
    // At low speed the saturating tire model produces tiny slip angles → tiny
    // lateral forces → tiny yaw torque, so the dynamic model alone barely
    // turns the car's nose even at full lock — yet that same weak front
    // force still pushes sideSpeed sideways (step H), so the whole body
    // appears to crab sideways instead of pivoting. Fix: blend the dynamic
    // torque-integrated omega toward the classic KINEMATIC bicycle model
    // (omega = fwdSpeed * tan(steerAngle) / wheelbase — the car's reference
    // point exactly tracks the steered wheel angle, zero slip by
    // construction) as speed drops. `blend` is a smoothstep of |fwdSpeed|:
    // 0 (fully kinematic, nose leads exactly) at/under
    // kinematicBlendLoSpeed, 1 (fully dynamic tire-slip model, drift-capable)
    // at/over kinematicBlendHiSpeed. No standalone "standstill steering aid"
    // is needed anymore — at fwdSpeed=0 the kinematic formula itself is 0,
    // so a stationary kart never yaws from steering input alone.
    const kinematicOmega = (fwdSpeed / this.wheelbase) * Math.tan(steerAngle);
    const kinematicBlend = smoothstep(p.kinematicBlendLoSpeed, p.kinematicBlendHiSpeed, Math.abs(fwdSpeed));
    this.omega = lerp(kinematicOmega, omegaDynamic, kinematicBlend);

    // H. Apply lateral tire forces to body velocity — muted in the kinematic
    // zone (see step G): a car turning purely by kinematic nose-tracking
    // shouldn't ALSO be shoved sideways by the tire force whose yaw
    // contribution we just overrode. `kinematicLateralMute` is the residual
    // fraction of that push still felt at full-kinematic speeds (small, not
    // necessarily zero, for a touch of low-speed feel); it fades to full
    // (1.0) strength together with the dynamic model by kinematicBlendHiSpeed.
    const lateralMute = lerp(p.kinematicLateralMute, 1, kinematicBlend);
    const fTotalLat = fFront + fRearTotal;
    sideSpeed += ((fTotalLat * lateralMute) / Math.max(p.mass, 0.001)) * delta;

    // I. Longitudinal forces.
    // Reverse-thrust is gated by CURRENT forward speed (reverseEngageGate):
    // while still rolling forward, holding the brake/reverse key (S) should
    // only brake (see `brake` below) — exactly like a real car braking to a
    // stop before reverse gear engages. Without this gate, thrust and brake
    // fired simultaneously the instant S was pressed (thrust up to
    // accelForce*reverseRatio ADDED to brakeForce), which is what made
    // braking from a cruise feel near-instant instead of a real deceleration
    // process (owner playtest feedback). The gate is a smoothstep of
    // fwdSpeed itself (continuous, no discrete flip) — full reverse thrust
    // only once fwdSpeed has coasted/braked down to ~reverseEngageSpeed.
    let thrust = 0;
    if (inp.throttle > 0.01) {
      thrust = inp.throttle * p.accelForce;
    } else if (inp.throttle < -0.01) {
      const reverseEngageGate = smoothstep(p.reverseEngageSpeed, 0, fwdSpeed);
      thrust = inp.throttle * p.accelForce * p.reverseRatio * reverseEngageGate;
    }

    const dragMult = lerp(1, p.driftDragMultiplier, this.driftIntensity);
    const rollingMult = lerp(1, p.driftRollingMultiplier, this.driftIntensity);
    const drag = -Math.sign(fwdSpeed) * p.kDrag * dragMult * fwdSpeed * fwdSpeed;
    const rolling = -p.kRolling * rollingMult * fwdSpeed;
    // Continuous force blends (smooth-values rule): no discrete jumps on
    // continuous physics terms. cornering_drag fades in across [0..0.2] m/s.
    // corneringDragCoeff alone is the ORDINARY-turn braking (kept gentle so
    // coasting through a turn doesn't nearly stop the kart); it's scaled up
    // by corneringDragDriftMult while an actual drift is active so THAT loses
    // noticeably more speed than a plain turn. Reads last tick's
    // driftIntensity — same one-tick-lag pattern as dragMult/rollingMult
    // just above, already an established convention in this step.
    let corneringDrag = 0;
    if (p.corneringDragCoeff > 0) {
      const cdBlend = smoothstep(0, 0.2, Math.abs(fwdSpeed));
      const cdDriftScale = lerp(1, p.corneringDragDriftMult, this.driftIntensity);
      corneringDrag = -Math.sign(fwdSpeed) * p.corneringDragCoeff * cdDriftScale * Math.abs(sideSpeed) * 0.5 * cdBlend;
    }
    // brake force blends in across [0..0.6] m/s.
    let brake = 0;
    if (inp.brakeHeld) {
      const brakeBlend = smoothstep(0, 0.6, fwdSpeed);
      brake = -p.brakeForce * brakeBlend;
    }

    fwdSpeed += (thrust + drag + rolling + corneringDrag + brake) * delta;
    if (Math.abs(thrust) < 0.01 && Math.abs(fwdSpeed) < 0.1) {
      fwdSpeed = 0;
    }

    // J. Drift intensity — derived from the faster-sliding rear wheel.
    const rearSlipMag = Math.max(Math.abs(vLatRearL), Math.abs(vLatRearR));
    const slipRatio = computeSlipRatio(rearSlipMag, p.driftMaxSlipSpeed);

    let targetIntensity = 0;
    if (fwdSpeed >= p.driftMinSpeed) {
      targetIntensity = slipRatio;
    }
    const alpha = 1 - Math.exp(-p.slipSmoothing * delta);
    this.driftIntensity = clamp(lerp(this.driftIntensity, targetIntensity, alpha), 0, 1);

    // K. isDrifting hysteresis (±0.02 around driftActiveThreshold). Discrete
    // on-off flip is fine here — VFX/audio trigger only, not physics.
    const hystHigh = p.driftActiveThreshold + 0.02;
    const hystLow = p.driftActiveThreshold - 0.02;
    if (this.isDriftingFlag) {
      if (this.driftIntensity < hystLow) this.isDriftingFlag = false;
    } else {
      if (this.driftIntensity > hystHigh) this.isDriftingFlag = true;
    }

    // L. Pack output state.
    const newVelocity = vec3(
      fwdDir.x * fwdSpeed + sideDir.x * sideSpeed,
      inp.velocity.y,
      fwdDir.z * fwdSpeed + sideDir.z * sideSpeed
    );

    return {
      newVelocity,
      yawDelta: this.omega * delta,
      omega: this.omega,
      fwdSpeed,
      sideSpeed,
      rearLeftLatSpeed: vLatRearL,
      rearRightLatSpeed: vLatRearR,
      slipAngleFrontDeg: radToDeg(alphaFront),
      slipAngleRearDeg: radToDeg(alphaRear),
      driftIntensity: this.driftIntensity,
      isDrifting: this.isDriftingFlag,
      slipRatio,
      gripDebug: p.rearGripStiffness * (1 - this.driftIntensity * 0.7),
    };
  }
}

// Hyperbolic tangent. JS has Math.tanh natively (unlike GDScript) — used
// directly here. Kept as a named export in case a future substep needs the
// same overflow-guarded shape the GDScript port used; Math.tanh already
// handles overflow correctly (returns ±1 for large |x|) so no manual guard
// is needed.
export function tanh(x: number): number {
  return Math.tanh(x);
}

// ─── Pure formula helpers (extracted for unit testing) ──────────────────────
// These mirror bicycle_physics.gd steps C and J exactly. Extracted as
// standalone functions (rather than inlined only in step()) purely so tests
// can assert against a specific formula step without needing to drive a full
// step() call through the tire-force feedback loop.

// Step C: per-axle lateral velocities, front and rear.
// NOTE: matches the ACTUAL bicycle_physics.gd v3.0 code — both rear wheels
// share the same rear value (no half_track term). See the file-level
// "KNOWN DIVERGENCE" comment above for why this differs from the GDD prose.
export function computeAxleLateralVelocities(
  sideSpeed: number,
  omega: number,
  halfWb: number
): { front: number; rear: number } {
  return {
    front: sideSpeed - omega * halfWb,
    rear: sideSpeed + omega * halfWb,
  };
}

// Step J (first half): raw slip ratio normalized to driftMaxSlipSpeed, clamped [0,1].
export function computeSlipRatio(rearSlipMag: number, driftMaxSlipSpeed: number): number {
  return clamp(rearSlipMag / Math.max(driftMaxSlipSpeed, 0.01), 0, 1);
}
