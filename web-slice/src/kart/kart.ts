// Kart entity: physics state + placeholder/loaded 3D model + per-substep
// physics update + per-frame visual sync. 1:1 port from GDScript v3.1's
// kart_controller.gd _physics_process wiring (see design/gdd/kart-physics.md
// and kart-physics-v3.2-thermal-fade.md):
//   smooth input → drift signal update → build PhysicsInput → bicycle.step()
//   → yaw += yawDelta + driftYawBonus → velocity ← newVelocity (+assist/boost)
//   → integrate position (with map collision) → visual lean + drift yaw offset.
//
// Axis convention matches Godot: forward = -Z, right = +X, yaw around +Y
// (positive = CCW from above = left turn). The kart mesh nose points -Z.
import * as THREE from "three";
import { BicyclePhysics } from "../physics/bicyclePhysics";
import { ContinuousDrift } from "../physics/driftContinuous";
import { DEFAULT_AXLE_GEOMETRY } from "../physics/types";
import type { KartPhysicsParams, PhysicsInput } from "../physics/types";
import { RearSkidMarks } from "../fx/skidMarks";
import { loadKartModel } from "../map/assetLoader";
import type { GameMap } from "../map/mapLoader";
import { buildKartPhysicsParams, type KartStats } from "./stats";
import type { RawInput } from "../core/input";

// Godot: forward = -Z rotated by yaw around +Y.
export function forwardOf(yaw: number): THREE.Vector3 {
  return new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
}
export function rightOf(yaw: number): THREE.Vector3 {
  return new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
}

// Max climbable rise per move — a full tile step is 0.5, ramps rise gradually.
const MAX_STEP = 0.3;

export interface KartTelemetry {
  fwdSpeed: number;
  sideSpeed: number;
  omega: number;
  driftIntensity: number;
  isDrifting: boolean;
  slipRatio: number;
  rearLat: number;
  engageFactor: number;
  driftActive: boolean;
  driftPower: number;
  rearGripMult: number;
}

export class Kart {
  // Outer group carries PHYSICS yaw; inner "baseCar" group carries the
  // visual-only yaw offset (drift lean + drift visual yaw), mirroring the
  // Godot $BaseCar child pattern.
  readonly group = new THREE.Group();
  private readonly baseCar = new THREE.Group();

  private readonly params: KartPhysicsParams;
  private readonly axle = DEFAULT_AXLE_GEOMETRY;
  private readonly bicycle: BicyclePhysics;
  private readonly driftSM: ContinuousDrift;
  private readonly skids: RearSkidMarks;
  private readonly spawn: THREE.Vector3;

  readonly state = {
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    yaw: 0,
  };

  // Smoothed inputs (kart_controller._smooth_input equivalents).
  private throttleSm = 0;
  private steerSm = 0;
  // Visual lean state (kart_controller._visual_drift_angle equivalent).
  private visualDriftAngle = 0;
  private driftVisualYaw = 0;
  // Heightfield follow state: smoothed ground height + slope pitch.
  private groundY = 0;
  private pitchSm = 0;

  private lastOut: KartTelemetry = {
    fwdSpeed: 0, sideSpeed: 0, omega: 0,
    driftIntensity: 0, isDrifting: false, slipRatio: 0,
    rearLat: 0, engageFactor: 0, driftActive: false, driftPower: 0,
    rearGripMult: 1,
  };

  constructor(scene: THREE.Scene, stats: KartStats, spawn: THREE.Vector3) {
    this.params = buildKartPhysicsParams(stats);
    this.bicycle = new BicyclePhysics(this.params);
    this.driftSM = new ContinuousDrift(this.params);
    // Skid trails: diagnostic-first — any drift-transition kink is visible as
    // an angle in the arc. Records continuously; brightness = slip intensity.
    this.skids = new RearSkidMarks(scene, this.axle.wheelbase, this.axle.trackWidth);
    this.spawn = spawn.clone();

    this.group.add(this.baseCar);
    this.group.rotation.order = "YXZ"; // yaw first, then slope pitch
    this.buildPlaceholderMesh();
    scene.add(this.group);

    this.reset();
  }

