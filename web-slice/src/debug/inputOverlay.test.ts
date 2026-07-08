// Pure-logic tests for the input-highlight overlay (src/debug/inputOverlay.ts)
// — no DOM involved. Same split as paramPanel.test.ts: this project's vitest
// setup runs the default `node` environment (no jsdom/happy-dom installed),
// so DOM construction (InputOverlay's constructor/update createElement calls)
// is exercised manually in-browser instead; what's unit-tested here is the
// key-active logic (computeActiveKeys) and the SPACE hold/min-flash state
// machine (SpaceFlashState), which is exactly the part with real branching
// worth covering.
import { describe, expect, it } from "vitest";
import { computeActiveKeys, SPACE_MIN_FLASH_MS, SpaceFlashState } from "./inputOverlay";

describe("computeActiveKeys", () => {
  it("throttle 1 highlights only W", () => {
    expect(computeActiveKeys({ throttle: 1, steer: 0 })).toEqual({ w: true, a: false, s: false, d: false });
  });

  it("throttle -1 highlights only S", () => {
    expect(computeActiveKeys({ throttle: -1, steer: 0 })).toEqual({ w: false, a: false, s: true, d: false });
  });

  it("steer +1 (left) highlights only A, not D", () => {
    expect(computeActiveKeys({ throttle: 0, steer: 1 })).toEqual({ w: false, a: true, s: false, d: false });
  });

  it("steer -1 (right) highlights only D, not A", () => {
    expect(computeActiveKeys({ throttle: 0, steer: -1 })).toEqual({ w: false, a: false, s: false, d: true });
  });

  it("combines throttle and steer independently (W+A diagonal)", () => {
    expect(computeActiveKeys({ throttle: 1, steer: 1 })).toEqual({ w: true, a: true, s: false, d: false });
  });

  it("all-zero input highlights nothing", () => {
    expect(computeActiveKeys({ throttle: 0, steer: 0 })).toEqual({ w: false, a: false, s: false, d: false });
  });

  it("mid-zone analog values (below the 0.5 threshold) read as not-pressed", () => {
    expect(computeActiveKeys({ throttle: 0.3, steer: -0.3 })).toEqual({ w: false, a: false, s: false, d: false });
  });
});

describe("SpaceFlashState", () => {
  it("is inactive before any press", () => {
    const s = new SpaceFlashState();
    expect(s.isActive(0)).toBe(false);
  });

  it("is active while held", () => {
    const s = new SpaceFlashState();
    s.press(1000);
    expect(s.isActive(1000)).toBe(true);
    expect(s.isActive(1500)).toBe(true); // still held, arbitrarily long
  });

  it("goes inactive immediately after a long hold is released", () => {
    const s = new SpaceFlashState();
    s.press(1000);
    s.release(1000 + SPACE_MIN_FLASH_MS + 500); // held well past the min flash
    expect(s.isActive(1000 + SPACE_MIN_FLASH_MS + 500)).toBe(false);
  });

  it("a fast tap still reads active for at least SPACE_MIN_FLASH_MS after the press", () => {
    const s = new SpaceFlashState();
    s.press(1000);
    s.release(1005); // released almost instantly
    expect(s.isActive(1005)).toBe(true); // still within the flash window
    expect(s.isActive(1000 + SPACE_MIN_FLASH_MS - 1)).toBe(true);
    expect(s.isActive(1000 + SPACE_MIN_FLASH_MS + 1)).toBe(false);
  });

  it("re-pressing before the flash window elapses restarts the window from the new press", () => {
    const s = new SpaceFlashState();
    s.press(1000);
    s.release(1010);
    s.press(1050); // pressed again while the first flash was still fading
    s.release(1060);
    // Active relative to the SECOND press time, not the first.
    expect(s.isActive(1050 + SPACE_MIN_FLASH_MS - 1)).toBe(true);
    expect(s.isActive(1050 + SPACE_MIN_FLASH_MS + 1)).toBe(false);
  });
});
