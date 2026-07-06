// P1 vertical slice stand: real bicycle physics + auto-drift state machine
// (1:1 port from GDScript v3.1) driving a placeholder kart on a plane.
//
// Wiring order mirrors kart_controller.gd _physics_process:
//   smooth input → drift SM update → build PhysicsInput → bicycle.step()
//   → yaw += yawDelta + driftYawBonus → velocity ← newVelocity (+assist/boost)
//   → integrate position → visual lean + drift visual yaw offset on the mesh.
//
// Axis convention matches Godot: forward = -Z, right = +X, yaw around +Y
// (positive = CCW from above = left turn). The kart mesh nose points -Z.
//
// Physics runs on setInterval with fixed substeps (NOT rAF): Chrome fully
// suspends rAF for occluded windows, which breaks agent-driven testing.
// Scripted runs burn SIM time so they are deterministic at any render fps.
import * as THREE from "three";
import { BicyclePhysics } from "./physics/bicyclePhysics";
import { ContinuousDrift } from "./physics/driftContinuous";
import { DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY } from "./physics/types";
import type { PhysicsInput } from "./physics/types";
import { RearSkidMarks } from "./game/skidMarks";
import { loadAssetLibrary, loadKartModel } from "./game/assetLoader";
import { GameMap } from "./game/mapLoader";
import { createSpaceSky } from "./game/sky";

// ── Scene ──────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a1a);
scene.fog = new THREE.Fog(0x0a0a1a, 60, 140);
createSpaceSky(scene);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 300);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(20, 40, 10);
scene.add(sun);

// Backdrop plane far below the map so the void outside the arena reads as
// "space", not as a glitch. The actual driveable ground is the tile map.
const backdrop = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0x0d0d24 })
);
backdrop.rotation.x = -Math.PI / 2;
backdrop.position.y = -2;
scene.add(backdrop);

// Map + kart model load async: physics runs from frame one on a flat
// fallback (height 0) and switches to the map heightfield when it arrives.
// __ready flips only after everything is in — agent-driven tests wait on it.
let map: GameMap | null = null;
// Keep in sync with the editor palette (src/editor/main.ts) — a map driven
// from the editor must not silently drop tiles the game never preloaded.
const MAP_ASSETS = [
  "terrain", "terrain_ramp", "terrain_roadStraight", "terrain_roadCorner",
  "terrain_roadCross", "terrain_side", "terrain_sideCorner", "terrain_sideCornerInner",
  "rock_largeA", "rock_crystals", "rocks_smallA", "rocks_smallB",
] as const;

// Kart: outer group carries PHYSICS yaw; inner "baseCar" group carries the
// visual-only yaw offset (drift lean + state machine offset), mirroring the
// Godot $BaseCar child pattern. Nose points -Z (Godot forward convention).
const kart = new THREE.Group();
const baseCar = new THREE.Group();
kart.add(baseCar);
const body = new THREE.Mesh(
  new THREE.BoxGeometry(1.4, 0.5, 2.4),
  new THREE.MeshStandardMaterial({ color: 0xff4400 })
);
body.position.y = 0.45;
baseCar.add(body);
const cabin = new THREE.Mesh(
  new THREE.BoxGeometry(1.0, 0.4, 1.0),
  new THREE.MeshStandardMaterial({ color: 0x2266ff })
);
cabin.position.set(0, 0.85, -0.2);
baseCar.add(cabin);
const nose = new THREE.Mesh(
  new THREE.ConeGeometry(0.3, 0.6, 8),
  new THREE.MeshStandardMaterial({ color: 0xffff00, emissive: 0xffff00, emissiveIntensity: 0.5 })
);
nose.rotation.x = -Math.PI / 2;
nose.position.set(0, 0.5, -1.4); // -Z = forward
baseCar.add(nose);
kart.rotation.order = "YXZ"; // yaw first, then slope pitch
scene.add(kart);

