// Pure spawn-selection logic — no Colyseus/schema deps, unit-testable in
// isolation. Ports the behavior documented in docs/p2-port-notes.md §3
// (scripts/spawn_manager.gd): round-robin for initial spawn, farthest-from-
// nearest-alive-enemy for respawn, face-arena-center rotation for both.
export interface WorldPoint {
  x: number;
  z: number;
}

// Sequential round-robin — mirrors `_next_index % size` in the reference.
// Caller owns the index (server increments it per join).
export function pickInitialSpawn(points: readonly WorldPoint[], index: number): WorldPoint {
  return points[index % points.length];
}

// For each candidate spawn point, finds the minimum distance to any alive
// enemy; picks the point that maximizes that minimum (farthest-from-nearest-
// enemy). With no enemies alive, any point ties at Infinity — returns the
// first. Mirrors `get_respawn_point` in spawn_manager.gd.
export function pickRespawnSpawn(
  points: readonly WorldPoint[],
  aliveEnemyPositions: readonly WorldPoint[]
): WorldPoint {
  let best = points[0];
  let bestMinDist = -Infinity;
  for (const p of points) {
    const minDist = aliveEnemyPositions.length === 0
      ? Infinity
      : Math.min(...aliveEnemyPositions.map(e => Math.hypot(e.x - p.x, e.z - p.z)));
    if (minDist > bestMinDist) {
      bestMinDist = minDist;
      best = p;
    }
  }
  return best;
}

// Rotation (radians) so the kart's forward (-Z at yaw=0, see kart/kart.ts
// forwardOf) faces the arena center (0,0) from spawnPos. Reference:
// `_face_center_rotation` in game_world.gd — resolved GDD Open Question #1
// ("face center or Marker3D rotation?") in favor of "face center".
export function faceCenterYaw(spawnPos: WorldPoint): number {
  if (spawnPos.x === 0 && spawnPos.z === 0) return 0;
  // forwardOf(yaw) = (-sin(yaw), 0, -cos(yaw)) (kart/kart.ts). We want that
  // vector to point from spawnPos toward the origin, i.e. equal to
  // (-spawnPos.x, -spawnPos.z) up to scale. Solving -sin(yaw) = -spawnPos.x
  // and -cos(yaw) = -spawnPos.z gives yaw = atan2(spawnPos.x, spawnPos.z).
  return Math.atan2(spawnPos.x, spawnPos.z);
}
