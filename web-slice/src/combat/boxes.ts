// Renders weapon pickup boxes from the server's authoritative WeaponBox
// schema (server/schema/MatchState.ts) — server decides pickup/respawn
// entirely (see server/rooms/MatchRoom.ts tickBoxes()), this module only
// draws the current state (position + active/inactive) and spins the mesh
// for visual flair.
import * as THREE from "three";
import type { BoxState } from "../net/netClient";

// weapon_pickup.gd:17 `rotate_y(delta * 2.0)` — matches the reference spin rate.
const SPIN_RATE_RAD_S = 2.0;
const BOX_COLOR = 0x33ffcc;

interface LiveBox {
  mesh: THREE.Mesh;
}

export class BoxManager {
  private readonly boxes = new Map<string, LiveBox>();

  constructor(private readonly scene: THREE.Scene) {}

  // Called once per rendered frame with the full current box list. Boxes are
  // few (6-8) and change rarely (pickup/10s respawn), so a flat per-frame
  // sync is simpler than wiring per-id add/change/remove callbacks the way
  // RemoteKartManager does for the player list.
  sync(states: readonly BoxState[], dt: number): void {
    const seen = new Set<string>();
    for (const s of states) {
      seen.add(s.id);
      let box = this.boxes.get(s.id);
      if (!box) {
        const geo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
        const mat = new THREE.MeshStandardMaterial({
          color: BOX_COLOR,
          emissive: BOX_COLOR,
          emissiveIntensity: 0.6,
        });
        const mesh = new THREE.Mesh(geo, mat);
        this.scene.add(mesh);
        box = { mesh };
        this.boxes.set(s.id, box);
      }
      box.mesh.position.set(s.x, s.y, s.z);
      box.mesh.visible = s.active;
      box.mesh.rotation.y += SPIN_RATE_RAD_S * dt;
    }
    for (const [id, box] of this.boxes) {
      if (seen.has(id)) continue;
      this.scene.remove(box.mesh);
      this.boxes.delete(id);
    }
  }
}
