// Browser map editor for the Kenney Space Kit tile format consumed by
// GameMap (src/map/mapLoader.ts). Standalone page — no game physics, no
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
import { loadAssetLibrary } from "../map/assetLoader";
import type { AssetLibrary } from "../map/assetLoader";
import type { MapJson } from "../map/mapLoader";

const MIN_GRID_SIZE = 16;
const MAX_GRID_SIZE = 96;
const GRID_SIZE_STEP = 16;
let GRID_SIZE = 32; // cells per side — mutable, see setGridSize()
const TILE_SIZE = 1;
const LEVEL_HEIGHT = 0.5;
let HALF = (GRID_SIZE - 1) / 2; // world offset: world = cell - HALF, kept in sync with GRID_SIZE
const MAX_Y_LEVEL = 6;
const ROT_CYCLE = [0, 90, 180, -90] as const;
const PROP_STEP = 0.25;

interface PaletteItem { asset: string; label: string }
interface PaletteCategory { category: string; isProp: boolean; items: PaletteItem[] }

const PALETTE: PaletteCategory[] = [
  { category: "Terrain", isProp: false, items: [
    { asset: "terrain", label: "Terrain" },
    { asset: "terrain_ramp", label: "Ramp" },
    { asset: "terrain_rampLarge", label: "Ramp Large (2x)" },
    { asset: "terrain_rampLarge_detailed", label: "Ramp Large Detailed (2x)" },
  ] },
  { category: "Roads", isProp: false, items: [
    { asset: "terrain_roadStraight", label: "Road Straight" },
    { asset: "terrain_roadCorner", label: "Road Corner" },
    { asset: "terrain_roadCross", label: "Road Cross" },
    { asset: "terrain_roadEnd", label: "Road End" },
    { asset: "terrain_roadSplit", label: "Road Split" },
  ] },
  { category: "Edges", isProp: false, items: [
    { asset: "terrain_side", label: "Side" },
    { asset: "terrain_sideCorner", label: "Side Corner" },
    { asset: "terrain_sideCornerInner", label: "Side Corner Inner" },
    { asset: "terrain_sideEnd", label: "Side End" },
    { asset: "terrain_sideCliff", label: "Side Cliff" },
  ] },
  { category: "Props", isProp: true, items: [
    { asset: "rock", label: "Rock" },
    { asset: "rock_largeA", label: "Rock Large A" },
    { asset: "rock_largeB", label: "Rock Large B" },
    { asset: "rock_crystals", label: "Rock Crystals" },
    { asset: "rock_crystalsLargeA", label: "Rock Crystals Large A" },
    { asset: "rock_crystalsLargeB", label: "Rock Crystals Large B" },
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
const gridSizeInput = document.getElementById("gridSizeInput") as HTMLInputElement;
const selLoad = document.getElementById("selLoad") as HTMLSelectElement;
const serverStatus = document.getElementById("serverStatus")!;
const btnUndo = document.getElementById("btnUndo") as HTMLButtonElement;

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

let grid = new THREE.GridHelper(GRID_SIZE, GRID_SIZE, 0x00ffee, 0x333366);
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

// ── WASD / arrow-key camera panning ─────────────────────────────────────
// Middle-drag orbit + wheel zoom aren't enough to cover a large map — the
// owner asked for keyboard panning too. We move both camera.position and
// controls.target by the same screen-projected delta each frame, which
// preserves OrbitControls' internal spherical offset (same trick its own
// .pan() uses internally), so orbiting/zooming keep working unmodified.
const CAMERA_PAN_SPEED = 15; // world units / second
const CAMERA_PAN_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);
const pressedKeys = new Set<string>();
const panClock = new THREE.Clock();

function updateCameraPan(dt: number): void {
  if (pressedKeys.size === 0) return;
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

  const move = new THREE.Vector3();
  if (pressedKeys.has("KeyW") || pressedKeys.has("ArrowUp")) move.add(forward);
  if (pressedKeys.has("KeyS") || pressedKeys.has("ArrowDown")) move.sub(forward);
  if (pressedKeys.has("KeyD") || pressedKeys.has("ArrowRight")) move.add(right);
  if (pressedKeys.has("KeyA") || pressedKeys.has("ArrowLeft")) move.sub(right);
  if (move.lengthSq() < 1e-9) return;
  move.normalize().multiplyScalar(CAMERA_PAN_SPEED * dt);
  camera.position.add(move);
  controls.target.add(move);
}

// Text fields (grid-size input, server-map select) must keep their own
// keyboard input — WASD/arrows/R/Q/E/Ctrl+Z must not be hijacked while
// the owner is typing in them.
function isTextInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
}

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
      // Label lives in its own span so a thumbnail <img> can be prepended
      // later (once the asset library is loaded) without clobbering the text.
      const labelSpan = document.createElement("span");
      labelSpan.className = "palette-label";
      labelSpan.textContent = item.label;
      btn.appendChild(labelSpan);
      btn.addEventListener("click", () => selectAsset(item.asset));
      sidebar.appendChild(btn);
      paletteButtons.set(item.asset, btn);
    }
  }
}

