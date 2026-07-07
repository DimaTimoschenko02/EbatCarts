// Renders every OTHER connected player as an interpolated kart model. Not a
// physics entity — remote karts never run bicyclePhysics.ts, they are pure
// visual puppets driven by SnapshotBuffer.sample(now - RENDER_DELAY_MS).
import * as THREE from "three";
import { loadKartModel } from "../map/assetLoader";
import { JitterResampler, SnapshotBuffer, lerpAngle } from "./snapshotBuffer";
import type { RemotePlayerState } from "./netClient";
import type { KartObstacle } from "../physics/kartCollision";

// How far in the past we render remote karts. Bigger = smoother through
// jitter/loss but more visible lag; smaller = snappier but more prone to
// underrunning the buffer (sampling past the newest snapshot, which clamps
// and reads as "remote kart pauses"). Rule of thumb: keep this at ~2.5-3x the
// send interval so the buffer always has a bracketing pair to interpolate
// between even with some jitter. At the 30Hz send rate (netClient.ts,
// ~33ms/packet) that's ~83-100ms — 100ms chosen as the low end of that
// headroom since this is a shooter (player explicitly asked for minimal
// added latency over the previous 120ms).
const RENDER_DELAY_MS = 100;
// Exponential smoothing applied to the ALREADY-interpolated sample, on top
// of SnapshotBuffer's linear interpolation — cleans up residual stair-
// stepping from snapshot-to-snapshot without adding much visible lag (a
// 20-30/s rate settles within one or two frames). Per smooth-values rule:
// framerate-independent via 1-exp(-rate*dt), not a fixed per-frame lerp.
const RENDER_SMOOTH_RATE = 25;
const KART_MODEL = "craft_racer";
const KART_LENGTH = 2.2;

interface RemoteKart {
  group: THREE.Group;
  buffer: SnapshotBuffer;
  resampler: JitterResampler;
  modelReady: boolean;
  alive: boolean;
  // Post-interpolation smoothed render pose (see RENDER_SMOOTH_RATE above).
  smoothPos: THREE.Vector3;
  smoothYaw: number;
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

    const resampler = new JitterResampler();
    const entry: RemoteKart = {
      group,
      buffer: new SnapshotBuffer(),
      resampler,
      modelReady: false,
      alive: player.alive,
      smoothPos: new THREE.Vector3(player.x, player.y, player.z),
      smoothYaw: player.yaw,
    };
    entry.buffer.push({ t: resampler.resample(performance.now()), x: player.x, y: player.y, z: player.z, yaw: player.yaw });
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
    // Resample the receive-time timestamp onto a jitter-smoothed nominal
    // clock BEFORE it goes into the interpolation buffer (see
    // JitterResampler in snapshotBuffer.ts for why raw arrival time causes
    // judder even when the sender's own cadence is perfectly steady).
    kart.buffer.push({
      t: kart.resampler.resample(performance.now()),
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
    });
    kart.alive = player.alive;
    kart.group.visible = player.alive;
  }

  // Call once per rendered frame.
  update(): void {
    const now = performance.now();
    const dt = Math.max(0, (now - this.lastUpdateMs) / 1000);
    this.lastUpdateMs = now;
    const renderTime = now - RENDER_DELAY_MS;
    const smoothAlpha = 1 - Math.exp(-RENDER_SMOOTH_RATE * dt);
    for (const kart of this.karts.values()) {
      const s = kart.buffer.sample(renderTime);
      if (!s) continue;
      // Post-interpolation exp-filter: smooths residual stair-stepping from
      // snapshot-to-snapshot transitions without adding meaningful lag (see
      // RENDER_SMOOTH_RATE comment above).
      kart.smoothPos.x += (s.x - kart.smoothPos.x) * smoothAlpha;
      kart.smoothPos.y += (s.y - kart.smoothPos.y) * smoothAlpha;
      kart.smoothPos.z += (s.z - kart.smoothPos.z) * smoothAlpha;
      kart.smoothYaw = lerpAngle(kart.smoothYaw, s.yaw, smoothAlpha);
      kart.group.position.copy(kart.smoothPos);
      kart.group.rotation.y = kart.smoothYaw;
    }
  }

  // Read by Kart.update() (kart/kart.ts) to resolve local kart-vs-kart
  // collision (see physics/kartCollision.ts) — exposes the SAME rendered
  // (interpolated + smoothed) position every remote kart is currently drawn
  // at, so the local push resolves against what the player actually sees,
  // not the latest raw network snapshot (which can be up to RENDER_DELAY_MS
  // ahead of what's on screen).
  getObstacles(): KartObstacle[] {
    const out: KartObstacle[] = [];
    for (const kart of this.karts.values()) {
      out.push({ x: kart.smoothPos.x, z: kart.smoothPos.z, alive: kart.alive });
    }
    return out;
  }

  get count(): number {
    return this.karts.size;
  }
}
