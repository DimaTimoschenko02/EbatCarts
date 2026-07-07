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
  reverseEngageSpeed: number; // REVERSE_ENGAGE_SPEED — fwdSpeed below which reverse-gear thrust fully engages (see bicyclePhysics.ts step I); above it, holding S only brakes, mirroring a real car braking to a stop before reverse engages.

  // Slope gravity assist (owner playtest 2026-07-07: "kart climbs a ramp at
  // full inertia like it's flat ground" — see bicyclePhysics.ts step I). A
  // purely longitudinal term: -slopeGravityAccel*sin(groundSlopeRad) added
  // alongside thrust/drag/rolling/brake, so it acts identically whether the
  // kart is coasting or under throttle. Deliberately an ARCADE tuning knob,
  // not literal g*sin(theta) off verticalGravity (22) — see dev_params
  // comment at the default for why.
  slopeGravityAccel: number; // SLOPE_GRAVITY_ACCEL

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

  // Chase camera heading (src/core/camera.ts, 2026-07-07 — camera detached
  // from physical yaw so drift can be visually deep again without spinning
  // the whole screen; see camera.ts file header for the full rationale).
  camYawFollowRate: number; // CAM_YAW_FOLLOW_RATE — how fast the camera turns to catch up to its target heading
  camVelHeadingBlendLo: number; // CAM_VEL_HEADING_BLEND_LO — below this forward speed, camera target = physical yaw only
  camVelHeadingBlendHi: number; // CAM_VEL_HEADING_BLEND_HI — at/above this forward speed, camera target = velocity heading only
}

