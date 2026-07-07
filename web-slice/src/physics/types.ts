// Ported from scripts/physics/{bicycle_physics.gd, drift_state_machine.gd,
// physics_input.gd, physics_state.gd, kart_physics_resource.gd} — see
// design/gdd/kart-physics.md and design/gdd/kart-physics-v3.2-thermal-fade.md.
//
// Axis convention (matches Godot): forward = -Z, right = +X, up = +Y.
// Yaw is rotation around +Y; positive omega = CCW from above = LEFT turn.
// Callers (three.js layer) must supply `forward`/`right` unit vectors already
// expressed in this convention — see src/main.ts for the yaw→vector mapping.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ─── Params (KartPhysicsResource) ───────────────────────────────────────────
// All numeric defaults below are the CURRENT tuned values from dev_params.json
// at the repo root (NOT the stale defaults baked into kart_physics_resource.gd,
// and NOT the design/gdd/kart-physics.md prose defaults — dev_params.json is
// the actively-tuned source of truth per project convention).
export interface KartPhysicsParams {
  // Speed (force-based)
  maxSpeed: number; // MAX_SPEED
  accelForce: number; // ACCEL_FORCE
  kDrag: number; // K_DRAG
  kRolling: number; // K_ROLLING
  brakeForce: number; // BRAKE_FORCE
  reverseRatio: number; // REVERSE_RATIO

  // Input smoothing (applied by caller before building PhysicsInput — see
  // kart_controller.gd _smooth_input; kept here so the web port has the same
  // single source of tunable numbers as the GDScript resource).
  steerSlewRateIn: number; // STEER_SLEW_IN
  steerSlewRateOut: number; // STEER_SLEW_OUT
  throttleSlewRate: number; // THROTTLE_SLEW

  // Steering
  steerLowSpeedMult: number; // STEER_LOW_MULT
  steerHighSpeedMult: number; // STEER_HIGH_MULT

  // Bicycle v3.0 (two-axle)
  maxSteerAngleDeg: number; // MAX_STEER_ANGLE_DEG
  frontGripStiffness: number; // FRONT_GRIP
  rearGripStiffness: number; // REAR_GRIP
  tireSaturationSpeed: number; // TIRE_SATURATION
  inertiaScale: number; // INERTIA_SCALE
  omegaDamping: number; // OMEGA_DAMPING
  driftMaxSlipSpeed: number; // DRIFT_MAX_SLIP_SPEED
  omegaLeanScale: number; // OMEGA_LEAN_SCALE (visual only, kept for parity)

  // Kinematic/dynamic blend (low-speed nose-tracking — replaces the old
  // "standstill steering aid" hack; see bicyclePhysics.ts step G/H).
  kinematicBlendLoSpeed: number; // KINEMATIC_BLEND_LO_SPEED — at/under this, pure kinematic (no slip)
  kinematicBlendHiSpeed: number; // KINEMATIC_BLEND_HI_SPEED — at/over this, pure dynamic tire model
  kinematicLateralMute: number; // KINEMATIC_LATERAL_MUTE — residual tire-force sideways push at full-kinematic speed

  // Drift signal shaping (bicycle_physics.gd J/K steps)
  driftMinSpeed: number; // DRIFT_MIN_SPEED
  slipSmoothing: number; // SLIP_SMOOTHING
  driftActiveThreshold: number; // DRIFT_ACTIVE_THRESHOLD
  driftDragMultiplier: number; // DRIFT_DRAG_MULTIPLIER
  driftRollingMultiplier: number; // DRIFT_ROLLING_MULTIPLIER
  corneringDragCoeff: number; // CORNERING_DRAG_COEFF
  corneringDragDriftMult: number; // CORNERING_DRAG_DRIFT_MULT — extra multiplier while actively drifting

  // Collision / mass — not exposed in dev_params.json (tuner doesn't surface
  // it yet); keep the kart_physics_resource.gd default.
  mass: number;

