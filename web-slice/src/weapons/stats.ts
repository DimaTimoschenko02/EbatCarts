// Data-driven weapon catalogue — same pattern as kart/stats.ts's KART_TYPES.
// Ported from the Godot reference (docs/p2-port-notes.md §1), NOT from the
// GDD's weapon-system.md: only "rocket" actually exists in the reference
// code (no WeaponComponent, no ammo counter, no Shotgun/Mine/Dynamite/Laser —
// those are GDD design intent that was never implemented). Add new entries
// here if/when a second weapon type is actually built; never hardcode numbers
// into server/client combat logic.
//
// Both the client (rocket VFX prediction) and the server (server/weapons/
// rocketSim.ts, authoritative sim) read from this same table so tuning a
// number here changes both sides at once.
export interface ProjectileStats {
  readonly id: string; // "rocket"
  readonly speed: number; // m/s, straight-line, gravityScale=0 (rocket_config.tres:7)
  readonly lifetime: number; // s, AOE-explodes on expiry if nothing else stops it first (rocket_config.tres:8)
  readonly baseDamage: number; // rocket_config.tres:10
  readonly aoeRadius: number; // m, linear falloff to 0 at this radius (rocket_config.tres:11)
  readonly selfDamage: boolean; // rocket_config.tres:12 — false: shooter excluded from its own blast
  readonly spreadDeg: number; // kart_controller.gd:60 ROCKET_SPREAD_DEG — fan angle for the side rockets
  readonly volleyCount: number; // how many rockets fire per shot (reference: 1-3 depending on launcher
  // sockets present on the kart model; our craft_racer has no socket meshes,
  // so we always fire the full 3-rocket fan from a single muzzle point to
  // preserve the reference's "feel" — see decision in the combat-slice plan)
  // UNCONFIRMED vs the Godot .tscn Area3D shape (not read this session) —
  // tune by feel, not a spec value:
  readonly hitRadius: number; // m, proximity trigger radius for exploding on a kart
}

export const WEAPON_TYPES: Readonly<Record<string, ProjectileStats>> = {
  rocket: {
    id: "rocket",
    speed: 40,
    lifetime: 6.0,
    baseDamage: 40,
    aoeRadius: 3.5,
    selfDamage: false,
    spreadDeg: 10,
    volleyCount: 3,
    hitRadius: 1.0,
  },
};