(async () => {
  try {
    const lib = await loadAssetLibrary(MAP_ASSETS);
    // Editor hand-off: /?map=editor + a map JSON stashed in localStorage by
    // the "Drive" button in the browser map editor (see src/editor/main.ts).
    const driveJson = new URLSearchParams(location.search).get("map") === "editor"
      ? localStorage.getItem("editor-drive-map")
      : null;
    map = driveJson ? GameMap.fromJson(JSON.parse(driveJson), lib) : await GameMap.load("/maps/arena_slice.json", lib);
    scene.add(map.root);
    // Debug handles for agent-driven inspection (vertex reads, cell probes).
    (window as unknown as Record<string, unknown>).__map = map;
    (window as unknown as Record<string, unknown>).__scene = scene;
    const model = await loadKartModel("craft_racer", 2.2);
    baseCar.clear(); // drop the placeholder box kart
    baseCar.add(model);
  } catch (e) {
    console.error("[boot] asset load failed, driving on the fallback plane", e);
  }
  window.__ready = true;
})();

// ── Input: real keys + scripted override ───────────────────────────────
const keys: Record<string, boolean> = {};
addEventListener("keydown", e => { keys[e.code] = true; });
addEventListener("keyup", e => { keys[e.code] = false; });

// Scripted input for deterministic agent-driven runs.
// window.__runScript([{throttle, steer, ms}, ...]) — steps run sequentially
// in SIMULATED time, so runs are deterministic at any render fps.
// Steer convention matches Godot input axis: +1 = LEFT, -1 = RIGHT.
interface ScriptStep { throttle: number; steer: number; ms: number }
let script: { steps: ScriptStep[]; i: number; remainingMs: number } | null = null;

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
  }
}
window.__camMode = "chase"; // "top" = диагностический вид сверху (клавиша C)
window.__topHeight = 70; // высота top-камеры, крутится из консоли для зума
addEventListener("keydown", e => {
  if (e.code === "KeyC") window.__camMode = window.__camMode === "chase" ? "top" : "chase";
});

window.__runScript = steps => {
  script = { steps, i: 0, remainingMs: steps[0].ms };
  window.__scriptDone = false;
  return "started " + steps.length + " steps";
};
window.__scriptDone = true;

// Advances script clock by one substep; returns raw input for this substep.
function currentRawInput(stepMs: number): { throttle: number; steer: number } {
  if (script) {
    const s = script.steps[script.i];
    script.remainingMs -= stepMs;
    if (script.remainingMs <= 0) {
      script.i++;
      if (script.i >= script.steps.length) {
        script = null;
        window.__scriptDone = true;
      } else {
        script.remainingMs = script.steps[script.i].ms;
      }
    }
    return { throttle: s.throttle, steer: s.steer };
  }
  const throttle = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  const steer = (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0); // A = left = +1
  return { throttle, steer };
}

// ── Physics: real bicycle model + continuous drift v4.0 ────────────────
const params = { ...DEFAULT_KART_PHYSICS_PARAMS };
const bicycle = new BicyclePhysics(params);
const driftSM = new ContinuousDrift(params);

// Skid trails: diagnostic-first — any drift-transition kink is visible as
// an angle in the arc. Records continuously; brightness = slip intensity.
const skids = new RearSkidMarks(scene, DEFAULT_AXLE_GEOMETRY.wheelbase, DEFAULT_AXLE_GEOMETRY.trackWidth);

// Spawn just inside the ring road, south of the plateau, facing -Z (north).
const SPAWN = new THREE.Vector3(0, 0, 6.5);
// Max climbable rise per move — a full tile step is 0.5, ramps rise gradually.
const MAX_STEP = 0.3;
const state = {
  pos: SPAWN.clone(),
  vel: new THREE.Vector3(),
  yaw: 0,
};
// Smoothed inputs (kart_controller._smooth_input equivalents).
let throttleSm = 0;
let steerSm = 0;
// Visual lean state (kart_controller._visual_drift_angle equivalent).
let visualDriftAngle = 0;
let driftVisualYaw = 0;
// Heightfield follow state: smoothed ground height + slope pitch.
let groundY = 0;
let pitchSm = 0;
// Last-step outputs cached for telemetry.
let lastOut = {
  fwdSpeed: 0, sideSpeed: 0, omega: 0,
  driftIntensity: 0, isDrifting: false, slipRatio: 0,
  rearLat: 0, engageFactor: 0, driftActive: false, driftPower: 0,
  rearGripMult: 1,
};

