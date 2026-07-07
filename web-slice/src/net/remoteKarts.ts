// Renders every OTHER connected player as an interpolated kart model. Not a
// physics entity — remote karts never run bicyclePhysics.ts, they are pure
// visual puppets driven by RemoteInterpolator (snapshotBuffer.ts).
import * as THREE from "three";
import { loadKartModel } from "../map/assetLoader";
import { RemoteInterpolator } from "./snapshotBuffer";
import type { RemotePlayerState } from "./netClient";
import type { KartObstacle } from "../physics/kartCollision";

// Adaptive render delay, jitter buffering, and post-interpolation smoothing
// all live in RemoteInterpolator (snapshotBuffer.ts) now — see that file's
// header comment for why a from-scratch synthetic clock (the old
// JitterResampler) was the actual cause of the periodic rush-then-stall
// judder, and why raw arrival timestamps + an adaptive delay replaced it.
const KART_MODEL = "craft_racer";
const KART_LENGTH = 2.2;

interface RemoteKart {
  group: THREE.Group;
  interp: RemoteInterpolator;
  modelReady: boolean;
  alive: boolean;
}

export class RemoteKartManager {
  private readonly karts = new Map<string, RemoteKart>();
  private lastUpdateMs = performance.now();

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

    const entry: RemoteKart = {
      group,
      interp: new RemoteInterpolator({ x: player.x, y: player.y, z: player.z, yaw: player.yaw }),
      modelReady: false,
      alive: player.alive,
    };
    entry.interp.push(performance.now(), { x: player.x, y: player.y, z: player.z, yaw: player.yaw });
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
    // Feed the raw arrival wall-clock time straight in — see snapshotBuffer.ts
    // (RemoteInterpolator / JitterResampler history note) for why a
    // reconstructed "nominal" clock caused periodic rush-then-stall judder.
    kart.interp.push(performance.now(), { x: player.x, y: player.y, z: player.z, yaw: player.yaw });
    kart.alive = player.alive;
    kart.group.visible = player.alive;
  }

  // Call once per rendered frame.
  update(): void {
    const now = performance.now();
    const dt = Math.max(0, (now - this.lastUpdateMs) / 1000);
    this.lastUpdateMs = now;
    for (const kart of this.karts.values()) {
      const pose = kart.interp.update(now, dt);
      kart.group.position.set(pose.x, pose.y, pose.z);
      kart.group.rotation.y = pose.yaw;
    }
  }

  // Read by Kart.update() (kart/kart.ts) to resolve local kart-vs-kart
  // collision (see physics/kartCollision.ts) — exposes the SAME rendered
  // (interpolated + smoothed) position every remote kart is currently drawn
  // at, so the local push resolves against what the player actually sees,
  // not the latest raw network snapshot (which can be ahead of what's
  // currently on screen by the interpolator's adaptive render delay).
  getObstacles(): KartObstacle[] {
    const out: KartObstacle[] = [];
    for (const kart of this.karts.values()) {
      out.push({ x: kart.group.position.x, z: kart.group.position.z, alive: kart.alive });
    }
    return out;
  }

  get count(): number {
    return this.karts.size;
  }

  // Worst-case interpolation diagnostics across all currently rendered
  // remote karts — surfaced through window.__net (net/index.ts) so jitter/
  // catch-up behavior can be sanity-checked during a live playtest without
  // needing devtools breakpoints.
  getNetStats(): { delayMs: number; jitterMs: number; underruns: number } {
    let delayMs = 0;
    let jitterMs = 0;
    let underruns = 0;
    for (const kart of this.karts.values()) {
      const s = kart.interp.stats;
      delayMs = Math.max(delayMs, s.delayMs);
      jitterMs = Math.max(jitterMs, s.jitterMs);
      underruns += s.underruns;
    }
    return { delayMs, jitterMs, underruns };
  }
}
