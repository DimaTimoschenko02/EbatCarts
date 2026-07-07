// Data-driven kart catalogue. A new kart type (small+fast / large+tanky) is
// a new KART_TYPES entry with physics overrides — zero changes to Kart or
// the physics modules. See design/gdd (kart types) once that spec lands.
import { DEFAULT_KART_PHYSICS_PARAMS, type KartPhysicsParams } from "../physics/types";

export interface KartStats {
  readonly id: string;
  readonly displayName: string;
  readonly model: string; // glb asset name under /assets/space-kit/
  readonly modelLength: number; // target Z-length in meters, see loadKartModel
  readonly maxHp: number; // reserved for weapons (P2) — not consumed yet
  readonly physics: Partial<KartPhysicsParams>; // overrides layered on DEFAULT_KART_PHYSICS_PARAMS
  // axle geometry (wheelbase/trackWidth): add a per-kart override here (e.g.
  // `axle: Partial<AxleGeometry>`) when a second kart type needs one — every
  // kart currently shares DEFAULT_AXLE_GEOMETRY, see kart/kart.ts.
}

export const KART_TYPES: Readonly<Record<string, KartStats>> = {
  racer: {
    id: "racer",
    displayName: "Craft Racer",
    model: "craft_racer",
    modelLength: 2.2,
    maxHp: 100,
    physics: {},
  },
};

// Merges a kart's physics overrides on top of the tuned defaults. Pulled out
// as a pure function so the merge order (defaults first, overrides win) is
// unit-tested independently of Kart/THREE.
export function buildKartPhysicsParams(stats: KartStats): KartPhysicsParams {
  return { ...DEFAULT_KART_PHYSICS_PARAMS, ...stats.physics };
}