window.__reset = () => {
  state.pos.copy(SPAWN); state.vel.set(0, 0, 0);
  state.yaw = 0;
  throttleSm = 0; steerSm = 0;
  visualDriftAngle = 0; driftVisualYaw = 0;
  groundY = 0; pitchSm = 0;
  bicycle.reset();
  driftSM.reset();
  skids.clear();
  trace.length = 0;
  return "reset";
};

// Godot: forward = -Z rotated by yaw around +Y.
function forwardOf(yaw: number): THREE.Vector3 {
  return new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
}
function rightOf(yaw: number): THREE.Vector3 {
  return new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
}

function smoothInput(raw: { throttle: number; steer: number }, dt: number): void {
  const slew = Math.abs(raw.steer) > Math.abs(steerSm) ? params.steerSlewRateIn : params.steerSlewRateOut;
  const steerAlpha = 1 - Math.exp(-slew * dt);
  steerSm += (raw.steer - steerSm) * steerAlpha;
  if (Math.abs(steerSm) < 0.01 && Math.abs(raw.steer) < 0.01) steerSm = 0;
  const thrAlpha = 1 - Math.exp(-params.throttleSlewRate * dt);
  throttleSm += (raw.throttle - throttleSm) * thrAlpha;
}

function step(dt: number, raw: { throttle: number; steer: number }): void {
  // 1. Input smoothing.
  smoothInput(raw, dt);

  // 3. Drift state machine BEFORE bicycle (feeds rear_grip_multiplier).
  const fwdDir = forwardOf(state.yaw);
  const planarSpeed = Math.hypot(state.vel.x, state.vel.z);
  const fwdSigned = state.vel.dot(fwdDir);
  const drift = driftSM.update(planarSpeed, steerSm, true, throttleSm, dt);
  driftVisualYaw = drift.visualYawOffsetRad;

  // 4. Build PhysicsInput.
  const rightDir = rightOf(state.yaw);
  const inp: PhysicsInput = {
    velocity: { x: state.vel.x, y: state.vel.y, z: state.vel.z },
    forward: { x: fwdDir.x, y: 0, z: fwdDir.z },
    right: { x: rightDir.x, y: 0, z: rightDir.z },
    throttle: throttleSm,
    steerInput: steerSm,
    brakeHeld: raw.throttle < 0,
    onFloor: true,
    rearGripMultiplier: drift.rearGripMultiplier,
  };

  // 5. Bicycle physics step.
  const out = bicycle.step(inp, dt);

  // 6. Yaw: bicycle delta + drift bonus.
  state.yaw += out.yawDelta + drift.yawBonusRadPerSec * dt;

  // 7. Velocity: bicycle XZ, then forward assist + exit boost along POST-rotation forward.
  state.vel.set(out.newVelocity.x, 0, out.newVelocity.z);
  const assist = drift.forwardAssistForce + drift.exitBoostForce;
  if (Math.abs(assist) > 0 && fwdSigned >= 0) {
    const fwdAfter = forwardOf(state.yaw);
    state.vel.addScaledVector(fwdAfter, assist * dt);
  }

  // 8. Integrate position with map collision: axis-separated point move.
  // A rise taller than MAX_STEP — or leaving the map — is a wall: that axis
  // component of velocity is cancelled, the other keeps sliding (poor man's
  // move_and_slide, enough for axis-aligned cliffs and map borders).
  if (map) {
    const curH = map.sampleHeight(state.pos.x, state.pos.z) ?? groundY;
    const nx = state.pos.x + state.vel.x * dt;
    const hx = map.sampleHeight(nx, state.pos.z);
    if (hx === null || hx - curH > MAX_STEP) state.vel.x = 0;
    else state.pos.x = nx;
    const nz = state.pos.z + state.vel.z * dt;
    const hz = map.sampleHeight(state.pos.x, nz);
    if (hz === null || hz - curH > MAX_STEP) state.vel.z = 0;
    else state.pos.z = nz;
  } else {
    state.pos.addScaledVector(state.vel, dt);
  }

  // 8b. Follow the heightfield: smoothed height + slope pitch from a fore/aft
  // probe pair (half wheelbase each way). Both are exp-filters — C1 smooth
  // over ramp lips at any framerate (smooth-values rule).
  const hHere = map?.sampleHeight(state.pos.x, state.pos.z) ?? 0;
  groundY += (hHere - groundY) * (1 - Math.exp(-20 * dt));
  state.pos.y = groundY;
  const probe = DEFAULT_AXLE_GEOMETRY.wheelbase * 0.5;
  const hF = map?.sampleHeight(state.pos.x + fwdDir.x * probe, state.pos.z + fwdDir.z * probe) ?? hHere;
  const hB = map?.sampleHeight(state.pos.x - fwdDir.x * probe, state.pos.z - fwdDir.z * probe) ?? hHere;
  const targetPitch = Math.atan2(hF - hB, DEFAULT_AXLE_GEOMETRY.wheelbase);
  pitchSm += (targetPitch - pitchSm) * (1 - Math.exp(-10 * dt));

  // Skid trails: intensity from actual rear slip normalized like drift_intensity.
  const slipNorm = Math.min(Math.abs(out.rearLeftLatSpeed) / Math.max(params.driftMaxSlipSpeed, 0.01), 1);
  skids.update(state.pos, state.yaw, slipNorm);

  // 11. Visual lean (omega-driven) — smoothed toward intensity*maxDeg*(-omegaNorm).
  const omegaNorm = Math.min(Math.max(out.omega / Math.max(params.omegaLeanScale, 0.01), -1), 1);
  const targetLean = (out.driftIntensity * params.visualDriftMaxDeg * -omegaNorm) * Math.PI / 180;
  const leanAlpha = 1 - Math.exp(-params.visualLeanRecoverySpeed * dt);
  visualDriftAngle += (targetLean - visualDriftAngle) * leanAlpha;

  lastOut = {
    fwdSpeed: out.fwdSpeed, sideSpeed: out.sideSpeed, omega: out.omega,
    driftIntensity: out.driftIntensity, isDrifting: out.isDrifting, slipRatio: out.slipRatio,
    rearLat: out.rearLeftLatSpeed, engageFactor: drift.engageFactor,
    driftActive: drift.isActive, driftPower: drift.power,
    rearGripMult: drift.rearGripMultiplier,
  };
}

