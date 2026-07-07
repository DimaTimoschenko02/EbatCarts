// Renders rockets and explosion VFX from server broadcast messages
// (server/rooms/MatchRoom.ts "rocket:spawn"/"rocket:explode") — projectiles
// are NOT schema-tracked (see that file's header for the rationale: flight
// is deterministic straight-line motion at constant speed, so the client can
// render it analytically from one spawn message instead of interpolating a
// fast-moving networked entity). No hit detection here — that's server-only,
// this module only draws what the server already decided happened.
import * as THREE from "three";
import type { RocketExplodeMsg, RocketSpawnMsg } from "../net/netClient";

// The server now fires pitched (not just flat) rockets and broadcasts a `dy`
// component alongside dx/dz (server/rooms/MatchRoom.ts handleFire) so the
// client can extrapolate the same tilted straight line. This is an additive
// extension of the wire payload — kept as a local type rather than editing
// RocketSpawnMsg in net/netClient.ts (owned by another agent this session).
// `dy` is optional so old/flat spawns (missing the field) still work.
type RocketSpawnMsg3D = RocketSpawnMsg & { dy?: number };

const ROCKET_COLOR = 0xff6a1a;
const EXPLOSION_COLOR = 0xffaa33;
const EXPLOSION_DURATION_MS = 300;
const EXPLOSION_MAX_SCALE = 9; // relative to the initial 0.3m-radius sphere

interface LiveRocket {
  mesh: THREE.Mesh;
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  spawnAt: number; // performance.now() ms
  lifetime: number; // s
}

interface LiveExplosion {
  mesh: THREE.Mesh;
  bornAt: number;
}

export class RocketManager {
  private readonly live = new Map<string, LiveRocket>();
  private readonly explosions: LiveExplosion[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  spawn(msg: RocketSpawnMsg3D): void {
    const geo = new THREE.CylinderGeometry(0.08, 0.1, 0.6, 8);
    geo.rotateX(Math.PI / 2); // cylinder's local +Y axis -> mesh +Z (forward)
    const mat = new THREE.MeshStandardMaterial({
      color: ROCKET_COLOR,
      emissive: ROCKET_COLOR,
      emissiveIntensity: 1.2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(msg.x, msg.y, msg.z);
    // dy defaults to 0 for a flat launch (also covers any stale server build
    // that hasn't picked up the new field yet).
    const dir = new THREE.Vector3(msg.dx, msg.dy ?? 0, msg.dz).normalize();
    mesh.lookAt(mesh.position.clone().add(dir));
    this.scene.add(mesh);

    this.live.set(msg.id, {
      mesh,
      origin: new THREE.Vector3(msg.x, msg.y, msg.z),
      dir,
      speed: msg.speed,
      spawnAt: performance.now(),
      lifetime: msg.lifetime,
    });
  }

  explode(msg: RocketExplodeMsg): void {
    const rocket = this.live.get(msg.id);
    if (rocket) {
      this.scene.remove(rocket.mesh);
      this.live.delete(msg.id);
    }
    this.spawnExplosionVfx(new THREE.Vector3(msg.x, msg.y, msg.z));
  }

  private spawnExplosionVfx(pos: THREE.Vector3): void {
    const geo = new THREE.SphereGeometry(0.3, 12, 8);
    const mat = new THREE.MeshBasicMaterial({ color: EXPLOSION_COLOR, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.explosions.push({ mesh, bornAt: performance.now() });
  }

  // Call once per rendered frame. Rocket motion is the same analytic
  // straight line the server simulates (constant velocity, gravityScale=0) —
  // no interpolation needed, it can't drift out of sync with the
  // authoritative sim between "spawn" and "explode" messages.
  update(): void {
    const now = performance.now();

    for (const [id, r] of this.live) {
      const t = (now - r.spawnAt) / 1000;
      // Safety net only: if an "explode" message is ever dropped, don't let
      // the mesh fly forever — the server's own lifetime is authoritative,
      // this just cleans up the orphaned visual a bit past it.
      if (t > r.lifetime + 0.5) {
        this.scene.remove(r.mesh);
        this.live.delete(id);
        continue;
      }
      r.mesh.position.copy(r.origin).addScaledVector(r.dir, r.speed * t);
    }

    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      const age = now - e.bornAt;
      if (age > EXPLOSION_DURATION_MS) {
        this.scene.remove(e.mesh);
        e.mesh.geometry.dispose();
        (e.mesh.material as THREE.Material).dispose();
        this.explosions.splice(i, 1);
        continue;
      }
      const t = age / EXPLOSION_DURATION_MS;
      e.mesh.scale.setScalar(1 + t * EXPLOSION_MAX_SCALE);
      (e.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
    }
  }
}
