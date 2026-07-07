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
}

export class MatchState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}