// ── Telemetry ──────────────────────────────────────────────────────────
const trace: Record<string, number | boolean>[] = []; // ring buffer, 0.1 sim-sec sampling
window.__trace = trace;
let simTime = 0;
let lastSample = 0;

function sampleTelemetry(t: number, input: { throttle: number; steer: number }) {
  return {
    t: +t.toFixed(2),
    x: +state.pos.x.toFixed(3), z: +state.pos.z.toFixed(3),
    y: +state.pos.y.toFixed(3),
    yaw: +state.yaw.toFixed(3), omega: +lastOut.omega.toFixed(3),
    speed: +state.vel.length().toFixed(3),
    fwdSpeed: +lastOut.fwdSpeed.toFixed(3), latSpeed: +lastOut.sideSpeed.toFixed(3),
    throttle: input.throttle, steer: input.steer,
    driftIntensity: +lastOut.driftIntensity.toFixed(3),
    driftActive: lastOut.driftActive,
    engageFactor: +lastOut.engageFactor.toFixed(3),
    driftPower: +lastOut.driftPower.toFixed(3),
    rearGripMult: +lastOut.rearGripMult.toFixed(3),
    rearLat: +lastOut.rearLat.toFixed(3),
    scriptDone: window.__scriptDone,
  };
}

const hud = document.getElementById("hud")!;

