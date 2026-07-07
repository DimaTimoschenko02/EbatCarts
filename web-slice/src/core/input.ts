// Real keyboard input + scripted override for deterministic agent-driven
// runs. window.__runScript([{throttle, steer, ms}, ...]) — steps run
// sequentially in SIMULATED time, so runs are deterministic at any render
// fps (wiring lives in debug/telemetry.ts, which owns the window.* surface).
// Steer convention matches Godot input axis: +1 = LEFT, -1 = RIGHT.
export interface RawInput {
  throttle: number;
  steer: number;
}

export interface ScriptStep extends RawInput {
  ms: number;
}

interface ScriptCursor {
  steps: ScriptStep[];
  i: number;
  remainingMs: number;
}

export class InputController {
  private readonly keys: Record<string, boolean> = {};
  private script: ScriptCursor | null = null;
  private _scriptDone = true;
  // Fire is edge-triggered (press, not hold) so holding the button down
  // doesn't spam "fire" messages every frame — the server would just ignore
  // the extras anyway (weapon already consumed after the first shot), but
  // there's no reason to send them. Latched between consumeFire() polls.
  private firePressed = false;

  constructor() {
    addEventListener("keydown", e => {
      this.keys[e.code] = true;
      if (e.code === "Space") this.firePressed = true;
    });
    addEventListener("keyup", e => { this.keys[e.code] = false; });
    addEventListener("mousedown", e => {
      if (e.button === 0) this.firePressed = true; // left click
    });
  }

  // True at most once per press (Space or left-click), however long the
  // button is held. Call once per rendered frame.
  consumeFire(): boolean {
    if (!this.firePressed) return false;
    this.firePressed = false;
    return true;
  }

  get scriptDone(): boolean {
    return this._scriptDone;
  }

  get isScripted(): boolean {
    return this.script !== null;
  }

  runScript(steps: ScriptStep[]): string {
    this.script = { steps, i: 0, remainingMs: steps[0].ms };
    this._scriptDone = false;
    return "started " + steps.length + " steps";
  }

  // Advances the script clock by one substep and returns the raw input for
  // it; falls back to live keyboard state once the script finishes (or if
  // none is running).
  next(stepMs: number): RawInput {
    if (this.script) {
      const s = this.script.steps[this.script.i];
      this.script.remainingMs -= stepMs;
      if (this.script.remainingMs <= 0) {
        this.script.i++;
        if (this.script.i >= this.script.steps.length) {
          this.script = null;
          this._scriptDone = true;
        } else {
          this.script.remainingMs = this.script.steps[this.script.i].ms;
        }
      }
      return { throttle: s.throttle, steer: s.steer };
    }
    const throttle = (this.keys.KeyW ? 1 : 0) - (this.keys.KeyS ? 1 : 0);
    const steer = (this.keys.KeyA ? 1 : 0) - (this.keys.KeyD ? 1 : 0); // A = left = +1
    return { throttle, steer };
  }
}