  private buildPlaceholderMesh(): void {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.5, 2.4),
      new THREE.MeshStandardMaterial({ color: 0xff4400 })
    );
    body.position.y = 0.45;
    this.baseCar.add(body);
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.4, 1.0),
      new THREE.MeshStandardMaterial({ color: 0x2266ff })
    );
    cabin.position.set(0, 0.85, -0.2);
    this.baseCar.add(cabin);
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.3, 0.6, 8),
      new THREE.MeshStandardMaterial({ color: 0xffff00, emissive: 0xffff00, emissiveIntensity: 0.5 })
    );
    nose.rotation.x = -Math.PI / 2;
    nose.position.set(0, 0.5, -1.4); // -Z = forward
    this.baseCar.add(nose);
  }

  // Swaps the placeholder box kart for the real glb model once it's loaded.
  async loadModel(name: string, targetLength: number): Promise<void> {
    const model = await loadKartModel(name, targetLength);
    this.baseCar.clear();
    this.baseCar.add(model);
  }

  reset(): void {
    this.state.pos.copy(this.spawn);
    this.state.vel.set(0, 0, 0);
    this.state.yaw = 0;
    this.throttleSm = 0;
    this.steerSm = 0;
    this.visualDriftAngle = 0;
    this.driftVisualYaw = 0;
    this.groundY = 0;
    this.pitchSm = 0;
    this.bicycle.reset();
    this.driftSM.reset();
    this.skids.clear();
  }

  get position(): THREE.Vector3 {
    return this.state.pos;
  }
  get velocity(): THREE.Vector3 {
    return this.state.vel;
  }
  get yaw(): number {
    return this.state.yaw;
  }
  get lastOutput(): Readonly<KartTelemetry> {
    return this.lastOut;
  }

  private smoothInput(raw: RawInput, dt: number): void {
    const slew = Math.abs(raw.steer) > Math.abs(this.steerSm) ? this.params.steerSlewRateIn : this.params.steerSlewRateOut;
    const steerAlpha = 1 - Math.exp(-slew * dt);
    this.steerSm += (raw.steer - this.steerSm) * steerAlpha;
    if (Math.abs(this.steerSm) < 0.01 && Math.abs(raw.steer) < 0.01) this.steerSm = 0;
    const thrAlpha = 1 - Math.exp(-this.params.throttleSlewRate * dt);
    this.throttleSm += (raw.throttle - this.throttleSm) * thrAlpha;
  }

  // Physics-only step — may run multiple times per rendered frame (fixed
  // substeps). Object3D transform sync happens separately in syncVisual().
  update(dt: number, raw: RawInput, map: GameMap | null): void {
    // 1. Input smoothing.
    this.smoothInput(raw, dt);

    // 3. Drift signal BEFORE bicycle (feeds rear_grip_multiplier).
    const fwdDir = forwardOf(this.state.yaw);
    const fwdSigned = this.state.vel.dot(fwdDir);
    const drift = this.driftSM.update(Math.hypot(this.state.vel.x, this.state.vel.z), this.steerSm, true, this.throttleSm, dt);
    this.driftVisualYaw = drift.visualYawOffsetRad;

    // 4. Build PhysicsInput.
    const rightDir = rightOf(this.state.yaw);
    const inp: PhysicsInput = {
      velocity: { x: this.state.vel.x, y: this.state.vel.y, z: this.state.vel.z },
      forward: { x: fwdDir.x, y: 0, z: fwdDir.z },
      right: { x: rightDir.x, y: 0, z: rightDir.z },
      throttle: this.throttleSm,
      steerInput: this.steerSm,
      brakeHeld: raw.throttle < 0,
      onFloor: true,
      rearGripMultiplier: drift.rearGripMultiplier,
    };

    // 5. Bicycle physics step.
    const out = this.bicycle.step(inp, dt);

    // 6. Yaw: bicycle delta + drift bonus.
    this.state.yaw += out.yawDelta + drift.yawBonusRadPerSec * dt;

    // 7. Velocity: bicycle XZ, then forward assist + exit boost along POST-rotation forward.
    this.state.vel.set(out.newVelocity.x, 0, out.newVelocity.z);
    const assist = drift.forwardAssistForce + drift.exitBoostForce;
    if (Math.abs(assist) > 0 && fwdSigned >= 0) {
      const fwdAfter = forwardOf(this.state.yaw);
      this.state.vel.addScaledVector(fwdAfter, assist * dt);
    }

    // 8. Integrate position with map collision: axis-separated point move.
    // A rise taller than MAX_STEP — or leaving the map — is a wall: that axis
    // component of velocity is cancelled, the other keeps sliding (poor man's
    // move_and_slide, enough for axis-aligned cliffs and map borders).
    if (map) {
      const curH = map.sampleHeight(this.state.pos.x, this.state.pos.z) ?? this.groundY;
      const nx = this.state.pos.x + this.state.vel.x * dt;
      const hx = map.sampleHeight(nx, this.state.pos.z);
      if (hx === null || hx - curH > MAX_STEP) this.state.vel.x = 0;
      else this.state.pos.x = nx;
      const nz = this.state.pos.z + this.state.vel.z * dt;
      const hz = map.sampleHeight(this.state.pos.x, nz);
      if (hz === null || hz - curH > MAX_STEP) this.state.vel.z = 0;
      else this.state.pos.z = nz;
    } else {
      this.state.pos.addScaledVector(this.state.vel, dt);
    }

    // 8b. Follow the heightfield: smoothed height + slope pitch from a fore/aft
    // probe pair (half wheelbase each way). Both are exp-filters — C1 smooth
    // over ramp lips at any framerate (smooth-values rule).
    const hHere = map?.sampleHeight(this.state.pos.x, this.state.pos.z) ?? 0;
    this.groundY += (hHere - this.groundY) * (1 - Math.exp(-20 * dt));
    this.state.pos.y = this.groundY;
    const probe = this.axle.wheelbase * 0.5;
    const hF = map?.sampleHeight(this.state.pos.x + fwdDir.x * probe, this.state.pos.z + fwdDir.z * probe) ?? hHere;
    const hB = map?.sampleHeight(this.state.pos.x - fwdDir.x * probe, this.state.pos.z - fwdDir.z * probe) ?? hHere;
    const targetPitch = Math.atan2(hF - hB, this.axle.wheelbase);
    this.pitchSm += (targetPitch - this.pitchSm) * (1 - Math.exp(-10 * dt));

    // Skid trails: intensity from actual rear slip normalized like drift_intensity.
    const slipNorm = Math.min(Math.abs(out.rearLeftLatSpeed) / Math.max(this.params.driftMaxSlipSpeed, 0.01), 1);
    this.skids.update(this.state.pos, this.state.yaw, slipNorm);

    // 11. Visual lean (omega-driven) — smoothed toward intensity*maxDeg*(-omegaNorm).
    const omegaNorm = Math.min(Math.max(out.omega / Math.max(this.params.omegaLeanScale, 0.01), -1), 1);
    const targetLean = (out.driftIntensity * this.params.visualDriftMaxDeg * -omegaNorm) * Math.PI / 180;
    const leanAlpha = 1 - Math.exp(-this.params.visualLeanRecoverySpeed * dt);
    this.visualDriftAngle += (targetLean - this.visualDriftAngle) * leanAlpha;

    this.lastOut = {
      fwdSpeed: out.fwdSpeed, sideSpeed: out.sideSpeed, omega: out.omega,
      driftIntensity: out.driftIntensity, isDrifting: out.isDrifting, slipRatio: out.slipRatio,
      rearLat: out.rearLeftLatSpeed, engageFactor: drift.engageFactor,
      driftActive: drift.isActive, driftPower: drift.power,
      rearGripMult: drift.rearGripMultiplier,
    };
  }

  // Object3D transform sync — call once per rendered frame (physics may have
  // run several substeps since the last call).
  syncVisual(): void {
    this.group.position.copy(this.state.pos);
    this.group.rotation.y = this.state.yaw;
    this.group.rotation.x = this.pitchSm; // slope pitch (order YXZ: yaw, then pitch)
    // Visual-only yaw offset on the inner group ($BaseCar pattern):
    // emergent omega lean + drift visual yaw offset.
    this.baseCar.rotation.y = this.visualDriftAngle + this.driftVisualYaw;
  }
}
