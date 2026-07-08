// Debug/capture aid: highlights W/A/S/D + SPACE on-screen as they're held so
// gameplay recordings show what the driver is actually pressing (the text
// HUD's raw throttle/steer numbers don't read on video). Purely visual — does
// NOT read the DOM back into gameplay, and never calls input.consumeFire()
// (that's a one-shot latch owned by main.ts for the actual fire action; this
// overlay tracks Space/click hold state independently via its own listeners).
import type { RawInput } from "../core/input";

const KEY_ORDER = ["w", "a", "s", "d", "space"] as const;
export type OverlayKey = (typeof KEY_ORDER)[number];

// ─── Pure logic (unit-testable without a DOM — see inputOverlay.test.ts,
// mirrors the paramPanel.ts split of pure helpers vs. DOM wiring) ─────────

// Which of W/A/S/D should read as "held" for a given physics RawInput.
// Mid-zone (e.g. a controller/analog source giving 0.3) reads as neither
// pressed — the overlay is a discrete key-press indicator, not a gauge.
export function computeActiveKeys(input: RawInput): Record<"w" | "a" | "s" | "d", boolean> {
  return {
    w: input.throttle > 0.5,
    s: input.throttle < -0.5,
    a: input.steer > 0.5, // steer +1 = A = left, see core/input.ts header
    d: input.steer < -0.5,
  };
}

// SPACE/fire has no continuous RawInput signal (it's edge-triggered in
// InputController), so the overlay tracks press/release itself. Enforces a
// minimum visible flash so a fast tap still reads on a 30/60fps recording
// instead of blinking for a single frame.
export const SPACE_MIN_FLASH_MS = 150;

export class SpaceFlashState {
  private held = false;
  private pressedAtMs: number | null = null;

  press(nowMs: number): void {
    this.held = true;
    this.pressedAtMs = nowMs;
  }

  release(_nowMs: number): void {
    this.held = false;
    // pressedAtMs stays set — isActive() keeps the flash alive until the
    // minimum duration has elapsed, then it naturally reads inactive.
  }

  isActive(nowMs: number, minFlashMs: number = SPACE_MIN_FLASH_MS): boolean {
    if (this.held) return true;
    if (this.pressedAtMs === null) return false;
    return nowMs - this.pressedAtMs < minFlashMs;
  }
}

// ─── DOM widget ────────────────────────────────────────────────────────────

const ACTIVE_BG = "#00e5ff"; // electric cyan, matches decision_ui_neon_stadium palette
const ACTIVE_FG = "#0a0a1a";
const IDLE_BG = "rgba(10, 10, 30, 0.55)";
const IDLE_FG = "#ffffff";
const KEY_SIZE = 44;
const GAP = 6;

function makeKeyEl(label: string, width: number = KEY_SIZE): HTMLDivElement {
  const el = document.createElement("div");
  el.textContent = label;
  el.style.cssText = [
    `width: ${width}px`,
    `height: ${KEY_SIZE}px`,
    "display: flex",
    "align-items: center",
    "justify-content: center",
    "font: 700 15px/1 monospace",
    "letter-spacing: 0.5px",
    "border-radius: 8px",
    `border: 1px solid rgba(255,255,255,0.25)`,
    `background: ${IDLE_BG}`,
    `color: ${IDLE_FG}`,
    // Transition is managed per-state in setActive(): instant on, 60ms off.
    "transition: none",
    "user-select: none",
  ].join(";");
  return el;
}

function setActive(el: HTMLDivElement, active: boolean): void {
  // Going active is instant (transition: none) so the flash lands on the
  // exact frame the key was pressed — recordings are frame-analyzed. Only
  // the fade-out is smoothed.
  el.style.transition = active ? "none" : "background 60ms linear, color 60ms linear";
  el.style.background = active ? ACTIVE_BG : IDLE_BG;
  el.style.color = active ? ACTIVE_FG : IDLE_FG;
  el.style.boxShadow = active ? `0 0 12px 2px ${ACTIVE_BG}99` : "none";
}

export class InputOverlay {
  private readonly root: HTMLDivElement;
  private readonly keyEls: Record<OverlayKey, HTMLDivElement>;
  private readonly spaceFlash = new SpaceFlashState();

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement("div");
    this.root.style.cssText = [
      "position: fixed",
      "left: 50%",
      "bottom: 16px",
      "transform: translateX(-50%)",
      "display: flex",
      `gap: ${GAP}px`,
      "align-items: flex-end",
      "pointer-events: none",
      "z-index: 20",
    ].join(";");

    // W/A/S/D laid out like a keyboard: W centered above the A-S-D row.
    const wasd = document.createElement("div");
    wasd.style.cssText = `display: flex; flex-direction: column; gap: ${GAP}px;`;

    const wRow = document.createElement("div");
    wRow.style.cssText = `display: flex; justify-content: center;`;
    const w = makeKeyEl("W");
    wRow.appendChild(w);

    const asdRow = document.createElement("div");
    asdRow.style.cssText = `display: flex; gap: ${GAP}px;`;
    const a = makeKeyEl("A");
    const s = makeKeyEl("S");
    const d = makeKeyEl("D");
    asdRow.append(a, s, d);

    wasd.append(wRow, asdRow);

    const space = makeKeyEl("SPACE", KEY_SIZE * 3 + GAP * 2);
    space.style.alignSelf = "flex-end";

    this.root.append(wasd, space);
    parent.appendChild(this.root);

    this.keyEls = { w, a, s, d, space };

    // Space/left-click hold tracking — independent of InputController's
    // one-shot fire latch (see file header). Left click only counts while
    // the pointer is actually down; releasing outside the canvas still
    // fires "mouseup" on window so this can't get stuck highlighted.
    addEventListener("keydown", e => {
      if (e.code === "Space") this.spaceFlash.press(performance.now());
    });
    addEventListener("keyup", e => {
      if (e.code === "Space") this.spaceFlash.release(performance.now());
    });
    addEventListener("mousedown", e => {
      if (e.button === 0) this.spaceFlash.press(performance.now());
    });
    addEventListener("mouseup", e => {
      if (e.button === 0) this.spaceFlash.release(performance.now());
    });
  }

  // Call once per rendered frame with the same RawInput that just fed the
  // physics substep (see main.ts) — deliberately NOT per-substep, this is a
  // display, not a sim input.
  update(input: RawInput): void {
    const active = computeActiveKeys(input);
    setActive(this.keyEls.w, active.w);
    setActive(this.keyEls.a, active.a);
    setActive(this.keyEls.s, active.s);
    setActive(this.keyEls.d, active.d);
    setActive(this.keyEls.space, this.spaceFlash.isActive(performance.now()));
  }
}
