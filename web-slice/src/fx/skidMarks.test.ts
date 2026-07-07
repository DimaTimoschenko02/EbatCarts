// Tests for the skid-mark fade curve (TTL fade-out). Gameplay-mode skid
// marks: record only while drifting, disappear after SKID_TTL_SEC seconds.
// See src/fx/skidMarks.ts header + .claude/rules/smooth-values.md.
import { describe, expect, it } from "vitest";
import { fadeFactorFor, SKID_TTL_SEC } from "./skidMarks";

describe("fadeFactorFor", () => {
  it("is fully bright at age 0", () => {
    expect(fadeFactorFor(0)).toBe(1);
  });

  it("is fully bright for any non-positive age", () => {
    expect(fadeFactorFor(-1)).toBe(1);
  });

  it("is fully gone at the TTL boundary", () => {
    expect(fadeFactorFor(SKID_TTL_SEC)).toBe(0);
  });

  it("is fully gone past the TTL boundary", () => {
    expect(fadeFactorFor(SKID_TTL_SEC + 5)).toBe(0);
  });

  it("is monotonically non-increasing as age grows", () => {
    const samples = 50;
    let prev = fadeFactorFor(0);
    for (let i = 1; i <= samples; i++) {
      const age = (i / samples) * (SKID_TTL_SEC + 2); // sweep past the boundary too
      const factor = fadeFactorFor(age);
      expect(factor).toBeLessThanOrEqual(prev + 1e-9);
      prev = factor;
    }
  });

  it("stays within [0, 1] across the whole domain", () => {
    for (let age = -2; age <= SKID_TTL_SEC + 2; age += 0.25) {
      const factor = fadeFactorFor(age);
      expect(factor).toBeGreaterThanOrEqual(0);
      expect(factor).toBeLessThanOrEqual(1);
    }
  });

  it("is roughly half-faded at the midpoint (smoothstep symmetry)", () => {
    expect(fadeFactorFor(SKID_TTL_SEC / 2)).toBeCloseTo(0.5, 5);
  });

  it("respects a custom ttlSec argument", () => {
    expect(fadeFactorFor(0, 2)).toBe(1);
    expect(fadeFactorFor(2, 2)).toBe(0);
    expect(fadeFactorFor(1, 2)).toBeCloseTo(0.5, 5);
  });
});
