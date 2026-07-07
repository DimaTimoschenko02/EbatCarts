// Client-side kart-vs-kart circle collision. Pure math, no THREE — same
// "physics/ has no engine deps" convention as bicyclePhysics.ts.
//
// Design: there is no server authority for kart-kart contact yet (see
// network-programmer brief). Instead, EACH client independently pushes its
// OWN kart away from every OTHER (already network-interpolated) kart it
// overlaps. Because both clients run the same resolution locally against
// each other's rendered position, the effect reads as symmetric even though
// neither side is authoritative — same trick client-side rigidbody demos use
// for "good enough" local-only collision in an owner-authoritative game.
//
// The caller (Kart.update, kart/kart.ts) is responsible for re-validating the
// result against the map heightfield afterwards — this module knows nothing
// about walls/terrain, it only resolves circle-circle overlap.

export interface Vec2 {
  x: number;
  z: number;
}

export interface KartObstacle {
  x: number;
  z: number;
  alive: boolean;
}

// Tune by feel — not derived from the visual mesh bounds (kart body is
// roughly 1.4m wide x 2.4m long). A circle this size gives a bit of grace
// for grazing side-by-side driving before it starts shoving.
export const KART_COLLISION_RADIUS = 0.9;

// Fraction of closing speed reflected back as bounce (0 = fully inelastic
// stop along the normal, 1 = perfectly elastic). Low value reads as "karts
// bumping", not "karts pinballing".
const RESTITUTION = 0.3;

// Resolves overlap between the LOCAL kart (pos/vel) and every alive obstacle
// in `obstacles`. Dead karts are ignored entirely (no collision with a
// corpse). Multiple overlaps are resolved sequentially against the running
// pos/vel — fine for the handful of karts an arcade match has, and avoids
// needing a real physics solver for what's a cosmetic-feel bump, not a
// hard-authoritative rule.
export function resolveKartPush(
  pos: Vec2,
  vel: Vec2,
  obstacles: readonly KartObstacle[],
  radius: number = KART_COLLISION_RADIUS
): { pos: Vec2; vel: Vec2 } {
  let px = pos.x;
  let pz = pos.z;
  let vx = vel.x;
  let vz = vel.z;
  const minDist = radius * 2;

  for (const o of obstacles) {
    if (!o.alive) continue;
    const dx = px - o.x;
    const dz = pz - o.z;
    const dist = Math.hypot(dx, dz);
    // No overlap, or exactly coincident (degenerate normal — bail rather
    // than divide by zero; vanishingly unlikely for two moving karts anyway).
    if (dist >= minDist || dist < 1e-6) continue;

    const nx = dx / dist;
    const nz = dz / dist;
    const penetration = minDist - dist;

    // Positional correction: push the local kart fully out of the overlap.
    px += nx * penetration;
    pz += nz * penetration;

    // Velocity: kill (+ partially bounce) only the component ALONG the
    // normal (closing speed), leave the tangential component — sliding past
    // each other — untouched. Skip entirely if already separating (avoid
    // adding energy to a pair that's moving apart).
    const vDotN = vx * nx + vz * nz;
    if (vDotN < 0) {
      const scale = (1 + RESTITUTION) * vDotN;
      vx -= scale * nx;
      vz -= scale * nz;
    }
  }

  return { pos: { x: px, z: pz }, vel: { x: vx, z: vz } };
}