// ── Palette thumbnails ──────────────────────────────────────────────────
// Renders each palette asset's template to a small offscreen canvas once
// the asset library has loaded, and stamps it as an <img> in front of the
// button's label. One shared renderer is reused across all assets (cheaper
// than allocating a WebGL context per thumbnail); failures are swallowed —
// the button just keeps its plain-text label.
const THUMB_RENDER_SIZE = 96; // rendered at 2.4x the ~40px CSS display size
let thumbRenderer: THREE.WebGLRenderer | null = null;

function getThumbRenderer(): THREE.WebGLRenderer {
  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setSize(THUMB_RENDER_SIZE, THUMB_RENDER_SIZE);
    thumbRenderer.setClearColor(0x000000, 0);
  }
  return thumbRenderer;
}

function renderThumbnail(template: THREE.Object3D): string | null {
  try {
    const r = getThumbRenderer();
    const thumbScene = new THREE.Scene();
    thumbScene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(3, 5, 2);
    thumbScene.add(dir);

    const clone = template.clone(true);
    thumbScene.add(clone);
    const box = new THREE.Box3().setFromObject(clone);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1e-3);
    clone.position.sub(center); // center the model at the origin for framing

    const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    const dist = maxDim * 2.3;
    cam.position.set(dist, dist * 0.85, dist); // fixed iso-ish angle for every asset
    cam.lookAt(0, 0, 0);

    r.render(thumbScene, cam);
    return r.domElement.toDataURL("image/png");
  } catch (err) {
    console.error("[editor] thumbnail render failed:", err);
    return null;
  }
}

