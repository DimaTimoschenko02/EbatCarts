// Chase + diagnostic top-down camera. Reads window.__camMode / __topHeight
// directly (declared + toggled in debug/telemetry.ts) — same debug-toggle
// pattern the rest of the slice uses, no extra plumbing needed for a
// single-camera single-player debug view.
//
// Chase heading (2026-07-07 rework): the chase camera used to be rigidly
// locked to the kart's PHYSICAL yaw, which forced driftVisualOffsetDeg to be
// clamped tiny (10deg) to avoid the whole screen swinging with the drifted
// body. Reference footage of the original SmashKarts shows the camera does
// two things the old rig didn't:
//   1. In a drift the camera tracks the direction the kart is actually
//      MOVING (velocity heading), not the direction the body is pointed —
//      so the drift reads as "the car turned sideways under the camera",
//      not "the whole world spun".
//   2. In reverse the camera does NOT flip 180° to keep facing the kart's
//      new direction of travel — it keeps looking down the nose, so backing
//      up reads as "the kart drives toward the camera".
// Both of those fall out of one rule: blend the camera's heading target
// between velocity-heading and physical-yaw by signed forward speed, with
// velocity-heading winning only while actually moving forward at a real
// clip. See ChaseCamera.update below.
import * as THREE from "three";
import { forwardOf } from "../kart/kart";
import type { KartPhysicsParams } from "../physics/types";

// Normalizes an angle difference into (-PI, PI] so an exp-follow filter (or
// any lerp between two headings) takes the shortest arc instead of spinning
// the long way around at the +-PI wrap boundary — see
// .claude/rules/smooth-values.md. Exported for unit tests.
export function wrapAngle(diff: number): number {
  let d = diff % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Blends two headings across their shortest arc by interpolant t in [0,1] —
// same "wrap before lerp" concern as wrapAngle, phrased as a two-angle mix.
// Exported for unit tests.
export function blendAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

export class ChaseCamera {
  // null until the first non-top-mode update — lets the camera SNAP to the
  // kart's actual heading on the very first frame instead of easing in from
  // a hardcoded 0 (which would visibly swing the camera at boot/respawn if
  // the kart doesn't happen to start facing -Z).
  private camYaw: number | null = null;

  update(
    camera: THREE.PerspectiveCamera,
    pos: THREE.Vector3,
    yaw: number,
    velocity: THREE.Vector3,
    params: KartPhysicsParams,
    dt: number
  ): void {
    if (window.__camMode === "top") {
      // Diagnostic top-down: high above the kart, north-up — trail arcs and any
      // kinks in them are directly readable.
      // Slight south offset keeps lookAt's up-vector well-conditioned (a dead
      // vertical view makes the roll indeterminate → the map renders "diamond").
      const camTarget = pos.clone()
        .add(new THREE.Vector3(0, window.__topHeight, window.__topHeight * 0.25));
      camera.position.lerp(camTarget, 1 - Math.exp(-4 * dt));
      camera.lookAt(pos.x, pos.y, pos.z);
      return;
    }

    // fwdSigned = velocity projected onto the kart's physical forward axis —
    // same sign convention as bicyclePhysics's fwdSpeed (positive = driving
    // forward, negative = reversing).
    const fwd = forwardOf(yaw);
    const fwdSigned = velocity.x * fwd.x + velocity.z * fwd.z;

    // Heading implied by where the kart is actually going. Only meaningful
    // once blended in below (at fwdSigned <= camVelHeadingBlendLo this term
    // is fully weighted out, so a near-zero/lateral-only velocity vector
    // never gets read as a heading).
    const yawFromVelocity = Math.atan2(-velocity.x, -velocity.z);

    // Continuous smoothstep blend, NOT a binary forward/reverse branch (see
    // .claude/rules/smooth-values.md #4): 0 at/under camVelHeadingBlendLo
    // (pure physical yaw — covers standstill AND reverse), 1 at/over
    // camVelHeadingBlendHi (pure velocity heading — normal forward driving,
    // including drifting).
    const velWeight = THREE.MathUtils.smoothstep(fwdSigned, params.camVelHeadingBlendLo, params.camVelHeadingBlendHi);
    const targetYaw = blendAngle(yaw, yawFromVelocity, velWeight);

    if (this.camYaw === null) {
      this.camYaw = targetYaw;
    } else {
      // Framerate-independent exp-follow, wrapped so it always turns the
      // short way across the +-PI seam instead of snapping 360°.
      this.camYaw += wrapAngle(targetYaw - this.camYaw) * (1 - Math.exp(-params.camYawFollowRate * dt));
    }

    // Chase camera sits BEHIND the kart along the followed heading: behind = -forward.
    const camFwd = forwardOf(this.camYaw);
    const camTarget = pos.clone()
      .addScaledVector(camFwd, -8)
      .add(new THREE.Vector3(0, 5, 0));
    camera.position.lerp(camTarget, 1 - Math.exp(-4 * dt));
    camera.lookAt(pos.x, pos.y + 1, pos.z);
  }
}
