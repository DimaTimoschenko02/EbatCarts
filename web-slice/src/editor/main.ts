// Browser map editor for the Kenney Space Kit tile format consumed by
// GameMap (src/game/mapLoader.ts). Standalone page — no game physics, no
// network — just a click-to-place grid tool that exports the same MapJson
// the runtime loader reads (see .claude/rules/map-building.md for the
// asset/rotation conventions this UI surfaces as on-screen hints).
//
// Coordinate convention: the editor works entirely in CELL SPACE (integers
// 0..GRID_SIZE-1, or float sub-cell positions for props). World position is
// derived the same way GameMap does: world = cell - (GRID_SIZE-1)/2. On
// export we emit that same half-offset as origin_offset, so a map made here
// renders identically once loaded through GameMap.fromJson in the game.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadAssetLibrary } from "../game/assetLoader";
import type { AssetLibrary } from "../game/assetLoader";
import type { MapJson } from "../game/mapLoader";

const GRID_SIZE = 32; // cells per side
const TILE_SIZE = 1;
const LEVEL_HEIGHT = 0.5;
const HALF = (GRID_SIZE - 1) / 2; // world offset: world = cell - HALF
const MAX_Y_LEVEL = 6;
const ROT_CYCLE = [0, 90, 180, -90] as const;
const PROP_STEP = 0.25;

interface PaletteItem { asset: string; label: string }
interface PaletteCategory { category: string; isProp: boolean; items: PaletteItem[] }

const PALETTE: PaletteCategory[] = [
  { category: "Terrain", isProp: false, items: [
    { asset: "terrain", label: "Terrain" },
    { asset: "terrain_ramp", label: "Ramp" },
  ] },
  { category: "Roads", isProp: false, items: [
    { asset: "terrain_roadStraight", label: "Road Straight" },
    { asset: "terrain_roadCorner", label: "Road Corner" },
    { asset: "terrain_roadCross", label: "Road Cross" },
  ] },
  { category: "Edges", isProp: false, items: [
    { asset: "terrain_side", label: "Side" },
    { asset: "terrain_sideCorner", label: "Side Corner" },
    { asset: "terrain_sideCornerInner", label: "Side Corner Inner" },
  ] },
  { category: "Props", isProp: true, items: [
    { asset: "rock_largeA", label: "Rock Large" },
    { asset: "rock_crystals", label: "Rock Crystals" },
    { asset: "rocks_smallA", label: "Rocks Small A" },
    { asset: "rocks_smallB", label: "Rocks Small B" },
  ] },
];

const ASSET_NAMES = PALETTE.flatMap(cat => cat.items.map(i => i.asset));
const PROP_ASSETS = new Set(PALETTE.find(c => c.isProp)!.items.map(i => i.asset));
function isPropAsset(asset: string): boolean {
  return PROP_ASSETS.has(asset);
}

// ── DOM scaffolding ──────────────────────────────────────────────────────
const canvasContainer = document.getElementById("canvas-container")!;
const sidebar = document.getElementById("sidebar")!;
const statusMain = document.getElementById("statusMain")!;
const statusHint = document.getElementById("statusHint")!;

// ── Scene ──────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x12122a);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(20, 40, 15);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
camera.position.set(18, 18, 18);

const renderer = new THREE.WebGLRenderer({ antialias: true });
canvasContainer.appendChild(renderer.domElement);

function resizeRenderer(): void {
  const w = canvasContainer.clientWidth;
  const h = canvasContainer.clientHeight;
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
resizeRenderer();
addEventListener("resize", resizeRenderer);

const grid = new THREE.GridHelper(GRID_SIZE, GRID_SIZE, 0x00ffee, 0x333366);
scene.add(grid);

// OrbitControls: LEFT/RIGHT mouse are reserved for place/delete, so orbiting
// only happens on middle-drag; panning is disabled to keep the two-button
// place/delete scheme unambiguous. Wheel zoom (dolly) is unaffected.
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: null as unknown as THREE.MOUSE };
controls.update();

// Canvas owns right-click: suppress the native context menu everywhere over it.
renderer.domElement.addEventListener("contextmenu", e => e.preventDefault());

// ── Editor state ─────────────────────────────────────────────────────────
interface CellRecord { asset: string; x: number; z: number; y_level: number; rot: number }
interface PropRecord { asset: string; x: number; z: number; y_level: number; rot: number; scale: number }

