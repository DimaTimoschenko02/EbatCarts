// Space Kit GLB loading with pivot repair.
//
// The Kenney Space Kit GLBs were exported from one big Blender scene, so raw
// vertices sit far from the local origin (typical offset ~(2.0, _, 1.5) from
// the visual center). Godot fixes this once at import time with an
// EditorScenePostImport hook (tools/recenter_on_import.gd); three.js loads
// the raw file, so we apply the exact same repair at load time: shift the
// content so its AABB center lands on x=0, z=0. Y is left untouched — tile
// pivots must stay on the authored ground plane (terrain top at y=0,
// terrain_side spanning y in [-0.5, 0]), matching the map grid math.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const ASSET_BASE = "/assets/space-kit/";

export type AssetLibrary = ReadonlyMap<string, THREE.Group>;

function recenterXZ(root: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  for (const child of root.children) {
    child.position.x -= center.x;
    child.position.z -= center.z;
  }
}

// Loads the named GLBs (without extension) in parallel and returns templates
// keyed by name. Instances are made with template.clone() — clones share
// geometry and materials, so per-tile cost is one Object3D, not one mesh copy.
export async function loadAssetLibrary(names: readonly string[]): Promise<AssetLibrary> {
  const loader = new GLTFLoader();
  const lib = new Map<string, THREE.Group>();
  await Promise.all(
    names.map(async name => {
      const gltf = await loader.loadAsync(ASSET_BASE + name + ".glb");
      recenterXZ(gltf.scene);
      lib.set(name, gltf.scene);
    })
  );
  return lib;
}

// Kart model: recentered on XZ like tiles, then additionally floored (bottom
// of the AABB moved to y=0) and uniformly scaled to the requested length
// along Z, so it drops into the physics rig regardless of authored size.
export async function loadKartModel(name: string, targetLength: number): Promise<THREE.Group> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(ASSET_BASE + name + ".glb");
  const root = gltf.scene;
  recenterXZ(root);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const scale = targetLength / Math.max(size.z, 1e-3);
  const wrapper = new THREE.Group();
  wrapper.add(root);
  root.position.y = -box.min.y;
  wrapper.scale.setScalar(scale);
  return wrapper;
}
