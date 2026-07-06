// Continuous Drift v4.0 — replaces the v3.1 DriftStateMachine.
//
// Design (systems-designer spec, 2026-07-06): NO discrete states in physics.
// A single signed continuous intent signal D_fast ∈ [-1, 1] — computed from
// steer/speed/throttle through smoothstep gates and an asymmetric exp filter —
// drives every drift output proportionally:
//
//   rear grip loss     ∝ |D_fast| (× thermal release factor)
//   yaw bonus          ∝ D_fast (signed)
//   visual yaw offset  ∝ D_fast (signed, single-stage — no re-lerp)
//   forward assist     ∝ |D_fast|
//
// Wide-entry-then-tighten arc (the v3.2 "thermal fade" intent) emerges from
// the RACE between the fast intent filter (D_fast) and a slow "tire heat"
// filter H that chases |D_fast|: right after engagement gap = |D_fast| - H
// is large → extra grip release → wide arc; as H catches up, gap → 0 →
// steady-state circle. On release D_fast falls below H, gap clamps to 0 —
// no thermal effect during exit, with zero state logic.
//
// Exit boost is the RELEASE RATE of a stored-energy filter E: analytically
// dE/dt sign-flipped, exactly zero while building/holding a drift, positive
// only while releasing stored power — magnitude naturally scales with how
// long the drift was held. No minimum-duration threshold, no timed pulse.
//
// The only discrete flip left is the VFX/audio hysteresis flag, which is
// never read by any physics term (allowed by .claude/rules/smooth-values.md).
//
// Feedback-loop invariant (v3.0 spin-out protection): signed intent derives
// from PLAYER INPUT ONLY (steer/speed/throttle/onFloor) — never from measured
// slip. Do not "improve" it with slip terms; that reintroduces the
// slip → less grip → more slip instability the state machine was built to avoid.

import type { DriftOutput, KartPhysicsParams } from "./types";

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(lo: number, hi: number, x: number): number {
  if (lo === hi) return x < lo ? 0 : 1;
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export class ContinuousDrift {
  private params: KartPhysicsParams;

  private dFast = 0; // signed intent filter [-1..1] — the master signal
  private heat = 0; // slow tire-warm-up filter [0..1], chases |dFast|
  private energy = 0; // stored drift power [0..1], chases |dFast| slowly
  private engaged = false; // VFX/audio hysteresis flag ONLY

  constructor(params: KartPhysicsParams) {
    this.params = params;
  }

  reset(): void {
    this.dFast = 0;
    this.heat = 0;
    this.energy = 0;
    this.engaged = false;
  }

  getDFast(): number {
    return this.dFast;
  }

  getHeat(): number {
    return this.heat;
  }

  getEnergy(): number {
    return this.energy;
  }

  isDriftEngaged(threshold = 0.5): boolean {
    return Math.abs(this.dFast) >= threshold;
  }

  update(speed: number, steerInput: number, onFloor: boolean, throttle: number, delta: number): DriftOutput {
    const p = this.params;

    // 1. Gates — smoothstep everywhere, no thresholds, no debounce.
    // floor_gate is the one hard multiply: losing tire contact is a genuine
    // physical discontinuity; it only moves the TARGET of an exp filter, so
    // dFast itself never jumps (its slope does — allowed).
    const steerGate = smoothstep(p.driftSteerGateLo, p.driftSteerGateHi, Math.abs(steerInput));
    const speedGate = smoothstep(p.driftSpeedGateLo, p.driftSpeedGateHi, Math.abs(speed));
    const throttleGate = smoothstep(0, Math.max(p.driftThrottleGate, 1e-4), throttle);
    const floorGate = onFloor ? 1 : 0;

    // 2. Signed intent.
    const intentMag = steerGate * speedGate * throttleGate * floorGate;
    const signedIntent = Math.sign(steerInput) * intentMag;

    // 3. D_fast — asymmetric exp filter (fast in, configurable out).
    const rate = Math.abs(signedIntent) > Math.abs(this.dFast) ? p.driftEngageInRate : p.driftEngageOutRate;
    const alpha = 1 - Math.exp(-rate * delta);
    this.dFast = lerp(this.dFast, signedIntent, alpha);

    // 4. Heat — slow filter chasing |D_fast|.
    const heatRate = 1 / Math.max(p.driftHeatTau, 0.05);
    this.heat = lerp(this.heat, Math.abs(this.dFast), 1 - Math.exp(-heatRate * delta));

    // 5. Thermal release factor from the fast/slow filter gap.
    const gap = clamp(Math.abs(this.dFast) - this.heat, 0, 1);
    const releaseFactor = 1 - p.driftGripReleasePeak * gap;

    // 6. Continuous outputs.
    const absD = Math.abs(this.dFast);
    const baseMult = lerp(1, p.driftRearGripMult, absD);
    const rearGripMult = Math.max(p.driftGripFloor, baseMult * releaseFactor);
    const yawBonus = p.driftYawBonus * this.dFast; // signed
    const visualYawOffset = degToRad(p.driftVisualOffsetDeg) * this.dFast; // signed, single-stage
    const fwdAssist = p.driftForwardAssist * absD;

    // 7. Energy accumulator + analytic release-rate boost.
    const powerRate = 1 / Math.max(p.driftPowerTau, 0.05);
    const energyBefore = this.energy;
    this.energy = lerp(this.energy, absD, 1 - Math.exp(-powerRate * delta));
    // Analytic dE/dt (sign-flipped): positive only while E is draining toward
    // a lower |D_fast| — i.e. right after releasing a sustained drift.
    const releaseRate = powerRate * (energyBefore - absD);
    const exitBoost = p.driftExitBoostK * Math.max(0, releaseRate);

    // 8. VFX/audio hysteresis flag — never read by physics.
    const hystHigh = p.driftActiveThreshold + 0.02;
    const hystLow = p.driftActiveThreshold - 0.02;
    if (this.engaged) {
      if (absD < hystLow) this.engaged = false;
    } else {
      if (absD > hystHigh) this.engaged = true;
    }

    return {
      isActive: this.engaged, // VFX/audio trigger only — physics never branches on it
      direction: this.dFast > 0.001 ? 1 : this.dFast < -0.001 ? -1 : 0,
      visualYawOffsetRad: visualYawOffset,
      rearGripMultiplier: rearGripMult,
      yawBonusRadPerSec: yawBonus,
      forwardAssistForce: fwdAssist,
      exitBoostForce: exitBoost,
      power: this.energy,
      engageFactor: absD,
    };
  }
}
