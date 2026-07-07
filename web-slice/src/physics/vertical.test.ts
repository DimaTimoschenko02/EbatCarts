import { describe, expect, it } from "vitest";
import { createVerticalState, stepVertical, type VerticalParams } from "./vertical";

const P: VerticalParams = {
  gravity: 20,
  groundFollowRate: 20,
  airborneDropThreshold: 2.5,
  landingMargin: 0.04,
};

const DT = 1 / 120;

describe("stepVertical — grounded follow", () => {
  it("follows a flat ground height exactly (no drift)", () => {
    let s = createVerticalState(0);
    for (let i = 0; i < 60; i++) s = stepVertical(s, { groundHeight: 0, dt: DT }, P);
    expect(s.airborne).toBe(false);
    expect(s.y).toBeCloseTo(0, 6);
  });

  it("smoothly climbs a gentle continuous slope without ever going airborne", () => {
    // Height rises 0.005 per substep — much gentler than gravity could ever
    // account for as a "drop", so this must never trigger a launch.
    let s = createVerticalState(0);
    let h = 0;
    for (let i = 0; i < 200; i++) {
      h += 0.005;
      s = stepVertical(s, { groundHeight: h, dt: DT }, P);
      expect(s.airborne).toBe(false);
    }
    expect(s.y).toBeGreaterThan(0.9);
  });

  it("does not go airborne when a climbing ramp simply flattens out at the top", () => {
    let s = createVerticalState(0);
    // Climb for 60 ticks, then hold height constant (flat runout) for 60 more.
    let h = 0;
    for (let i = 0; i < 60; i++) {
      h += 0.01;
      s = stepVertical(s, { groundHeight: h, dt: DT }, P);
      expect(s.airborne).toBe(false);
    }
    for (let i = 0; i < 60; i++) {
      s = stepVertical(s, { groundHeight: h, dt: DT }, P);
      expect(s.airborne).toBe(false);
    }
    expect(s.y).toBeCloseTo(h, 3);
  });

  it("does not chatter airborne on/off from heightfield micro-noise", () => {
    let s = createVerticalState(0);
    const noise = [0, 0.002, -0.001, 0.0015, -0.0008, 0.001, 0, -0.0012];
    let flips = 0;
    let wasAirborne = false;
    for (let i = 0; i < 200; i++) {
      const h = noise[i % noise.length];
      s = stepVertical(s, { groundHeight: h, dt: DT }, P);
      if (s.airborne !== wasAirborne) flips++;
      wasAirborne = s.airborne;
    }
    expect(flips).toBe(0);
  });
});

describe("stepVertical — launch off a ramp lip", () => {
  it("launches upward (positive vy) when a climbing ramp ends in a sudden drop", () => {
    let s = createVerticalState(0);
    // Climb steadily (steep ramp: rises fast enough to build a large positive
    // implied vy), then the ground suddenly drops far below — simulating
    // driving off the top of a ramp into open air / a lower level.
    let h = 0;
    for (let i = 0; i < 30; i++) {
      h += 0.05; // steep, deliberate climb
      s = stepVertical(s, { groundHeight: h, dt: DT }, P);
      expect(s.airborne).toBe(false);
    }
    const vyBeforeDrop = s.vy;
    expect(vyBeforeDrop).toBeGreaterThan(1); // was genuinely climbing
    s = stepVertical(s, { groundHeight: h - 5, dt: DT }, P); // cliff after the ramp
    expect(s.airborne).toBe(true);
    expect(s.vy).toBeCloseTo(vyBeforeDrop, 6); // launched carrying the climb rate
    expect(s.vy).toBeGreaterThan(1);
  });

  it("also launches (falls, vy~=0) walking slowly off a flat cliff edge", () => {
    let s = createVerticalState(0);
    for (let i = 0; i < 30; i++) s = stepVertical(s, { groundHeight: 0, dt: DT }, P);
    expect(s.vy).toBeCloseTo(0, 3);
    s = stepVertical(s, { groundHeight: -5, dt: DT }, P);
    expect(s.airborne).toBe(true);
    expect(Math.abs(s.vy)).toBeLessThan(0.5); // launched near-level, not glued down
  });

  it("traces a parabola while airborne (pure ballistic, no ground-follow)", () => {
    let s = { y: 0, vy: 5, airborne: true };
    const g = P.gravity;
    let tExpected = 0;
    for (let i = 0; i < 30; i++) {
      s = stepVertical(s, { groundHeight: -100, dt: DT }, P); // ground far below, never lands
      tExpected += DT;
      const expectedVy = 5 - g * tExpected;
      expect(s.vy).toBeCloseTo(expectedVy, 5);
    }
  });

  it("lands without a bounce and preserves the (caller-owned) horizontal velocity concept", () => {
    // vy starts positive (apex not yet reached), ground close below —
    // must NOT land while still ascending even if within landingMargin.
    let s = { y: 0.01, vy: 3, airborne: true };
    s = stepVertical(s, { groundHeight: 0, dt: DT }, P);
    expect(s.airborne).toBe(true); // still rising, must not snap down

    // Now simulate falling back down onto flat ground.
    s = { y: 0.5, vy: -1, airborne: true };
    for (let i = 0; i < 200 && s.airborne; i++) {
      s = stepVertical(s, { groundHeight: 0, dt: DT }, P);
    }
    expect(s.airborne).toBe(false);
    expect(s.vy).toBe(0); // no bounce
    expect(s.y).toBeCloseTo(0, 6);
  });
});

describe("stepVertical — params drive the thresholds", () => {
  it("a higher airborneDropThreshold requires a steeper drop to launch", () => {
    const loose: VerticalParams = { ...P, airborneDropThreshold: 0.1 };
    const strict: VerticalParams = { ...P, airborneDropThreshold: 50 };

    let sLoose = createVerticalState(0);
    let sStrict = createVerticalState(0);
    // Moderate drop: not a ramp launch, just a modest downhill tick.
    sLoose = stepVertical(sLoose, { groundHeight: -0.05, dt: DT }, loose);
    sStrict = stepVertical(sStrict, { groundHeight: -0.05, dt: DT }, strict);
    expect(sLoose.airborne).toBe(true);
    expect(sStrict.airborne).toBe(false);
  });

  it("gravity param changes the fall acceleration", () => {
    let s1 = { y: 10, vy: 0, airborne: true };
    let s2 = { y: 10, vy: 0, airborne: true };
    const lowG: VerticalParams = { ...P, gravity: 5 };
    const highG: VerticalParams = { ...P, gravity: 40 };
    for (let i = 0; i < 30; i++) {
      s1 = stepVertical(s1, { groundHeight: -100, dt: DT }, lowG);
      s2 = stepVertical(s2, { groundHeight: -100, dt: DT }, highG);
    }
    expect(Math.abs(s2.vy)).toBeGreaterThan(Math.abs(s1.vy));
  });
});
