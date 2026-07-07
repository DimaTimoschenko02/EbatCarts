// Chase + diagnostic top-down camera. Reads window.__camMode / __topHeight
// directly (declared + toggled in debug/telemetry.ts) — same debug-toggle
// pattern the rest of the slice uses, no extra plumbing needed for a
// single-camera single-player debug view.
import * as THREE from "three";
import { forwardOf } from "../kart/kart";

export function updateCamera(camera: THREE.PerspectiveCamera, pos: THREE.Vector3, yaw: number, dt: number): void {
  if (window.__camMode === "top") {
    // Diagnostic top-down: high above the kart, north-up — trail arcs and any
    // kinks in them are directly readable.
    // Slight south offset keeps lookAt's up-vector well-conditioned (a dead
    // vertical view makes the roll indeterminate → the map renders "diamond").
    const camTarget = pos.clone()
      .add(new THREE.Vector3(0, window.__topHeight, window.__topHeight * 0.25));
    camera.position.lerp(camTarget, 1 - Math.exp(-4 * dt));
    camera.lookAt(pos.x, pos.y, pos.z);
  } else {
    // Chase camera sits BEHIND the kart: behind = -forward.
    const fwd = forwardOf(yaw);
    const camTarget = pos.clone()
      .addScaledVector(fwd, -8)
      .add(new THREE.Vector3(0, 5, 0));
    camera.position.lerp(camTarget, 1 - Math.exp(-4 * dt));
    camera.lookAt(pos.x, pos.y + 1, pos.z);
  }
}