// Values pulled straight from dev_params.json (repo root) on 2026-07-06.
export const DEFAULT_KART_PHYSICS_PARAMS: KartPhysicsParams = {
  maxSpeed: 24.5,
  accelForce: 20,
  kDrag: 0.07,
  kRolling: 1.1,
  // 40 -> 5 (owner playtest 2026-07-07): braking from a cruise used to be
  // near-instant (~0.18s to a dead stop) because reverse-thrust and brake
  // BOTH fired the instant S was pressed (see step I's reverseEngageSpeed
  // gate, added same session — that gate removes the double-dip). With ONLY
  // that gate fixed, 40 alone still stopped a cruise (~10.7 m/s) in ~0.4s —
  // still reads as a wall. 5 brings a cruise-to-near-stop down over ~0.87s
  // (~0.52s down to 3 m/s), mirroring the ~0.84s a natural throttle-off
  // coast takes to lose the same speed (brakeForce is a real but gentle
  // ASSIST on top of drag/rolling, not a separate instant-stop mechanic).
  // See tools/diagnose_longitudinal.ts for the full sweep.
  brakeForce: 5,
  reverseRatio: 0.7,
  // NEW (owner playtest 2026-07-07): fwdSpeed below which reverse-gear
  // thrust actually engages while S is held — see bicyclePhysics.ts step I
  // comment. 1.2 m/s is comfortably inside "basically stopped" so a player
  // braking hard from speed never feels thrust fighting the brake, but
  // reverse still kicks in essentially the instant the kart is stationary.
  reverseEngageSpeed: 1.2,

  // 10 m/s² (owner playtest 2026-07-07, "kart drives up a ramp at full
  // inertia like flat ground"). arena_slice's ramps are ~0.5m rise over
  // ~1.5m run (~18-20deg) — at 10, full-throttle uphill terminal speed on
  // that grade settles ~9.4 m/s vs ~10.8 m/s flat (~13% down), and the same
  // grade downhill settles ~12.0 m/s (~11% up): clearly felt on a ramp
  // crossing, nowhere near strong enough to stall a full-throttle climb or
  // to rocket the kart downhill uncontrollably. Deliberately NOT tied to
  // verticalGravity (22, tuned purely for jump/trampoline arc feel) — this
  // is a separate arcade "grade resistance" knob for ground-following.
  slopeGravityAccel: 10,

  // steerSlewRateIn 3 -> 2.2 (owner playtest: "steering has no weight" —
  // slower ramp-up to full lock gives the wheel a touch of heft without
  // hurting responsiveness, still under 0.5s to ~85% of full lock).
  steerSlewRateIn: 2.2,
  steerSlewRateOut: 11,
  throttleSlewRate: 2,

  // steerLowSpeedMult 1.1 -> 0.9, maxSteerAngleDeg 35 -> 28 (owner playtest:
  // low/mid-speed turning felt "too sharp, no effort" — this pair was the
  // actual cause, NOT the kinematic blend formula itself (see diagnosis in
  // the session report): the old 1.1x low-speed boost stacked on top of the
  // already-instant, zero-slip kinematic omega formula (step G) to produce
  // ~227 deg/s turn rate at the top of the blend zone (6 m/s). Dropping the
  // low-speed boost below 1.0 (matching/undercutting steerHighSpeedMult
  // instead of exceeding it) and trimming the shared max-angle knob cuts
  // that to ~135 deg/s — still snappy, no longer "on rails at any speed."
  steerLowSpeedMult: 0.9,
  steerHighSpeedMult: 0.85,

  maxSteerAngleDeg: 28,
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
  // 39 -> 10 -> 30 (2026-07-07). The 10deg clamp (owner playtest: "nose
  // partially returns after releasing steer mid-drift") was a workaround for
  // a DIFFERENT bug: camera.ts used to follow the kart's PHYSICAL yaw
  // rigidly, so this purely-cosmetic body offset (added on top of physical
  // heading, baseCar.rotation.y in kart.ts) visibly swinging back toward 0
  // as dFast decays on release read as "the whole screen un-turns." Root
  // cause fixed at the source (camera.ts now follows a velocity/yaw-blended
  // heading, not physical yaw — see camera.ts file header), so the deep
  // offset can come back: 30deg gives a proper SmashKarts-style "body kicked
  // sideways into the slide" read without the screen swinging along with it.
  // See driftReleaseComposition.test.ts for the regression guard (rewritten
  // to check for release-derivative smoothness/jerk, not swing amplitude —
  // a deep offset decaying back toward 0 on release is now DESIGN INTENT,
  // not a bug).
  driftVisualOffsetDeg: 30,
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
  //
  // verticalAirborneDropThreshold raised 2.5 -> 4.0 (m/s) when the launch
  // detector was rewritten to also fire on a flattening ramp-top (not just
  // cliffs): at arena_slice's 26.6deg ramp slope, a slow crawl (3-5 m/s kart
  // speed) implies a ~1.3-2.2 m/s climb rate, a cruise (15-22 m/s) implies
  // ~6.7-9.8 m/s. 4.0 sits in the gap between those two bands so slow
  // approaches stay glued to the flattening ramp-top while a real cruise
  // gets an unmistakable trampoline launch. See vertical.test.ts.
  verticalGravity: 22,
  verticalGroundFollowRate: 20,
  verticalAirborneDropThreshold: 4.0,
  verticalLandingMargin: 0.04,

  // 20 (up from the old hardcoded pitch-only rate of 10) — a plain 10 let a
  // kart crossing a ramp tile at top speed clear it before the filter caught
  // up, so the tilt read as "barely there" even though the underlying slope
  // math was correct (see kart.ts step 8b comment / gameplay-programmer
  // pitch diagnosis). 20 keeps the body visibly banked through a ramp at any
  // speed in this vertical slice's speed range.
  attitudeFollowRate: 20,
  attitudeAirborneRelaxRate: 3,

  // Chase camera detached from physical yaw (2026-07-07) — see camera.ts
  // file header. 4 turns the camera to its target heading in ~0.7s (time
  // constant 1/4=0.25s), fast enough to keep up with a drift's changing
  // travel direction without visibly lagging. Blend window 0.5..2.5 m/s
  // covers "basically stopped/reversing" (pure physical yaw) up through a
  // slow rolling start (pure velocity heading) — arena_slice's cruise speeds
  // are 10+ m/s, comfortably above the top of the window.
  camYawFollowRate: 4,
  camVelHeadingBlendLo: 0.5,
  camVelHeadingBlendHi: 2.5,
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

  // Signed longitudinal grade under/ahead of the kart along its current
  // heading, radians. Positive = climbing (uphill), negative = descending.
  // 0 on flat ground or when no heightfield sample is available (e.g. off
  // the edge of the map). Callers only need to populate this while grounded
  // — bicycle.step() is never called while airborne (see kart.ts), so an
  // airborne caller's value here is simply unused.
  groundSlopeRad: number;
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