const cells = new Map<string, CellRecord>();
const cellObjs = new Map<string, THREE.Object3D>();
const props: PropRecord[] = [];
const propObjs: THREE.Object3D[] = [];

let lib: AssetLibrary | null = null;
let activeAsset: string | null = null;
let rotIndex = 0;
let yLevel = 0;
let ghost: THREE.Object3D | null = null;

let lastClientX = innerWidth / 2;
let lastClientY = innerHeight / 2;
let lastCellX = 0;
let lastCellZ = 0;
let lastFloatX = 0;
let lastFloatZ = 0;

function cellKey(x: number, z: number): string {
  return x + "," + z;
}

// ── Palette UI ───────────────────────────────────────────────────────────
const paletteButtons = new Map<string, HTMLButtonElement>();

function buildPalette(): void {
  for (const cat of PALETTE) {
    const label = document.createElement("div");
    label.className = "category-label";
    label.textContent = cat.category;
    sidebar.appendChild(label);
    for (const item of cat.items) {
      const btn = document.createElement("button");
      btn.className = "palette-btn";
      btn.textContent = item.label;
      btn.addEventListener("click", () => selectAsset(item.asset));
      sidebar.appendChild(btn);
      paletteButtons.set(item.asset, btn);
    }
  }
}

function selectAsset(asset: string): void {
  activeAsset = asset;
  for (const [name, btn] of paletteButtons) btn.classList.toggle("active", name === asset);
  rebuildGhost();
  refreshCursor(lastClientX, lastClientY);
}

function deselectAsset(): void {
  activeAsset = null;
  for (const btn of paletteButtons.values()) btn.classList.remove("active");
  if (ghost) { scene.remove(ghost); ghost = null; }
  refreshCursor(lastClientX, lastClientY);
}

// ── Ghost preview ────────────────────────────────────────────────────────
function makeGhostFrom(template: THREE.Object3D): THREE.Object3D {
  const clone = template.clone(true);
  clone.traverse(child => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material;
    const clonedMat = Array.isArray(src) ? src.map(m => m.clone()) : src.clone();
    mesh.material = clonedMat;
    for (const m of Array.isArray(clonedMat) ? clonedMat : [clonedMat]) {
      (m as THREE.Material).transparent = true;
      (m as THREE.Material).opacity = 0.45;
      (m as THREE.Material).depthWrite = false;
    }
  });
  return clone;
}

function rebuildGhost(): void {
  if (ghost) { scene.remove(ghost); ghost = null; }
  if (!activeAsset || !lib) return;
  const template = lib.get(activeAsset);
  if (!template) return;
  ghost = makeGhostFrom(template);
  scene.add(ghost);
}

// ── Cell / prop placement ────────────────────────────────────────────────
function placeCell(rec: CellRecord): void {
  if (!lib) return;
  const key = cellKey(rec.x, rec.z);
  const existing = cellObjs.get(key);
  if (existing) scene.remove(existing);
  const template = lib.get(rec.asset);
  if (!template) return;
  const inst = template.clone(true);
  inst.position.set(rec.x - HALF, rec.y_level * LEVEL_HEIGHT, rec.z - HALF);
  inst.rotation.y = THREE.MathUtils.degToRad(rec.rot);
  scene.add(inst);
  cells.set(key, rec);
  cellObjs.set(key, inst);
}

function removeCell(key: string): boolean {
  const obj = cellObjs.get(key);
  if (!obj) return false;
  scene.remove(obj);
  cellObjs.delete(key);
  cells.delete(key);
  return true;
}

function addProp(rec: PropRecord): void {
  if (!lib) return;
  const template = lib.get(rec.asset);
  if (!template) return;
  const inst = template.clone(true);
  inst.position.set(rec.x - HALF, rec.y_level * LEVEL_HEIGHT, rec.z - HALF);
  inst.rotation.y = THREE.MathUtils.degToRad(rec.rot);
  inst.scale.setScalar(rec.scale);
  scene.add(inst);
  props.push(rec);
  propObjs.push(inst);
}

