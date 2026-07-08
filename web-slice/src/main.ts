// P1 vertical slice stand: real bicycle physics + continuous drift driving
// a data-driven kart on a tile map. See kart/kart.ts for the physics wiring
// and design/gdd/kart-physics*.md for the spec this ports.
//
// Physics runs on setInterval with fixed substeps (NOT rAF): Chrome fully
// suspends rAF for occluded windows, which breaks agent-driven testing. See
// core/loop.ts.
import * as THREE from "three";
import { createSpaceSky } from "./fx/sky";
import { loadAssetLibrary } from "./map/assetLoader";
import { GameMap } from "./map/mapLoader";
import { Kart } from "./kart/kart";
import { KART_TYPES } from "./kart/stats";
import { InputController } from "./core/input";
import { FixedStepLoop } from "./core/loop";
import { ChaseCamera } from "./core/camera";
import { Telemetry } from "./debug/telemetry";
import { InputOverlay } from "./debug/inputOverlay";
import { initParamPanel } from "./debug/paramPanel";
import { initNet } from "./net";
import { createCombat } from "./combat";

// Keep in sync with the editor palette (src/editor/main.ts) — a map driven
// from the editor must not silently drop tiles the game never preloaded.
const MAP_ASSETS = [
  "terrain", "terrain_ramp", "terrain_roadStraight", "terrain_roadCorner",
  "terrain_roadCross", "terrain_side", "terrain_sideCorner", "terrain_sideCornerInner",
  "rock_largeA", "rock_crystals", "rocks_smallA", "rocks_smallB",
] as const;

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

// Spawn just inside the ring road, south of the plateau, facing -Z (north).
const SPAWN = new THREE.Vector3(0, 0, 6.5);
const stats = KART_TYPES.racer;
const kart = new Kart(scene, stats, SPAWN);

const chaseCamera = new ChaseCamera();
const input = new InputController();
const telemetry = new Telemetry(kart, input);
initParamPanel(kart); // dev tuner overlay, toggled with P — see src/debug/paramPanel.ts
const inputOverlay = new InputOverlay(); // W/A/S/D + SPACE key highlight, for gameplay recordings
const hud = document.getElementById("hud")!;

// Combat wiring (weapons/damage/death/respawn/pickups) — server-authoritative,
// see src/combat/index.ts and server/rooms/MatchRoom.ts. Strictly optional
// like net/ itself: with no server, combat.update() just renders "offline"
// and the fire button is a no-op.
const combat = createCombat(scene, kart);

// Multiplayer skeleton: owner-authoritative, strictly optional (see net/).
// Runs its own connect/send/interpolate lifecycle — nothing else in this
// file ever touches net/ internals again after this call except to pass
// net.client into combat.update() and net.getObstacles() into kart.update()
// each frame.
const net = initNet({
  scene,
  getLocalState: () => ({ x: kart.position.x, y: kart.position.y, z: kart.position.z, yaw: kart.yaw }),
  combat: combat.netCallbacks,
});

// Map + kart model load async: physics runs from frame one on a flat
// fallback (height 0) and switches to the map heightfield when it arrives.
// __ready flips only after everything is in — agent-driven tests wait on it.
let map: GameMap | null = null;
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
    telemetry.setMapHandles(map, scene);
    net.setMap(map); // remote-kart body tilt (src/net/remoteKarts.ts) needs the heightfield too
    await kart.loadModel(stats.model, stats.modelLength);
  } catch (e) {
    console.error("[boot] asset load failed, driving on the fallback plane", e);
  }
  telemetry.markReady();
})();

// ── Main loop ──────────────────────────────────────────────────────────
const PHYS_STEP = 1 / 120;
const MAX_CATCHUP = 1.1; // never simulate more than ~1s per tick
const loop = new FixedStepLoop(PHYS_STEP, MAX_CATCHUP);

// Physics ticks on setInterval, NOT rAF (see file header). rAF renders only.
// lastRawInput feeds the input overlay once per rendered frame below — it's
// deliberately updated per-substep but only READ once per frame, so the
// overlay shows the most recent input without re-driving physics itself.
let lastRawInput = { throttle: 0, steer: 0 };
function physTick(): void {
  loop.tick(dt => {
    const raw = input.next(dt * 1000);
    kart.update(dt, raw, map, net.getObstacles());
    telemetry.recordSubstep(dt, raw);
    lastRawInput = raw;
  });
}
setInterval(physTick, 50);

let lastFrameMs = performance.now();
function frame(): void {
  requestAnimationFrame(frame);
  physTick(); // keep input latency low when rAF is alive
  kart.syncVisual();
  const now = performance.now();
  // Real per-frame dt (not physics' fixed substep) — the camera only runs
  // once per rendered frame, so it needs actual frame time for its
  // framerate-independent follow filter (see camera.ts). Clamped so a
  // tab-backgrounding stall doesn't feed the exp-follow a huge dt and snap
  // the camera across the map on the next visible frame.
  const frameDt = Math.min((now - lastFrameMs) / 1000, 0.1);
  chaseCamera.update(camera, kart.position, kart.yaw, kart.velocity, kart.physicsParams, frameDt);
  telemetry.updateHud(hud);
  inputOverlay.update(lastRawInput);
  combat.update(net.client, input, frameDt); // dt: box spin visual only
  lastFrameMs = now;
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
// __ready is set by the async asset-loading IIFE above.
