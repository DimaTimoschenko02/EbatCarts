// Colyseus schema for the match room. Kept intentionally minimal for the
// owner-authoritative skeleton: position/yaw is whatever the owning client
// last reported (validated, not simulated) — no server-side physics here.
//
// NOTE (TS decorators): `@type()` is a legacy (TS "experimentalDecorators")
// property decorator, not a stage-3 ECMAScript decorator. This file is only
// ever compiled through server/tsconfig.json, which sets
// `experimentalDecorators: true` + `useDefineForClassFields: false` — the
// latter matters because with the default ES2022 class-field semantics
// ([[Define]]), a field initializer like `x = 0` would silently overwrite
// the getter/setter that `@type` installs on the prototype. The client-side
// tsconfig (web-slice/tsconfig.json) never includes this directory, so it
// never needs these (decorator-incompatible) options.
import { MapSchema, Schema, type } from "@colyseus/schema";

export class Player extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") z = 0;
  @type("number") yaw = 0;
  @type("string") nick = "guest";
  @type("string") kartType = "racer";
  @type("number") hp = 100;
  // Combat additions (P3 vertical slice, docs/p2-port-notes.md §1-3).
  @type("boolean") alive = true;
  @type("string") weapon = ""; // "" (EMPTY) | "rocket" (ARMED) — single-slot, no ammo counter (reference behavior)
  // Match stats: server is the source of truth (not client-tallied) because
  // the next stage (match-end submit to master, /api/internal/match/submit)
  // needs these numbers to survive reconnect/late-join without drifting from
  // whatever broadcast events a given client happened to see.
  @type("number") kills = 0;
  @type("number") deaths = 0;
}

// Weapon pickup box (docs/p2-port-notes.md §2). One "prize" only (rocket) —
// the reference has no weighted pool, so there's nothing to pick between.
export class WeaponBox extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") z = 0;
  @type("boolean") active = true;
}

export class MatchState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: WeaponBox }) boxes = new MapSchema<WeaponBox>();
}