  // Drift State Machine v3.1 (auto-trigger)
  autoDriftEnabled: boolean; // AUTO_DRIFT_ENABLED
  driftVisualSmoothRate: number; // DRIFT_VISUAL_SMOOTH_RATE [deprecated v3.1.1, but still used on the auto_drift_enabled=false idle-decay path]
  driftEnterSteer: number; // DRIFT_ENTER_STEER
  driftEnterSpeed: number; // DRIFT_ENTER_SPEED
  driftEnterDebounce: number; // DRIFT_ENTER_DEBOUNCE
  driftExitSteer: number; // DRIFT_EXIT_STEER
  driftExitSpeed: number; // DRIFT_EXIT_SPEED
  driftExitDuration: number; // DRIFT_EXIT_DURATION
  driftVisualOffsetDeg: number; // DRIFT_VISUAL_OFFSET_DEG
  driftEngageInRate: number; // DRIFT_ENGAGE_IN_RATE
  driftEngageOutRate: number; // DRIFT_ENGAGE_OUT_RATE
  driftRecoveryRate: number; // DRIFT_RECOVERY_RATE
  driftExitGripMult: number; // DRIFT_EXIT_GRIP_MULT
  driftRearGripMult: number; // DRIFT_REAR_GRIP_MULT
  driftYawBonus: number; // DRIFT_YAW_BONUS
  driftForwardAssist: number; // DRIFT_FORWARD_ASSIST
  driftPowerFullTime: number; // DRIFT_POWER_FULL_TIME
  driftMinActiveForBoost: number; // DRIFT_MIN_ACTIVE_FOR_BOOST
  driftExitBoostForce: number; // DRIFT_EXIT_BOOST_FORCE
  driftExitBoostDuration: number; // DRIFT_EXIT_BOOST_DURATION

  // Visuals (consumed by the render layer, not by the physics step —
  // kept here so all tunables live in one params object like KartPhysicsResource)
  visualDriftMaxDeg: number; // VISUAL_DRIFT_MAX_DEG
  visualLeanRecoverySpeed: number; // VISUAL_LEAN_RECOVERY_SPEED

  // Continuous Drift v4.0 (replaces the v3.1 state machine — no discrete
  // states in physics; see systems-designer spec). Gate LO/HI pairs reuse
  // the old enter/exit threshold numbers as smoothstep bounds.
  driftSteerGateLo: number; // old DRIFT_EXIT_STEER
  driftSteerGateHi: number; // old DRIFT_ENTER_STEER
  driftSpeedGateLo: number; // old DRIFT_EXIT_SPEED
  driftSpeedGateHi: number; // old DRIFT_ENTER_SPEED
  driftThrottleGate: number; // min throttle for full intent
  driftHeatTau: number; // slow "tire warm-up" filter time constant (s)
  driftGripReleasePeak: number; // wide-entry severity [0..0.9]
  driftGripFloor: number; // absolute min rear grip mult
  driftPowerTau: number; // boost energy charge time constant (s)
  driftExitBoostK: number; // boost force per unit release rate

  // Vertical physics (src/physics/vertical.ts) — added after owner playtest
  // feedback: ramps/cliffs need to actually launch the kart into the air
  // instead of gluing Y to the heightfield no matter how steep the drop.
  verticalGravity: number; // VERTICAL_GRAVITY
  verticalGroundFollowRate: number; // VERTICAL_GROUND_FOLLOW_RATE
  verticalAirborneDropThreshold: number; // VERTICAL_AIRBORNE_DROP_THRESHOLD
  verticalLandingMargin: number; // VERTICAL_LANDING_MARGIN

  // Body attitude (pitch/roll) follow — src/kart/kart.ts step 8b/8d.
  attitudeFollowRate: number; // ATTITUDE_FOLLOW_RATE — grounded slope-follow speed
  attitudeAirborneRelaxRate: number; // ATTITUDE_AIRBORNE_RELAX_RATE — how fast the body levels out while airborne
}