function addPaletteThumbnails(): void {
  if (!lib) return;
  for (const cat of PALETTE) {
    for (const item of cat.items) {
      const template = lib.get(item.asset);
      const btn = paletteButtons.get(item.asset);
      if (!template || !btn) continue;
      const dataUrl = renderThumbnail(template);
      if (!dataUrl) continue; // graceful fallback: leave the text-only button
      const img = document.createElement("img");
      img.className = "palette-thumb";
      img.src = dataUrl;
      img.alt = "";
      btn.prepend(img);
    }
  }
  // The offscreen GL context isn't needed again after this pass.
  thumbRenderer?.dispose();
  thumbRenderer = null;
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

// Finds the index of the prop whose cell-space XZ is closest to (x, z),
// within reach, or -1 if none. Split from the removal itself so callers
// (delete handler, undo/redo) can grab the record before it's gone.
function findNearestPropIndex(x: number, z: number, maxDist = 0.6): number {
  let bestIdx = -1;
  let bestDist = maxDist;
  for (let i = 0; i < props.length; i++) {
    const d = Math.hypot(props[i].x - x, props[i].z - z);
    if (d <= bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

// Removes a prop by object identity (not by re-deriving position), so undo
// can restore/re-remove the exact same record instance regardless of how
// the array shifted since it was captured.
function removePropByRef(rec: PropRecord): boolean {
  const idx = props.indexOf(rec);
  if (idx < 0) return false;
  scene.remove(propObjs[idx]);
  props.splice(idx, 1);
  propObjs.splice(idx, 1);
  return true;
}

// ── Undo / redo ──────────────────────────────────────────────────────────
// Each entry stores the before/after state of exactly one cell (keyed) or
// prop (by object identity) mutation. Undo restores "before", redo
// re-applies "after" — the same apply function drives both directions.
const UNDO_LIMIT = 50;
interface CellUndoEntry { kind: "cell"; key: string; before: CellRecord | null; after: CellRecord | null }
interface PropUndoEntry { kind: "prop"; before: PropRecord | null; after: PropRecord | null }
type UndoEntry = CellUndoEntry | PropUndoEntry;

const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];

function updateUndoButton(): void {
  btnUndo.disabled = undoStack.length === 0;
}

function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0; // a fresh action invalidates the redo history
  updateUndoButton();
}

function applyEntry(entry: UndoEntry, direction: "undo" | "redo"): void {
  if (entry.kind === "cell") {
    const target = direction === "undo" ? entry.before : entry.after;
    if (target) placeCell(target); else removeCell(entry.key);
    return;
  }
  const removeTarget = direction === "undo" ? entry.after : entry.before;
  const restoreTarget = direction === "undo" ? entry.before : entry.after;
  if (removeTarget) removePropByRef(removeTarget);
  if (restoreTarget) addProp(restoreTarget);
}

function undo(): void {
  const entry = undoStack.pop();
  if (!entry) return;
  applyEntry(entry, "undo");
  redoStack.push(entry);
  updateUndoButton();
  refreshCursor(lastClientX, lastClientY);
  scheduleAutosave();
}

function redo(): void {
  const entry = redoStack.pop();
  if (!entry) return;
  applyEntry(entry, "redo");
  undoStack.push(entry);
  updateUndoButton();
  refreshCursor(lastClientX, lastClientY);
  scheduleAutosave();
}

// Re-derives world position (position.x/z depend on HALF) for every already-
// placed cell/prop object, without touching the stored cell-space records.
// Called after GRID_SIZE (and therefore HALF) changes.
function rebuildAllPlacements(): void {
  for (const [key, rec] of cells) {
    const obj = cellObjs.get(key);
    if (obj) obj.position.set(rec.x - HALF, rec.y_level * LEVEL_HEIGHT, rec.z - HALF);
  }
  for (let i = 0; i < props.length; i++) {
    propObjs[i].position.set(props[i].x - HALF, props[i].y_level * LEVEL_HEIGHT, props[i].z - HALF);
  }
}

// Changes the grid size: recreates the GridHelper, updates HALF (which
// shifts every already-placed object's world position to match — cell-space
// records are unaffected), and re-clamps the cursor to the new bounds.
function setGridSize(size: number): void {
  const clamped = THREE.MathUtils.clamp(
    Math.round(size / GRID_SIZE_STEP) * GRID_SIZE_STEP,
    MIN_GRID_SIZE, MAX_GRID_SIZE
  );
  if (clamped === GRID_SIZE) return;
  GRID_SIZE = clamped;
  HALF = (GRID_SIZE - 1) / 2;
  scene.remove(grid);
  grid = new THREE.GridHelper(GRID_SIZE, GRID_SIZE, 0x00ffee, 0x333366);
  scene.add(grid);
  gridSizeInput.value = String(GRID_SIZE);
  rebuildAllPlacements();
  refreshCursor(lastClientX, lastClientY);
}

function clearAll(): void {
  for (const obj of cellObjs.values()) scene.remove(obj);
  cells.clear();
  cellObjs.clear();
  for (const obj of propObjs) scene.remove(obj);
  props.length = 0;
  propObjs.length = 0;
  // A bulk clear/import/load invalidates any prior undo history — replaying
  // an old entry against the now-cleared map would resurrect stale records.
  undoStack.length = 0;
  redoStack.length = 0;
  updateUndoButton();
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
      const rec: PropRecord = { asset: activeAsset, x: lastFloatX, z: lastFloatZ, y_level: yLevel, rot, scale: 1.0 };
      addProp(rec);
      pushUndo({ kind: "prop", before: null, after: rec });
    } else {
      const key = cellKey(lastCellX, lastCellZ);
      const before = cells.get(key) ?? null;
      const rec: CellRecord = { asset: activeAsset, x: lastCellX, z: lastCellZ, y_level: yLevel, rot };
      placeCell(rec);
      pushUndo({ kind: "cell", key, before, after: rec });
    }
    scheduleAutosave();
  } else if (e.button === 2) {
    // Right click: delete whatever is under the cursor — a snapped cell tile
    // first, then the nearest prop, regardless of the currently active asset.
    const key = cellKey(lastCellX, lastCellZ);
    const cellBefore = cells.get(key) ?? null;
    const removedCell = removeCell(key);
    if (removedCell) {
      pushUndo({ kind: "cell", key, before: cellBefore, after: null });
      scheduleAutosave();
      return;
    }
    const propIdx = findNearestPropIndex(lastFloatX, lastFloatZ);
    if (propIdx >= 0) {
      const rec = props[propIdx];
      removePropByRef(rec);
      pushUndo({ kind: "prop", before: rec, after: null });
      scheduleAutosave();
    }
  }
});

// ── Keyboard: R rotate, Q/E y_level, WASD/arrows pan, Ctrl+Z undo, Esc ──
addEventListener("keydown", e => {
  if (isTextInputFocused()) return;

  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === "KeyZ") {
    e.preventDefault();
    undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.code === "KeyY" || (e.shiftKey && e.code === "KeyZ"))) {
    e.preventDefault();
    redo();
    return;
  }

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
  } else if (CAMERA_PAN_KEYS.has(e.code)) {
    pressedKeys.add(e.code);
    e.preventDefault();
  }
});

