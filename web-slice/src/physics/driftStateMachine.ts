// Auto-triggered drift state machine layered on top of BicyclePhysics.
//
// 1:1 TypeScript port of scripts/physics/drift_state_machine.gd (v3.1).
// Pure compute module — no scene graph access. Caller builds inputs each
// tick, calls update(), and applies the returned DriftOutput to its
// PhysicsInput (rear_grip_multiplier) and to visual/velocity state
// (visual yaw offset, yaw bonus, forward assist, exit boost).

import type { DriftOutput, KartPhysicsParams } from "./types";
import { DriftState } from "./types";

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function signf(x: number): number {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}

export class DriftStateMachine {
  private params: KartPhysicsParams;

  private state: DriftState = DriftState.IDLE;
  private direction: -1 | 0 | 1 = 0;
  private armTimer = 0; // accumulated time conditions held
  private activeTimer = 0; // time spent in ACTIVE
  private exitTimer = 0; // time spent in EXITING (boost window)
  private visualYawOffset = 0; // smoothed visual offset (rad)
  private engageFactor = 0; // 0..1 smooth envelope: scales ALL drift effects
  private recoveryFactor = 0; // 0..1 snap-grip overlay, fires on ACTIVE→EXITING
  private power = 0; // 0..1, ramps over active time
  private exitBoostRemaining = 0; // post-exit boost time left (sec)

  constructor(params: KartPhysicsParams) {
    this.params = params;
  }

  reset(): void {
    this.state = DriftState.IDLE;
    this.direction = 0;
    this.armTimer = 0;
    this.activeTimer = 0;
    this.exitTimer = 0;
    this.visualYawOffset = 0;
    this.engageFactor = 0;
    this.recoveryFactor = 0;
    this.power = 0;
    this.exitBoostRemaining = 0;
  }

  isActive(): boolean {
    return this.state === DriftState.ACTIVE;
  }

  getDirection(): -1 | 0 | 1 {
    return this.direction;
  }

  getEngageFactor(): number {
    return this.engageFactor;
  }

  // True only when the visual/physical drift effect is meaningfully engaged.
  isDriftEngaged(threshold = 0.5): boolean {
    return this.engageFactor >= threshold;
  }

  update(speed: number, steerInput: number, onFloor: boolean, throttle: number, delta: number): DriftOutput {
    const p = this.params;

    if (!p.autoDriftEnabled) {
      this.state = DriftState.IDLE;
      const idleAlpha = 1 - Math.exp(-p.driftVisualSmoothRate * delta);
      this.visualYawOffset = lerp(this.visualYawOffset, 0, idleAlpha);
      this.engageFactor = lerp(this.engageFactor, 0, idleAlpha);
      return this.idleOutput();
    }

    const absSteer = Math.abs(steerInput);
    const enterOk =
      onFloor && speed >= p.driftEnterSpeed && absSteer >= p.driftEnterSteer && throttle > 0.05;
    const exitOk = !onFloor || speed < p.driftExitSpeed || absSteer < p.driftExitSteer;

    switch (this.state) {
      case DriftState.IDLE:
        if (enterOk) {
          this.state = DriftState.ARMING;
          this.direction = steerInput > 0 ? 1 : -1;
          this.armTimer = 0;
        }
        break;
      case DriftState.ARMING:
        if (!enterOk || signf(steerInput) !== this.direction) {
          this.state = DriftState.IDLE;
          this.armTimer = 0;
          this.direction = 0;
        } else {
          this.armTimer += delta;
          if (this.armTimer >= p.driftEnterDebounce) {
            this.state = DriftState.ACTIVE;
            this.activeTimer = 0;
            this.power = 0;
          }
        }
        break;
      case DriftState.ACTIVE:
        if (exitOk) {
          this.state = DriftState.EXITING;
          this.exitTimer = 0;
          if (this.activeTimer >= p.driftMinActiveForBoost) {
            this.exitBoostRemaining = p.driftExitBoostDuration;
          }
          // Snap-grip overlay activates the moment we leave ACTIVE.
          this.recoveryFactor = 1.0;
        } else {
          this.activeTimer += delta;
          this.power = clamp(this.activeTimer / Math.max(p.driftPowerFullTime, 0.01), 0, 1);
        }
        break;
      case DriftState.EXITING:
        this.exitTimer += delta;
        if (this.exitTimer >= p.driftExitDuration) {
          this.state = DriftState.IDLE;
          this.direction = 0;
          this.activeTimer = 0;
          this.power = 0;
        }
        break;
    }

    // Engage envelope — smoothly ramps to 1 in ACTIVE, decays to 0 elsewhere.
    const engageTarget = this.state === DriftState.ACTIVE ? 1 : 0;
    const rate = engageTarget > this.engageFactor ? p.driftEngageInRate : p.driftEngageOutRate;
    const smoothAlpha = 1 - Math.exp(-rate * delta);
    this.engageFactor = lerp(this.engageFactor, engageTarget, smoothAlpha);
    if (this.engageFactor < 0.001 && engageTarget === 0) {
      this.engageFactor = 0;
    }

    // Recovery overlay decays once we leave ACTIVE.
    const recoveryAlpha = 1 - Math.exp(-p.driftRecoveryRate * delta);
    this.recoveryFactor = lerp(this.recoveryFactor, 0, recoveryAlpha);
    if (this.recoveryFactor < 0.001) {
      this.recoveryFactor = 0;
    }

    // Visual yaw is driven directly by the smoothed engageFactor (single-stage
    // smoothing — see smooth-values rule item #5 for why this matters).
    const maxOff = degToRad(p.driftVisualOffsetDeg);
    this.visualYawOffset = maxOff * this.direction * this.engageFactor;

    // Rear grip multiplier: base loosens grip in ACTIVE, overlay tightens on exit.
    const baseMult = lerp(1, p.driftRearGripMult, this.engageFactor);
    const overlay = (p.driftExitGripMult - 1) * this.recoveryFactor;
    const rearGripMult = baseMult + overlay;
    const yawBonus = p.driftYawBonus * this.direction * this.engageFactor;
    const fwdAssist = p.driftForwardAssist * this.engageFactor;

    // Post-exit boost — pure forward burst, decays linearly.
    let exitBoost = 0;
    if (this.exitBoostRemaining > 0) {
      const t = clamp(this.exitBoostRemaining / Math.max(p.driftExitBoostDuration, 0.01), 0, 1);
      exitBoost = p.driftExitBoostForce * t;
      this.exitBoostRemaining = Math.max(this.exitBoostRemaining - delta, 0);
    }

    return {
      isActive: this.state === DriftState.ACTIVE,
      direction: this.direction,
      visualYawOffsetRad: this.visualYawOffset,
      rearGripMultiplier: rearGripMult,
      yawBonusRadPerSec: yawBonus,
      forwardAssistForce: fwdAssist,
      exitBoostForce: exitBoost,
      power: this.power,
      engageFactor: this.engageFactor,
    };
  }

  private idleOutput(): DriftOutput {
    return {
      isActive: false,
      direction: 0,
      visualYawOffsetRad: this.visualYawOffset,
      rearGripMultiplier: 1.0,
      yawBonusRadPerSec: 0,
      forwardAssistForce: 0,
      exitBoostForce: 0,
      power: 0,
      engageFactor: this.engageFactor,
    };
  }
}