// ── Main loop ──────────────────────────────────────────────────────────
const PHYS_STEP = 1 / 120;
const MAX_CATCHUP = 1.1; // never simulate more than ~1s per tick
let prev = performance.now();
let acc = 0;

// Physics ticks on setInterval, NOT rAF (see file header). rAF renders only.
function physTick() {
  const now = performance.now();
  acc += Math.min((now - prev) / 1000, MAX_CATCHUP);
  prev = now;
  let input = { throttle: 0, steer: 0 };
  while (acc >= PHYS_STEP) {
    input = currentRawInput(PHYS_STEP * 1000);
    step(PHYS_STEP, input);
    simTime += PHYS_STEP;
    if (simTime - lastSample >= 0.1) {
      lastSample = simTime;
      trace.push(sampleTelemetry(simTime, input));
      if (trace.length > 600) trace.shift();
    }
    acc -= PHYS_STEP;
  }
  window.__telemetry = sampleTelemetry(simTime, input);
}
setInterval(physTick, 50);

function frame() {
  requestAnimationFrame(frame);
  physTick(); // keep input latency low when rAF is alive
  const dt = 0.05; // camera lerp smoothing only

  kart.position.copy(state.pos);
  kart.rotation.y = state.yaw;
  kart.rotation.x = pitchSm; // slope pitch (order YXZ: yaw, then pitch)
  // Visual-only yaw offset on the inner group ($BaseCar pattern):
  // emergent omega lean + drift state machine offset.
  baseCar.rotation.y = visualDriftAngle + driftVisualYaw;

  if (window.__camMode === "top") {
    // Diagnostic top-down: high above the kart, north-up — trail arcs and any
    // kinks in them are directly readable.
    // Slight south offset keeps lookAt's up-vector well-conditioned (a dead
    // vertical view makes the roll indeterminate → the map renders "diamond").
    const camTarget = state.pos.clone()
      .add(new THREE.Vector3(0, window.__topHeight, window.__topHeight * 0.25));
    camera.position.lerp(camTarget, 1 - Math.exp(-4 * dt));
    camera.lookAt(state.pos.x, state.pos.y, state.pos.z);
  } else {
    // Chase camera sits BEHIND the kart: behind = -forward.
    const fwd = forwardOf(state.yaw);
    const camTarget = state.pos.clone()
      .addScaledVector(fwd, -8)
      .add(new THREE.Vector3(0, 5, 0));
    camera.position.lerp(camTarget, 1 - Math.exp(-4 * dt));
    camera.lookAt(state.pos.x, state.pos.y + 1, state.pos.z);
  }

  const tm = window.__telemetry ?? {};
  hud.textContent =
    `pos  ${state.pos.x.toFixed(1)}, ${state.pos.z.toFixed(1)}\n` +
    `spd  ${state.vel.length().toFixed(1)} m/s  (lat ${Number(tm.latSpeed ?? 0).toFixed(1)})\n` +
    `yaw  ${(state.yaw * 180 / Math.PI % 360).toFixed(0)}°  ω ${lastOut.omega.toFixed(2)}\n` +
    `drift ${lastOut.driftActive ? "ACTIVE" : "—"}  int ${lastOut.driftIntensity.toFixed(2)}  engage ${lastOut.engageFactor.toFixed(2)}\n` +
    `in   thr ${Number(tm.throttle ?? 0)}  steer ${Number(tm.steer ?? 0)}${script ? "  [SCRIPT]" : ""}`;

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
// __ready is set by the async asset-loading IIFE above.
