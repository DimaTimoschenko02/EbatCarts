import { describe, expect, it } from "vitest";
import { DriftStateMachine } from "./driftStateMachine";
import { DEFAULT_KART_PHYSICS_PARAMS } from "./types";

const DT = 1 / 60;

describe("DriftStateMachine — full IDLE → ARMING → ACTIVE → EXITING → IDLE cycle", () => {
  it("walks the full lifecycle under synthetic high steer+speed+throttle input, then releases", () => {
    const sm = new DriftStateMachine(DEFAULT_KART_PHYSICS_PARAMS);
    const p = DEFAULT_KART_PHYSICS_PARAMS;

    const SPEED = 10; // >= driftEnterSpeed (5)
    const STEER = 0.8; // >= driftEnterSteer (0.55)
    const THROTTLE = 1;

    // Tick 1: IDLE -> ARMING (enter_ok true, transition happens same tick,
    // arm_timer reset to 0 — not yet counted).
    let out = sm.update(SPEED, STEER, true, THROTTLE, DT);
    expect(sm.isActive()).toBe(false); // still arming, not active yet
    expect(sm.getDirection()).toBe(1); // steer > 0 -> direction +1

    // Debounce is driftEnterDebounce=0.12s. Keep holding until we cross ACTIVE.
    const debounceTicks = Math.ceil(p.driftEnterDebounce / DT) + 2; // margin
    for (let i = 0; i < debounceTicks; i++) {
      out = sm.update(SPEED, STEER, true, THROTTLE, DT);
    }
    expect(sm.isActive()).toBe(true);
    expect(out.isActive).toBe(true);
    expect(out.direction).toBe(1);
    expect(out.rearGripMultiplier).toBeLessThan(1); // loosened grip while ACTIVE

    // Hold ACTIVE long enough to pass driftMinActiveForBoost (0.7s) so the
    // eventual exit grants a boost, and let power ramp toward 1.
    const holdTicks = Math.ceil((p.driftMinActiveForBoost + 0.3) / DT);
    for (let i = 0; i < holdTicks; i++) {
      out = sm.update(SPEED, STEER, true, THROTTLE, DT);
    }
    expect(sm.isActive()).toBe(true);
    expect(out.power).toBeGreaterThan(0); // power accumulating
    // Engage factor should have ramped up close to 1 given driftEngageInRate=1 (1/s)
    // and >1s of ACTIVE time elapsed.
    expect(sm.getEngageFactor()).toBeGreaterThan(0.6);

    // Release: drop steer below driftExitSteer (0.35) -> exit_ok, ACTIVE -> EXITING.
    out = sm.update(SPEED, 0.1, true, THROTTLE, DT);
    expect(sm.isActive()).toBe(false);
    expect(out.isActive).toBe(false);
    // Boost should be granted since we held ACTIVE past driftMinActiveForBoost.
    expect(out.exitBoostForce).toBeGreaterThan(0);

    // Run through the exit duration (0.3s) — direction should still read the
    // pre-exit direction until EXITING completes.
    const exitTicks = Math.ceil(p.driftExitDuration / DT) + 2;
    for (let i = 0; i < exitTicks; i++) {
      out = sm.update(SPEED, 0.0, true, 0.0, DT);
    }
    expect(sm.getDirection()).toBe(0); // back to IDLE, direction cleared
    expect(out.isActive).toBe(false);
    expect(out.power).toBe(0);

    // Let engage/recovery envelopes fully decay back toward 0.
    for (let i = 0; i < 300; i++) {
      out = sm.update(0, 0, true, 0, DT);
    }
    expect(sm.getEngageFactor()).toBeCloseTo(0, 2);
    expect(out.rearGripMultiplier).toBeCloseTo(1, 2); // grip back to normal
  });
});

