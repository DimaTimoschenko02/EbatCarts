// Body attitude (pitch/roll) from the heightfield — shared by the local kart
// (kart.ts, physics-driven) and remote karts (net/remoteKarts.ts, computed
// purely from the network-synced XZ/yaw + the SAME local map, no extra wire
// data needed). Pure math, no THREE Object3D — callers own their own
// exp-filter state and apply .pitch/.roll to rotation.x/.z themselves.
//
// Sign convention verified against THREE's Euler "YXZ" composition (rotation
// order: Z, then X, then Y — see kart.ts syncVisual): a positive rotation.x
// tips the -Z-pointing nose UP in world space regardless of yaw, and a
// positive rotation.z tips the +X ("right") side UP regardless of yaw. Both
// targets below are built so "the ground is higher on side X" maps directly
// to "that side of the body sits higher" — i.e. the body follows the
// terrain, exactly like it already does vertically (kart.ts groundY).
import type { GameMap } from "../map/mapLoader";

export interface AttitudeTarget {
  pitch: number; // radians, +up at the nose when climbing
  roll: number; // radians, +up on the +X ("right") side
}

const LEVEL: AttitudeTarget = { pitch: 0, roll: 0 };

// `fwd`/`right` are unit vectors in world XZ (y=0) at the body's current yaw
// — same convention as kart/kart.ts forwardOf()/rightOf(). `halfWheelbase`/
// `halfTrack` are the fore-aft / left-right probe half-distances (half the
// axle geometry — see DEFAULT_AXLE_GEOMETRY).
export function computeAttitudeTarget(
  map: GameMap | null,
  x: number,
  z: number,
  fwd: { x: number; z: number },
  right: { x: number; z: number },
  halfWheelbase: number,
  halfTrack: number
): AttitudeTarget {
  if (!map) return LEVEL;
  const hHere = map.sampleHeight(x, z);
  if (hHere === null) return LEVEL;

  const hF = map.sampleHeight(x + fwd.x * halfWheelbase, z + fwd.z * halfWheelbase) ?? hHere;
  const hB = map.sampleHeight(x - fwd.x * halfWheelbase, z - fwd.z * halfWheelbase) ?? hHere;
  const hR = map.sampleHeight(x + right.x * halfTrack, z + right.z * halfTrack) ?? hHere;
  const hL = map.sampleHeight(x - right.x * halfTrack, z - right.z * halfTrack) ?? hHere;

  return {
    pitch: Math.atan2(hF - hB, halfWheelbase * 2),
    roll: Math.atan2(hR - hL, halfTrack * 2),
  };
}
