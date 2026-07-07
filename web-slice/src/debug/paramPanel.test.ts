// Pure-logic tests for the dev param panel — no DOM involved (DOM wiring is
// exercised manually in-browser per the ui-programmer task; see main.ts).
import { describe, expect, it } from "vitest";
import { DEFAULT_KART_PHYSICS_PARAMS } from "../physics/types";
import { applyOverrides, diffFromDefaults, parseStoredOverrides } from "./paramPanel";

describe("diffFromDefaults", () => {
  it("returns empty object when nothing changed", () => {
    const current = { ...DEFAULT_KART_PHYSICS_PARAMS };
    expect(diffFromDefaults(current)).toEqual({});
  });

  it("includes only the fields that differ from defaults", () => {
    const current = { ...DEFAULT_KART_PHYSICS_PARAMS, maxSpeed: 30, rearGripStiffness: 5 };
    const diff = diffFromDefaults(current);
    expect(diff).toEqual({ maxSpeed: 30, rearGripStiffness: 5 });
  });

  it("picks up a changed boolean field", () => {
    const current = { ...DEFAULT_KART_PHYSICS_PARAMS, autoDriftEnabled: !DEFAULT_KART_PHYSICS_PARAMS.autoDriftEnabled };
    expect(diffFromDefaults(current)).toEqual({ autoDriftEnabled: !DEFAULT_KART_PHYSICS_PARAMS.autoDriftEnabled });
  });
});

describe("parseStoredOverrides", () => {
  it("returns {} for null / invalid JSON", () => {
    expect(parseStoredOverrides(null)).toEqual({});
    expect(parseStoredOverrides("not json")).toEqual({});
  });

  it("returns {} for a JSON value that isn't an object", () => {
    expect(parseStoredOverrides("42")).toEqual({});
    expect(parseStoredOverrides("null")).toEqual({});
  });

  it("keeps only known KartPhysicsParams keys with number/boolean values", () => {
    const raw = JSON.stringify({
      maxSpeed: 30,
      autoDriftEnabled: false,
      thisFieldWasRenamedOrRemoved: 123,
      rearGripStiffness: "not a number",
    });
    expect(parseStoredOverrides(raw)).toEqual({ maxSpeed: 30, autoDriftEnabled: false });
  });
});

describe("applyOverrides", () => {
  it("mutates the target object in place (live-apply mechanism)", () => {
    const target = { ...DEFAULT_KART_PHYSICS_PARAMS };
    applyOverrides(target, { maxSpeed: 99, autoDriftEnabled: false });
    expect(target.maxSpeed).toBe(99);
    expect(target.autoDriftEnabled).toBe(false);
    // Everything else untouched.
    expect(target.accelForce).toBe(DEFAULT_KART_PHYSICS_PARAMS.accelForce);
  });

  it("round-trips through diffFromDefaults + applyOverrides back to the same values", () => {
    const tuned = { ...DEFAULT_KART_PHYSICS_PARAMS, kDrag: 0.03, driftYawBonus: 2.5 };
    const diff = diffFromDefaults(tuned);
    const rebuilt = { ...DEFAULT_KART_PHYSICS_PARAMS };
    applyOverrides(rebuilt, diff);
    expect(rebuilt).toEqual(tuned);
  });
});