describe("DriftStateMachine — entry/exit hysteresis", () => {
  it("does not enter drift from IDLE at a steer level between exit and enter thresholds", () => {
    const sm = new DriftStateMachine(DEFAULT_KART_PHYSICS_PARAMS);
    // driftExitSteer=0.35, driftEnterSteer=0.55 — 0.45 is in the dead zone.
    for (let i = 0; i < 60; i++) {
      sm.update(10, 0.45, true, 1, DT);
    }
    expect(sm.isActive()).toBe(false);
  });

  it("stays ACTIVE at a steer level between exit and enter thresholds once already engaged", () => {
    const sm = new DriftStateMachine(DEFAULT_KART_PHYSICS_PARAMS);
    const p = DEFAULT_KART_PHYSICS_PARAMS;
    // Enter properly first.
    const enterTicks = Math.ceil(p.driftEnterDebounce / DT) + 3;
    for (let i = 0; i < enterTicks; i++) {
      sm.update(10, 0.8, true, 1, DT);
    }
    expect(sm.isActive()).toBe(true);

    // Now ease steer into the hysteresis dead zone (0.45) — should remain
    // ACTIVE since exit only triggers below driftExitSteer (0.35).
    for (let i = 0; i < 30; i++) {
      sm.update(10, 0.45, true, 1, DT);
    }
    expect(sm.isActive()).toBe(true);
  });
});

describe("DriftStateMachine — no premature entry (debounce)", () => {
  it("does not go ACTIVE on a single frame of qualifying input", () => {
    const sm = new DriftStateMachine(DEFAULT_KART_PHYSICS_PARAMS);
    sm.update(10, 0.8, true, 1, DT);
    expect(sm.isActive()).toBe(false); // only 1 tick — debounce not satisfied
  });

  it("drops back to IDLE (direction cleared) if direction flips mid-arming, then re-arms on the next qualifying tick", () => {
    // Matches drift_state_machine.gd exactly: a mid-ARMING direction flip is
    // handled in the SAME tick as an immediate ARMING->IDLE transition (with
    // direction reset to 0) — the match-statement does not fall through to
    // re-evaluate the new IDLE state within that same update() call. Re-arming
    // with the new direction only happens on the FOLLOWING tick.
    const sm = new DriftStateMachine(DEFAULT_KART_PHYSICS_PARAMS);
    sm.update(10, 0.8, true, 1, DT); // arm right
    sm.update(10, -0.8, true, 1, DT); // flip left mid-arm -> back to IDLE this tick
    expect(sm.getDirection()).toBe(0);
    expect(sm.isActive()).toBe(false);

    sm.update(10, -0.8, true, 1, DT); // next tick: IDLE + enter_ok -> ARMING left
    expect(sm.getDirection()).toBe(-1);
    expect(sm.isActive()).toBe(false);
  });
});

describe("DriftStateMachine — auto_drift disabled", () => {
  it("never activates, and decays any residual visual offset to 0", () => {
    const params = { ...DEFAULT_KART_PHYSICS_PARAMS, autoDriftEnabled: false };
    const sm = new DriftStateMachine(params);
    for (let i = 0; i < 120; i++) {
      const out = sm.update(10, 0.8, true, 1, DT);
      expect(out.isActive).toBe(false);
    }
    expect(sm.isActive()).toBe(false);
  });
});

describe("DriftStateMachine — reset", () => {
  it("clears all internal state back to IDLE defaults", () => {
    const sm = new DriftStateMachine(DEFAULT_KART_PHYSICS_PARAMS);
    const p = DEFAULT_KART_PHYSICS_PARAMS;
    const enterTicks = Math.ceil(p.driftEnterDebounce / DT) + 3;
    for (let i = 0; i < enterTicks; i++) {
      sm.update(10, 0.8, true, 1, DT);
    }
    expect(sm.isActive()).toBe(true);
    sm.reset();
    expect(sm.isActive()).toBe(false);
    expect(sm.getDirection()).toBe(0);
    expect(sm.getEngageFactor()).toBe(0);
  });
});