addEventListener("keyup", e => {
  pressedKeys.delete(e.code);
});

// If focus leaves the window mid-pan (alt-tab, devtools) the keyup never
// fires — clear held keys so the camera doesn't drift forever.
addEventListener("blur", () => {
  pressedKeys.clear();
});

btnUndo.addEventListener("click", () => undo());
updateUndoButton();

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

// Finds the largest cell-space coordinate used anywhere in a MapJson (rect
// fills, cells, props), so the editor grid can auto-fit around an imported
// or server-loaded map instead of clipping it against the default 32x32.
function maxCoordOf(data: MapJson): number {
  let max = 0;
  for (const r of data.rect_fills ?? []) max = Math.max(max, r.x_max, r.z_max);
  for (const c of data.cells ?? []) max = Math.max(max, c.x, c.z);
  for (const p of data.props ?? []) max = Math.max(max, p.x, p.z);
  return max;
}

// Grows the grid to comfortably fit a loaded map when it doesn't already:
// +4 cells of margin past the farthest placed tile, rounded up to the next
// multiple of GRID_SIZE_STEP. Never shrinks — loading a small map after a
// big one keeps the current (larger) grid, per owner's call.
function fitGridToMap(data: MapJson): void {
  const needed = Math.ceil((maxCoordOf(data) + 4) / GRID_SIZE_STEP) * GRID_SIZE_STEP;
  if (needed > GRID_SIZE) setGridSize(needed);
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
    fitGridToMap(data);
    loadedMapName = file.name.replace(/\.json$/i, "");
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

gridSizeInput.addEventListener("change", () => {
  setGridSize(Number(gridSizeInput.value) || GRID_SIZE);
});

// ── Save/Load via the dev server (vite.config.ts editorMapsFilePlugin) ────
// Closes the loop for the two-laptop LAN setup: the editor's Export/Import
// buttons only touch the browser's local filesystem, which is useless when
// the editor is opened from a laptop other than the one the repo lives on.
let loadedMapName: string | null = null;

function showServerStatus(text: string, kind: "ok" | "error"): void {
  serverStatus.textContent = text;
  serverStatus.className = kind;
  setTimeout(() => { serverStatus.textContent = ""; serverStatus.className = ""; }, 4000);
}

async function refreshServerMapList(): Promise<void> {
  try {
    const res = await fetch("/__editor-maps");
    if (!res.ok) throw new Error(String(res.status));
    const { maps } = (await res.json()) as { maps: string[] };
    const previous = selLoad.value;
    selLoad.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Load ▾";
    selLoad.appendChild(placeholder);
    for (const name of maps) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      selLoad.appendChild(opt);
    }
    selLoad.value = maps.includes(previous) ? previous : "";
  } catch (err) {
    console.error("[editor] failed to list server maps:", err);
  }
}

selLoad.addEventListener("change", () => {
  const name = selLoad.value;
  if (!name) return;
  fetch(`/maps/${name}.json`)
    .then(res => {
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    })
    .then((data: MapJson) => {
      loadMapJson(data);
      fitGridToMap(data);
      loadedMapName = name;
      scheduleAutosave();
      showServerStatus(`loaded ${name}`, "ok");
    })
    .catch(err => {
      console.error("[editor] load from server failed:", err);
      showServerStatus(`load failed: ${String(err)}`, "error");
    })
    .finally(() => { selLoad.value = ""; });
});

document.getElementById("btnSaveServer")!.addEventListener("click", () => {
  const name = prompt("Save as (letters/digits/-/_ only):", loadedMapName ?? "map");
  if (!name) return;
  fetch("/__editor-maps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data: buildMapJson() }),
  })
    .then(res => {
      if (!res.ok) return res.text().then(msg => { throw new Error(msg || String(res.status)); });
      loadedMapName = name;
      showServerStatus(`saved ${name}.json`, "ok");
      return refreshServerMapList();
    })
    .catch(err => {
      console.error("[editor] save to server failed:", err);
      showServerStatus(`save failed: ${String(err)}`, "error");
    });
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
  addPaletteThumbnails();
  void refreshServerMapList();
  const saved = localStorage.getItem("editor-autosave");
  if (saved) {
    try {
      const data = JSON.parse(saved) as MapJson;
      loadMapJson(data);
      fitGridToMap(data);
    }
    catch (err) { console.error("[editor] autosave restore failed:", err); }
  }
  statusMain.textContent = "asset: (none)  rot: 0  y_level: 0  cell: (—, —)";
  refreshCursor(lastClientX, lastClientY);
})();

function frame(): void {
  requestAnimationFrame(frame);
  updateCameraPan(panClock.getDelta());
  controls.update();
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
