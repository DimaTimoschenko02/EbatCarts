// All window.__* debug/agent-testing API + HUD text. External self-test
// scripts are wired to these exact names/semantics — do not rename or change
// behavior without updating the scripts that drive them.
import type * as THREE from "three";
import type { GameMap } from "../map/mapLoader";
import type { Kart } from "../kart/kart";
import type { InputController, RawInput, ScriptStep } from "../core/input";

declare global {
  interface Window {
    __runScript: (steps: ScriptStep[]) => string;
    __scriptDone: boolean;
    __reset: () => string;
    __telemetry: Record<string, number | boolean>;
    __trace: Record<string, number | boolean>[];
    __ready: boolean;
    __camMode: "chase" | "top";
    __topHeight: number;
    // Multiplayer skeleton status — set by src/net/index.ts (initNet).
    // `connected` flips to true once the Colyseus match server handshake
    // completes; stays false forever in offline mode (server unreachable is
    // NOT an error, see net/netClient.ts). `players` is the count of OTHER
    // connected players currently rendered (excludes the local kart).
    __net: { connected: boolean; players: number };
  }
}

type TraceEntry = Record<string, number | boolean>;

export class Telemetry {
  private readonly trace: TraceEntry[] = [];
  private simTime = 0;
  private lastSample = 0;

  constructor(private readonly kart: Kart, private readonly input: InputController) {
    window.__trace = this.trace;
    window.__camMode = "chase"; // "top" = диагностический вид сверху (клавиша C)
    window.__topHeight = 70; // высота top-камеры, крутится из консоли для зума
    window.__scriptDone = true;
    window.__runScript = steps => this.input.runScript(steps);
    window.__reset = () => this.reset();

    addEventListener("keydown", e => {
      if (e.code === "KeyC") window.__camMode = window.__camMode === "chase" ? "top" : "chase";
    });
  }

  // Debug handles for agent-driven inspection (vertex reads, cell probes).
  setMapHandles(map: GameMap, scene: THREE.Scene): void {
    (window as unknown as Record<string, unknown>).__map = map;
    (window as unknown as Record<string, unknown>).__scene = scene;
  }

  markReady(): void {
    window.__ready = true;
  }

  private reset(): string {
    this.kart.reset();
    this.trace.length = 0;
    return "reset";
  }

  // Call once per physics substep — advances the sim clock, samples into the
  // ring buffer every 0.1 sim-sec, and always refreshes window.__telemetry.
  recordSubstep(dt: number, input: RawInput): void {
    this.simTime += dt;
    window.__scriptDone = this.input.scriptDone;
    if (this.simTime - this.lastSample >= 0.1) {
      this.lastSample = this.simTime;
      this.trace.push(this.sample(input));
      if (this.trace.length > 600) this.trace.shift();
    }
    window.__telemetry = this.sample(input);
  }

  private sample(input: RawInput): TraceEntry {
    const out = this.kart.lastOutput;
    return {
      t: +this.simTime.toFixed(2),
      x: +this.kart.position.x.toFixed(3), z: +this.kart.position.z.toFixed(3),
      y: +this.kart.position.y.toFixed(3),
      yaw: +this.kart.yaw.toFixed(3), omega: +out.omega.toFixed(3),
      speed: +this.kart.velocity.length().toFixed(3),
      fwdSpeed: +out.fwdSpeed.toFixed(3), latSpeed: +out.sideSpeed.toFixed(3),
      throttle: input.throttle, steer: input.steer,
      driftIntensity: +out.driftIntensity.toFixed(3),
      driftActive: out.driftActive,
      engageFactor: +out.engageFactor.toFixed(3),
      driftPower: +out.driftPower.toFixed(3),
      rearGripMult: +out.rearGripMult.toFixed(3),
      rearLat: +out.rearLat.toFixed(3),
      scriptDone: window.__scriptDone,
    };
  }

  updateHud(hud: HTMLElement): void {
    const tm = window.__telemetry ?? {};
    const out = this.kart.lastOutput;
    hud.textContent =
      `pos  ${this.kart.position.x.toFixed(1)}, ${this.kart.position.z.toFixed(1)}\n` +
      `spd  ${this.kart.velocity.length().toFixed(1)} m/s  (lat ${Number(tm.latSpeed ?? 0).toFixed(1)})\n` +
      `yaw  ${(this.kart.yaw * 180 / Math.PI % 360).toFixed(0)}°  ω ${out.omega.toFixed(2)}\n` +
      `drift ${out.driftActive ? "ACTIVE" : "—"}  int ${out.driftIntensity.toFixed(2)}  engage ${out.engageFactor.toFixed(2)}\n` +
      `in   thr ${Number(tm.throttle ?? 0)}  steer ${Number(tm.steer ?? 0)}${this.input.isScripted ? "  [SCRIPT]" : ""}`;
  }
}