// Removes the prop whose cell-space XZ is closest to (x, z), if within reach.
function removeNearestProp(x: number, z: number, maxDist = 0.6): boolean {
  let bestIdx = -1;
  let bestDist = maxDist;
  for (let i = 0; i < props.length; i++) {
    const d = Math.hypot(props[i].x - x, props[i].z - z);
    if (d <= bestDist) { bestDist = d; bestIdx = i; }
  }
  if (bestIdx < 0) return false;
  scene.remove(propObjs[bestIdx]);
  props.splice(bestIdx, 1);
  propObjs.splice(bestIdx, 1);
  return true;
}

function clearAll(): void {
  for (const obj of cellObjs.values()) scene.remove(obj);
  cells.clear();
  cellObjs.clear();
  for (const obj of propObjs) scene.remove(obj);
  props.length = 0;
  propObjs.length = 0;
}

// ── Raycast / cursor ─────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hitPoint = new THREE.Vector3();

function updatePlane(): void {
  groundPlane.constant = -(yLevel * LEVEL_HEIGHT);
}
updatePlane();

// Recomputes the cursor's cell-space position from a client (screen) point,
// updates the ghost + status bar. Called on pointermove and whenever rot /
// y_level / active asset change (using the last known cursor position).
function refreshCursor(clientX: number, clientY: number): void {
  lastClientX = clientX;
  lastClientY = clientY;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.ray.intersectPlane(groundPlane, hitPoint);

  const rot = ROT_CYCLE[rotIndex];
  if (hit) {
    const cellSpaceX = hit.x + HALF;
    const cellSpaceZ = hit.z + HALF;
    lastCellX = THREE.MathUtils.clamp(Math.round(cellSpaceX), 0, GRID_SIZE - 1);
    lastCellZ = THREE.MathUtils.clamp(Math.round(cellSpaceZ), 0, GRID_SIZE - 1);
    lastFloatX = THREE.MathUtils.clamp(Math.round(cellSpaceX / PROP_STEP) * PROP_STEP, 0, GRID_SIZE - 1);
    lastFloatZ = THREE.MathUtils.clamp(Math.round(cellSpaceZ / PROP_STEP) * PROP_STEP, 0, GRID_SIZE - 1);
  }

  if (ghost && activeAsset) {
    ghost.visible = true;
    if (isPropAsset(activeAsset)) {
      ghost.position.set(lastFloatX - HALF, yLevel * LEVEL_HEIGHT, lastFloatZ - HALF);
    } else {
      ghost.position.set(lastCellX - HALF, yLevel * LEVEL_HEIGHT, lastCellZ - HALF);
    }
    ghost.rotation.y = THREE.MathUtils.degToRad(rot);
  }

  updateStatusBar(rot);
}

function hintFor(asset: string | null): string {
  if (!asset) return "";
  // See .claude/rules/map-building.md — these two families use OPPOSITE
  // y_level conventions and mixing them up is the classic map-building bug.
  if (asset.startsWith("terrain_sideCorner") || asset === "terrain_ramp") {
    return "y_level = НИЖНИЙ уровень (плитка поднимается вверх от него)";
  }
  if (asset.startsWith("terrain_side")) {
    return "y_level = ВЕРХНИЙ уровень (плитка спускается вниз от него)";
  }
  return "";
}

function updateStatusBar(rot: number): void {
  const assetLabel = activeAsset ?? "(none)";
  statusMain.textContent =
    `asset: ${assetLabel}  rot: ${rot}  y_level: ${yLevel}  cell: (${lastCellX}, ${lastCellZ})`;
  statusHint.textContent = hintFor(activeAsset);
}

// ── Pointer input: LEFT place, RIGHT delete ─────────────────────────────
renderer.domElement.addEventListener("pointermove", e => {
  refreshCursor(e.clientX, e.clientY);
});

renderer.domElement.addEventListener("pointerdown", e => {
  refreshCursor(e.clientX, e.clientY);
  if (e.button === 0) {
    // Left click: place the active asset (no-op if nothing selected).
    if (!activeAsset) return;
    const rot = ROT_CYCLE[rotIndex];
    if (isPropAsset(activeAsset)) {
      addProp({ asset: activeAsset, x: lastFloatX, z: lastFloatZ, y_level: yLevel, rot, scale: 1.0 });
    } else {
      placeCell({ asset: activeAsset, x: lastCellX, z: lastCellZ, y_level: yLevel, rot });
    }
    scheduleAutosave();
  } else if (e.button === 2) {
    // Right click: delete whatever is under the cursor — a snapped cell tile
    // first, then the nearest prop, regardless of the currently active asset.
    const key = cellKey(lastCellX, lastCellZ);
    const removedCell = removeCell(key);
    const removedProp = !removedCell && removeNearestProp(lastFloatX, lastFloatZ);
    if (removedCell || removedProp) scheduleAutosave();
  }
});

