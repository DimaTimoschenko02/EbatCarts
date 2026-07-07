import { describe, expect, it } from "vitest";
import { DEFAULT_KART_PHYSICS_PARAMS } from "../physics/types";
import { buildKartPhysicsParams, type KartStats } from "./stats";

describe("buildKartPhysicsParams", () => {
  it("overriding one field keeps every other field at its default", () => {
    const stats: KartStats = {
      id: "test",
      displayName: "Test Kart",
      model: "craft_racer",
      modelLength: 2.2,
      maxHp: 100,
      physics: { maxSpeed: 999 },
    };
    const params = buildKartPhysicsParams(stats);
    expect(params.maxSpeed).toBe(999);
    const { maxSpeed: _overridden, ...rest } = params;
    const { maxSpeed: _defaultOverridden, ...defaultRest } = DEFAULT_KART_PHYSICS_PARAMS;
    expect(rest).toEqual(defaultRest);
  });

  it("empty overrides reproduce the defaults exactly", () => {
    const stats: KartStats = {
      id: "test",
      displayName: "Test Kart",
      model: "craft_racer",
      modelLength: 2.2,
      maxHp: 100,
      physics: {},
    };
    expect(buildKartPhysicsParams(stats)).toEqual(DEFAULT_KART_PHYSICS_PARAMS);
  });
});
