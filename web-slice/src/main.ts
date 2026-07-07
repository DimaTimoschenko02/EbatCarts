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
import { updateCamera } from "./core/camera";
import { Telemetry } from "./debug/telemetry";

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

const input = new InputController();
const telemetry = new Telemetry(kart, input);
const hud = document.getElementById("hud")!;

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
function physTick(): void {
  loop.tick(dt => {
    const raw = input.next(dt * 1000);
    kart.update(dt, raw, map);
    telemetry.recordSubstep(dt, raw);
  });
}
setInterval(physTick, 50);

function frame(): void {
  requestAnimationFrame(frame);
  physTick(); // keep input latency low when rAF is alive
  kart.syncVisual();
  updateCamera(camera, kart.position, kart.yaw, 0.05); // dt: camera lerp smoothing only
  telemetry.updateHud(hud);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
// __ready is set by the async asset-loading IIFE above.