// Values pulled straight from dev_params.json (repo root) on 2026-07-06.
export const DEFAULT_KART_PHYSICS_PARAMS: KartPhysicsParams = {
  maxSpeed: 24.5,
  accelForce: 20,
  kDrag: 0.07,
  kRolling: 1.1,
  brakeForce: 40,
  reverseRatio: 0.7,

  steerSlewRateIn: 3,
  steerSlewRateOut: 11,
  throttleSlewRate: 2,

  steerLowSpeedMult: 1.1,
  steerHighSpeedMult: 0.85,

  maxSteerAngleDeg: 35,
  frontGripStiffness: 17.5,
  rearGripStiffness: 2.5,
  tireSaturationSpeed: 5,
  inertiaScale: 2,
  omegaDamping: 5,
  driftMaxSlipSpeed: 8,
  omegaLeanScale: 2,

  kinematicBlendLoSpeed: 1.5,
  kinematicBlendHiSpeed: 6,
  kinematicLateralMute: 0.1,

  driftMinSpeed: 2.5,
  slipSmoothing: 5,
  driftActiveThreshold: 0.55,
  driftDragMultiplier: 1,
  driftRollingMultiplier: 5,
  corneringDragCoeff: 5,
  corneringDragDriftMult: 4,

  mass: 1.0,

  autoDriftEnabled: true,
  driftVisualSmoothRate: 4.5,
  driftEnterSteer: 0.55,
  driftEnterSpeed: 5,
  driftEnterDebounce: 0.12,
  driftExitSteer: 0.35,
  driftExitSpeed: 4,
  driftExitDuration: 0.3,
  driftVisualOffsetDeg: 39,
  driftEngageInRate: 7,
  driftEngageOutRate: 2.5,
  driftRecoveryRate: 5,
  driftExitGripMult: 2.2,
  driftRearGripMult: 0.25,
  driftYawBonus: 1.5,
  driftForwardAssist: 0,
  driftPowerFullTime: 1.5,
  driftMinActiveForBoost: 0.7,
  driftExitBoostForce: 14,
  driftExitBoostDuration: 0.5,

  visualDriftMaxDeg: 60,
  visualLeanRecoverySpeed: 2.5,

  driftSteerGateLo: 0.35,
  driftSteerGateHi: 0.55,
  driftSpeedGateLo: 1.5,
  driftSpeedGateHi: 3,
  driftThrottleGate: 0.1,
  driftHeatTau: 0.8,
  driftGripReleasePeak: 0.6,
  driftGripFloor: 0.05,
  driftPowerTau: 0.5,
  driftExitBoostK: 7.0,

  // Vertical physics — see vertical.ts header for the launch-detection design.
  // gravity 22 m/s² is arcade-light (real gravity 9.8 feels floaty/slow for
  // a kart game); groundFollowRate 20 matches the pre-existing hardcoded
  // exp-follow rate kart.ts used before this was parameterized.
  verticalGravity: 22,
  verticalGroundFollowRate: 20,
  verticalAirborneDropThreshold: 2.5,
  verticalLandingMargin: 0.04,

  // 20 (up from the old hardcoded pitch-only rate of 10) — a plain 10 let a
  // kart crossing a ramp tile at top speed clear it before the filter caught
  // up, so the tilt read as "barely there" even though the underlying slope
  // math was correct (see kart.ts step 8b comment / gameplay-programmer
  // pitch diagnosis). 20 keeps the body visibly banked through a ramp at any
  // speed in this vertical slice's speed range.
  attitudeFollowRate: 20,
  attitudeAirborneRelaxRate: 3,
};

// Axle geometry — separate from KartPhysicsParams because it's measured from
// the model in Godot (kart_controller._setup_axle_geometry), not tuned via
// dev_params.json. Fallback values below match kart_controller.gd's
// hardcoded fallback when no wheel nodes are found (wb < 0.1 → 1.2, tw < 0.05 → 0.9).
export interface AxleGeometry {
  wheelbase: number; // meters, front-to-rear
  trackWidth: number; // meters, left-to-right
}

export const DEFAULT_AXLE_GEOMETRY: AxleGeometry = {
  wheelbase: 1.2,
  trackWidth: 0.9,
};

// ─── PhysicsInput (physics_input.gd) ────────────────────────────────────────
// Godot passes a full Basis; bicycle_physics.gd only ever reads -basis.z
// (forward) and basis.x (right), so the web port takes those two unit
// vectors directly instead of a full rotation matrix.
export interface PhysicsInput {
  velocity: Vec3; // current world velocity
  forward: Vec3; // unit vector, -Z at yaw=0 (Godot convention)
  right: Vec3; // unit vector, +X at yaw=0
  throttle: number; // smoothed throttle [-1..+1]
  steerInput: number; // smoothed steer [-1..+1]
  brakeHeld: boolean;
  onFloor: boolean;
  rearGripMultiplier: number; // set by DriftStateMachine (<1 during active drift)
}

// ─── PhysicsState (physics_state.gd) ────────────────────────────────────────
export interface PhysicsState {
  newVelocity: Vec3;
  yawDelta: number; // radians to rotate around Y this tick

  omega: number; // angular velocity around Y (rad/s)
  fwdSpeed: number; // signed velocity along -basis.z
  sideSpeed: number; // signed velocity along basis.x at body center

  rearLeftLatSpeed: number;
  rearRightLatSpeed: number;

  slipAngleFrontDeg: number;
  slipAngleRearDeg: number;

  driftIntensity: number; // smoothed [0..1]
  isDrifting: boolean; // hysteresis flag, VFX/audio on-off only
  slipRatio: number; // raw rear-slip ratio normalized to driftMaxSlipSpeed
  gripDebug: number;
}

// ─── DriftStateMachine types ─────────────────────────────────────────────────
export enum DriftState {
  IDLE,
  ARMING,
  ACTIVE,
  EXITING,
}

export interface DriftOutput {
  isActive: boolean;
  direction: -1 | 0 | 1;
  visualYawOffsetRad: number;
  rearGripMultiplier: number;
  yawBonusRadPerSec: number;
  forwardAssistForce: number;
  exitBoostForce: number;
  power: number; // 0..1 accumulated power
  engageFactor: number; // 0..1
}