// ── Keyboard: R rotate, Q/E y_level, Esc deselect ───────────────────────
addEventListener("keydown", e => {
  if (e.code === "KeyR") {
    rotIndex = (rotIndex + 1) % ROT_CYCLE.length;
    refreshCursor(lastClientX, lastClientY);
  } else if (e.code === "KeyQ") {
    yLevel = THREE.MathUtils.clamp(yLevel - 1, 0, MAX_Y_LEVEL);
    updatePlane();
    refreshCursor(lastClientX, lastClientY);
  } else if (e.code === "KeyE") {
    yLevel = THREE.MathUtils.clamp(yLevel + 1, 0, MAX_Y_LEVEL);
    updatePlane();
    refreshCursor(lastClientX, lastClientY);
  } else if (e.code === "Escape") {
    deselectAsset();
  }
});

// ── Export / Import / Clear / Drive ─────────────────────────────────────
function buildMapJson(): MapJson {
  return {
    meta: {
      tile_size: TILE_SIZE,
      level_height: LEVEL_HEIGHT,
      origin_offset: [-HALF, 0, -HALF],
    },
    cells: Array.from(cells.values()),
    props: props.map(p => ({ ...p })),
  };
}

// Loads a MapJson into the editor (used by both Import and autosave-restore).
// rect_fills are expanded into individual cell placements — the editor's
// data model has no notion of a rectangle, only per-cell records.
function loadMapJson(data: MapJson): void {
  clearAll();
  for (const rect of data.rect_fills ?? []) {
    for (let x = rect.x_min; x <= rect.x_max; x++) {
      for (let z = rect.z_min; z <= rect.z_max; z++) {
        placeCell({ asset: rect.asset, x, z, y_level: rect.y_level, rot: rect.rot ?? 0 });
      }
    }
  }
  for (const cell of data.cells ?? []) {
    placeCell({ asset: cell.asset, x: cell.x, z: cell.z, y_level: cell.y_level, rot: cell.rot ?? 0 });
  }
  for (const prop of data.props ?? []) {
    addProp({
      asset: prop.asset, x: prop.x, z: prop.z, y_level: prop.y_level,
      rot: prop.rot ?? 0, scale: prop.scale ?? 1.0,
    });
  }
}

document.getElementById("btnExport")!.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(buildMapJson(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "map.json";
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("fileImport")!.addEventListener("change", e => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  file.text().then(text => {
    const data = JSON.parse(text) as MapJson;
    loadMapJson(data);
    scheduleAutosave();
  }).catch(err => console.error("[editor] import failed:", err));
  input.value = ""; // allow re-importing the same filename later
});

document.getElementById("btnClear")!.addEventListener("click", () => {
  if (!confirm("Clear the whole map?")) return;
  clearAll();
  scheduleAutosave();
});

document.getElementById("btnDrive")!.addEventListener("click", () => {
  localStorage.setItem("editor-drive-map", JSON.stringify(buildMapJson()));
  window.open("/?map=editor", "_blank");
});

// ── Autosave (debounced) ─────────────────────────────────────────────────
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleAutosave(): void {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    localStorage.setItem("editor-autosave", JSON.stringify(buildMapJson()));
  }, 500);
}

// ── Boot ─────────────────────────────────────────────────────────────────
(async () => {
  buildPalette();
  lib = await loadAssetLibrary(ASSET_NAMES);
  const saved = localStorage.getItem("editor-autosave");
  if (saved) {
    try { loadMapJson(JSON.parse(saved) as MapJson); }
    catch (err) { console.error("[editor] autosave restore failed:", err); }
  }
  statusMain.textContent = "asset: (none)  rot: 0  y_level: 0  cell: (—, —)";
  refreshCursor(lastClientX, lastClientY);
})();

function frame(): void {
  requestAnimationFrame(frame);
  controls.update();
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
