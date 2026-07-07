// Renders every OTHER connected player as an interpolated kart model. Not a
// physics entity — remote karts never run bicyclePhysics.ts, they are pure
// visual puppets driven by SnapshotBuffer.sample(now - RENDER_DELAY_MS).
import * as THREE from "three";
import { loadKartModel } from "../map/assetLoader";
import { SnapshotBuffer } from "./snapshotBuffer";
import type { RemotePlayerState } from "./netClient";

// How far in the past we render remote karts. Bigger = smoother through
// jitter/loss but more visible lag; smaller = snappier but more prone to
// visible stutter on a lossy connection. 120ms matches the ~150ms-latency
// responsiveness target from the network-programmer brief (see this
// project's CLAUDE.md "Lag Compensation" responsibilities) with headroom for
// the ~50ms send interval itself.
const RENDER_DELAY_MS = 120;
const KART_MODEL = "craft_racer";
const KART_LENGTH = 2.2;

interface RemoteKart {
  group: THREE.Group;
  buffer: SnapshotBuffer;
  modelReady: boolean;
}

export class RemoteKartManager {
  private readonly karts = new Map<string, RemoteKart>();

  constructor(private readonly scene: THREE.Scene) {}

  add(sessionId: string, player: RemotePlayerState): void {
    if (this.karts.has(sessionId)) return;
    const group = new THREE.Group();
    // Placeholder box while the glb loads async, swapped in-place below —
    // mirrors Kart.buildPlaceholderMesh()/loadModel() in kart/kart.ts.
    const placeholder = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.5, 2.4),
      new THREE.MeshStandardMaterial({ color: 0x00ccff })
    );
    placeholder.position.y = 0.45;
    group.add(placeholder);
    group.visible = player.alive;
    this.scene.add(group);

    const entry: RemoteKart = { group, buffer: new SnapshotBuffer(), modelReady: false };
    entry.buffer.push({ t: performance.now(), x: player.x, y: player.y, z: player.z, yaw: player.yaw });
    this.karts.set(sessionId, entry);

    loadKartModel(KART_MODEL, KART_LENGTH)
      .then(model => {
        const kart = this.karts.get(sessionId);
        if (!kart) return; // left before load finished
        kart.group.clear();
        kart.group.add(model);
        kart.modelReady = true;
      })
      .catch(e => console.error("[net] remote kart model load failed", e));
  }

  remove(sessionId: string): void {
    const kart = this.karts.get(sessionId);
    if (!kart) return;
    this.scene.remove(kart.group);
    this.karts.delete(sessionId);
  }

  // Called on every schema change for this player — feeds the interpolation
  // buffer and toggles visibility on death/respawn (instant, not
  // interpolated: a dead kart should vanish immediately rather than fade out
  // along the render-delay curve).
  onSnapshot(sessionId: string, player: RemotePlayerState): void {
    const kart = this.karts.get(sessionId);
    if (!kart) return;
    kart.buffer.push({
      t: performance.now(),
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
    });
    kart.group.visible = player.alive;
  }

  // Call once per rendered frame.
  update(): void {
    const renderTime = performance.now() - RENDER_DELAY_MS;
    for (const kart of this.karts.values()) {
      const s = kart.buffer.sample(renderTime);
      if (!s) continue;
      kart.group.position.set(s.x, s.y, s.z);
      kart.group.rotation.y = s.yaw;
    }
  }

  get count(): number {
    return this.karts.size;
  }
}
