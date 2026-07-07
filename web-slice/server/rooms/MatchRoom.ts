// Owner-authoritative position relay (movement) + fully server-authoritative
// combat (weapons/damage/death/respawn/pickups), per docs/p2-port-notes.md
// §1-3. Movement stays owner-authoritative: each client simulates its own
// kart locally (src/physics/, untouched) and reports pose at ~20Hz; the
// server only validates and mirrors it. Everything about combat — firing,
// hit detection, damage, death, respawn point selection, weapon-box pickup —
// is decided here and only here; clients render what the server tells them.
import { Client, Room } from "colyseus";
import { MatchState, Player, WeaponBox } from "../schema/MatchState";
import { ARENA_HEIGHTFIELD, BOX_POINTS, SPAWN_POINTS, groundHeightAt, type WorldPoint } from "../config/arena";
import { faceCenterYaw, pickInitialSpawn, pickRespawnSpawn } from "../spawn/spawnSelect";
import { WEAPON_TYPES } from "../../src/weapons/stats";
import {
  computeAoeDamage,
  computeLaunchPitchRad,
  computeMuzzleDirections,
  findProximityHit,
  isBlockedByTerrain,
  stepRocket,
  tiltDirection3D,
  type PlayerPoint,
} from "../weapons/rocketSim";

const ROCKET = WEAPON_TYPES.rocket;

const MAX_COORD = 1000; // sanity bound — well outside any real arena extent

// UNCONFIRMED vs the Godot .tscn Area3D pickup shape (not read this session,
// see docs/p2-port-notes.md §2 TODO) — tune by feel, not a spec value.
const BOX_PICKUP_RADIUS_M = 1.2;
const BOX_RESPAWN_MS = 10_000; // scripts/weapon_pickup.gd:3 RESPAWN_TIME — this one IS confirmed
const BOX_HOVER_HEIGHT_M = 0.5; // cosmetic only — how high the box floats above the ground for rendering

const DEATH_RESPAWN_DELAY_MS = 3_000; // state_manager.gd:13 RESPAWN_DELAY (confirmed)
const RESPAWN_INVULN_MS = 2_000; // state_manager.gd:14 RESPAWN_INVULN_DURATION (confirmed)

// Match timer (docs/p2-port-notes.md §4). The Express lobby already validates
// a duration_min whitelist (server/rooms/rooms.constants.js DURATION_MIN_OPTIONS
// = [5, 10, 20]) and defaults new rooms to 5 — this Colyseus room isn't wired
// to that lobby yet (no options plumbed through matchMaker), so it always uses
// that same 5-minute default for now. MATCH_DURATION_MS env override exists
// only so tools/match_flow_smoke.mjs can run a match end-to-end in seconds
// instead of minutes; it's not meant to be set in production.
const DEFAULT_MATCH_DURATION_MS = 5 * 60_000;
const MATCH_DURATION_MS = Number.parseInt(process.env.MATCH_DURATION_MS ?? "", 10) || DEFAULT_MATCH_DURATION_MS;
const MATCH_RESTART_DELAY_MS = 15_000;

// UNCONFIRMED vs the Godot muzzle socket offsets (kart_controller.gd sockets
// carry their own local transform we don't have — our craft_racer model has
// no launcher meshes at all, see src/weapons/stats.ts volleyCount comment).
// Tune by feel.
const MUZZLE_FORWARD_OFFSET_M = 1.2;
const MUZZLE_HEIGHT_OFFSET_M = 0.5;

const ROCKET_SIM_HZ = 30;

interface StateMessage {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

// Rate-limited anomaly logging: a bad/hostile client sending garbage every
// tick must not flood the server log.
const ANOMALY_LOG_INTERVAL_MS = 2000;
let lastAnomalyLogAt = 0;

function logAnomaly(sessionId: string, reason: string): void {
  const now = Date.now();
  if (now - lastAnomalyLogAt < ANOMALY_LOG_INTERVAL_MS) return;
  lastAnomalyLogAt = now;
  console.warn(`[match] rejected state from ${sessionId}: ${reason}`);
}

function isValidNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// Never trust the client: every field must be a finite number within
// plausible map bounds before it's allowed to touch shared state.
function validateStateMessage(data: unknown, sessionId: string): StateMessage | null {
  if (typeof data !== "object" || data === null) {
    logAnomaly(sessionId, "payload not an object");
    return null;
  }
  const d = data as Record<string, unknown>;
  if (!isValidNumber(d.x) || !isValidNumber(d.y) || !isValidNumber(d.z) || !isValidNumber(d.yaw)) {
    logAnomaly(sessionId, "non-finite or missing x/y/z/yaw");
    return null;
  }
  if (Math.abs(d.x) > MAX_COORD || Math.abs(d.y) > MAX_COORD || Math.abs(d.z) > MAX_COORD) {
    logAnomaly(sessionId, "coordinate out of bounds");
    return null;
  }
  return { x: d.x, y: d.y, z: d.z, yaw: d.yaw };
}

// Server-only bookkeeping for an in-flight rocket — never mirrored into
// MatchState (see file header on the broadcast-vs-schema decision for
// projectiles: deterministic straight-line motion means the client can
// render it analytically from a single "rocket:spawn" message).
interface ActiveRocket {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  z: number;
  dx: number; // 3D unit direction — no longer horizontal-only, see
  dy: number; // computeLaunchPitchRad/tiltDirection3D in rocketSim.ts. Still
  dz: number; // gravityScale=0: the tilt is fixed once at launch, not re-aimed.
  speed: number;
  age: number;
  lifetime: number;
}

// Colyseus defaults patchRate to 50ms (20Hz, see @colyseus/core Room.ts
// DEFAULT_PATCH_RATE) — slower than the 30Hz (~33ms) cadence clients already
// send "state" at (netClient.ts SEND_INTERVAL_MS), so schema mutations from
// handleState() below could sit queued for up to 50ms before the next patch
// broadcast even though they were applied to the schema instantly. Matching
// the two rates removes that dead time from the movement-relay latency
// budget without changing anything about WHAT gets sent, only how often the
// server flushes it — a simulation/transport setting, not game logic.
const PATCH_RATE_MS = 1000 / 30;

export class MatchRoom extends Room<{ state: MatchState }> {
  maxClients = 8;
  patchRate = PATCH_RATE_MS;

  private rockets: ActiveRocket[] = [];
  private nextRocketId = 0;
  private spawnIndex = 0;
  // Respawn invulnerability window, keyed by sessionId — server-only, not
  // mirrored to schema (no shield VFX in this pass, just damage immunity).
  private invulnerableUntil = new Map<string, number>();

  onCreate(): void {
    this.setState(new MatchState());

    BOX_POINTS.forEach((p, i) => {
      const box = new WeaponBox();
      box.x = p.x;
      box.z = p.z;
      box.y = groundHeightAt(p) + BOX_HOVER_HEIGHT_M;
      box.active = true;
      this.state.boxes.set(String(i), box);
    });

    this.onMessage("state", (client, data: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return; // message arrived after leave/before join settled
      if (!player.alive) return; // corpses don't move (extra safety net — a
      // well-behaved client already stops reporting while dead, see
      // src/combat/index.ts, but a buggy/compromised one must not be able to
      // relocate a dead kart through the state channel).
      const validated = validateStateMessage(data, client.sessionId);
      if (!validated) return;
      player.x = validated.x;
      player.y = validated.y;
      player.z = validated.z;
      player.yaw = validated.yaw;
    });

    this.onMessage("fire", client => this.handleFire(client));

    this.setSimulationInterval(dt => this.tick(dt), 1000 / ROCKET_SIM_HZ);

    // TODO: start the clock on first join / lobby "ready" signal instead of
    // room creation — deferred until the Express lobby actually creates this
    // room with player-controlled timing. For now (MVP) the timer starts the
    // instant the room object exists, same as everything else in onCreate().
    this.state.phase = "playing";
    this.startMatchTimer();
  }

  onJoin(client: Client, options?: { nick?: string; kartType?: string }): void {
    const player = new Player();
    const spawn = pickInitialSpawn(SPAWN_POINTS, this.spawnIndex++);
    player.x = spawn.x;
    player.y = groundHeightAt(spawn);
    player.z = spawn.z;
    player.yaw = faceCenterYaw(spawn);
    player.nick = options?.nick?.slice(0, 24) || "guest";
    player.kartType = options?.kartType === "racer" ? "racer" : "racer"; // only one kart type exists today
    player.hp = 100;
    player.alive = true;
    player.weapon = "";
    this.state.players.set(client.sessionId, player);
    console.log(`[match] ${client.sessionId} joined as "${player.nick}" (${this.state.players.size}/${this.maxClients})`);
  }

  onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
    this.invulnerableUntil.delete(client.sessionId);
    console.log(`[match] ${client.sessionId} left (${this.state.players.size}/${this.maxClients})`);
  }

  // ── Match timer / end / restart ──────────────────────────────────────
  private startMatchTimer(): void {
    this.state.matchEndsAt = Date.now() + MATCH_DURATION_MS;
    this.clock.setTimeout(() => this.endMatch(), MATCH_DURATION_MS);
  }

  // Freezes combat (fire/damage/pickup all check `phase === "playing"`),
  // snapshots the scoreboard for the client's Final Score overlay, and
  // schedules the restart. Doesn't touch player position/hp/weapon here —
  // that reset happens all at once in restartMatch() so a player who died
  // seconds before the whistle doesn't flicker back to life mid-freeze.
  private endMatch(): void {
    this.state.phase = "ended";
    const table = Array.from(this.state.players.entries()).map(([id, p]) => ({
      id,
      nick: p.nick,
      kills: p.kills,
      deaths: p.deaths,
    }));
    const restartAt = Date.now() + MATCH_RESTART_DELAY_MS;
    this.broadcast("match:end", { table, restartAt });
    this.clock.setTimeout(() => this.restartMatch(), MATCH_RESTART_DELAY_MS);
  }

  // Same room, same connections — just wipes stats/hp/weapons and
  // re-scatters everyone across the spawn points (round-robin, same as a
  // fresh join) rather than leaving corpses/mid-match positions lying around.
  private restartMatch(): void {
    this.rockets = [];
    this.invulnerableUntil.clear();
    this.spawnIndex = 0;
    for (const player of this.state.players.values()) {
      const spawn = pickInitialSpawn(SPAWN_POINTS, this.spawnIndex++);
      player.x = spawn.x;
      player.y = groundHeightAt(spawn);
      player.z = spawn.z;
      player.yaw = faceCenterYaw(spawn);
      player.hp = 100;
      player.alive = true;
      player.weapon = "";
      player.kills = 0;
      player.deaths = 0;
    }
    for (const box of this.state.boxes.values()) box.active = true;
    this.state.phase = "playing";
    this.startMatchTimer();
    this.broadcast("match:restart", { matchEndsAt: this.state.matchEndsAt });
  }

  // ── Fire ────────────────────────────────────────────────────────────
  private handleFire(client: Client): void {
    if (this.state.phase !== "playing") return; // fire is disabled during the end-of-match freeze
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (!player.alive || player.weapon !== "rocket") return; // can_fire() guard: alive AND armed

    // Consume immediately (ARMED -> EMPTY), no ammo counter, no separate
    // cooldown timer — matches the reference (docs/p2-port-notes.md §1).
    player.weapon = "";

    const fwd = { x: -Math.sin(player.yaw), z: -Math.cos(player.yaw) };
    const originX = player.x + fwd.x * MUZZLE_FORWARD_OFFSET_M;
    const originZ = player.z + fwd.z * MUZZLE_FORWARD_OFFSET_M;
    const originY = player.y + MUZZLE_HEIGHT_OFFSET_M;

    for (const dir of computeMuzzleDirections(player.yaw, ROCKET)) {
      // Ground-slope-aware pitch: nose the rocket up/down to match the
      // terrain under the shooter (ramps, plateaus) instead of always flying
      // dead level — sampled once at launch, then baked into a fixed 3D
      // direction (gravityScale=0, still a straight line, just tilted).
      // Probed around the KART (player.x/z), NOT the muzzle: the muzzle sits
      // 1.2m ahead, past the edge of a 1m ramp tile — see the regression
      // note on computeLaunchPitchRad in rocketSim.ts.
      const pitch = computeLaunchPitchRad(player.x, player.z, dir.dx, dir.dz, ARENA_HEIGHTFIELD);
      const dir3d = tiltDirection3D(dir.dx, dir.dz, pitch);

      const id = `r${this.nextRocketId++}`;
      const rocket: ActiveRocket = {
        id,
        ownerId: client.sessionId,
        x: originX,
        y: originY,
        z: originZ,
        dx: dir3d.x,
        dy: dir3d.y,
        dz: dir3d.z,
        speed: ROCKET.speed,
        age: 0,
        lifetime: ROCKET.lifetime,
      };
      this.rockets.push(rocket);
      this.broadcast("rocket:spawn", {
        id,
        ownerId: client.sessionId,
        x: rocket.x,
        y: rocket.y,
        z: rocket.z,
        dx: dir3d.x,
        dy: dir3d.y, // NEW field — additive to the rocket:spawn payload, lets
        // the client extrapolate the same tilted straight line the server
        // simulates instead of assuming flat flight (src/combat/rockets.ts).
        dz: dir3d.z,
        speed: ROCKET.speed,
        lifetime: ROCKET.lifetime,
      });
    }
  }

  // ── Simulation tick (rockets + box pickup) ───────────────────────────
  private tick(deltaTimeMs: number): void {
    const dt = deltaTimeMs / 1000;
    this.tickRockets(dt);
    this.tickBoxes();
  }

  private alivePlayerPoints(): PlayerPoint[] {
    const out: PlayerPoint[] = [];
    for (const [id, p] of this.state.players.entries()) {
      if (p.alive) out.push({ id, x: p.x, z: p.z });
    }
    return out;
  }

  private tickRockets(dt: number): void {
    if (this.rockets.length === 0) return;
    const alive = this.alivePlayerPoints();
    const remaining: ActiveRocket[] = [];

    for (const rocket of this.rockets) {
      rocket.age += dt;
      const next = stepRocket(
        { x: rocket.x, y: rocket.y, z: rocket.z },
        { x: rocket.dx, y: rocket.dy, z: rocket.dz },
        rocket.speed,
        dt
      );
      rocket.x = next.x;
      rocket.y = next.y;
      rocket.z = next.z;

      const hitId = findProximityHit(rocket, alive, ROCKET.hitRadius, rocket.ownerId, ROCKET.selfDamage);
      // Checked against the rocket's CURRENT altitude every tick (not a
      // frozen launch-time height) — this is what lets a rocket that flew
      // over a low point still explode when it reaches a hill further along
      // its (possibly tilted) straight line.
      const blocked = isBlockedByTerrain(next, ARENA_HEIGHTFIELD);
      const expired = rocket.age >= rocket.lifetime;

      if (hitId || blocked || expired) {
        this.explodeRocket(rocket, alive);
        continue; // consumed — do not keep simulating
      }
      remaining.push(rocket);
    }
    this.rockets = remaining;
  }

  // Every explosion trigger (proximity hit / terrain / bounds / lifetime)
  // resolves through the same AOE-with-falloff formula — see
  // server/weapons/rocketSim.ts file header for why there's no separate
  // "direct hit" damage amount (matches the reference exactly).
  private explodeRocket(rocket: ActiveRocket, alive: readonly PlayerPoint[]): void {
    this.broadcast("rocket:explode", { id: rocket.id, x: rocket.x, y: rocket.y, z: rocket.z });
    const damage = computeAoeDamage({ x: rocket.x, z: rocket.z }, alive, ROCKET, rocket.ownerId);
    for (const [victimId, dmg] of damage) {
      this.applyDamage(victimId, dmg, rocket.ownerId);
    }
  }

  private applyDamage(victimId: string, dmg: number, killerId: string): void {
    if (this.state.phase !== "playing") return; // no damage during the end-of-match freeze
    const victim = this.state.players.get(victimId);
    if (!victim || !victim.alive) return;
    const invulnUntil = this.invulnerableUntil.get(victimId) ?? 0;
    if (Date.now() < invulnUntil) return; // fresh-respawn immunity window

    victim.hp = Math.max(0, victim.hp - dmg);
    if (victim.hp <= 0) this.killPlayer(victimId, killerId);
  }

  private killPlayer(victimId: string, killerId: string): void {
    const victim = this.state.players.get(victimId);
    if (!victim) return;
    victim.alive = false;
    victim.deaths += 1;
    // Weapon IS cleared on death. The reference Godot code does NOT do this
    // (docs/p2-port-notes.md §1 step 8 flags it as a likely oversight in the
    // original rather than a deliberate design choice) — this is an explicit
    // game-designer deviation from the ported reference: dying always clears
    // whatever weapon you were holding, matching the GDD's stated intent
    // instead of the buggier reference behavior.
    victim.weapon = "";
    if (killerId !== victimId) {
      const killer = this.state.players.get(killerId);
      if (killer) killer.kills += 1;
    }
    this.broadcast("kill", { victimId, killerId });
    this.clock.setTimeout(() => this.respawnPlayer(victimId), DEATH_RESPAWN_DELAY_MS);
  }

  private respawnPlayer(sessionId: string): void {
    // Scoreboard-freeze window: the pending 3s respawn timer from a kill just
    // before the whistle can still fire here. Skip it — restartMatch() will
    // bring everyone back (full hp, fresh spawn) all at once shortly anyway,
    // so an early one-off respawn here would just get immediately overwritten.
    if (this.state.phase !== "playing") return;
    const player = this.state.players.get(sessionId);
    if (!player) return; // left the room while dead

    const enemies: WorldPoint[] = [];
    for (const [id, p] of this.state.players.entries()) {
      if (id !== sessionId && p.alive) enemies.push({ x: p.x, z: p.z });
    }
    const spawn = pickRespawnSpawn(SPAWN_POINTS, enemies);
    const yaw = faceCenterYaw(spawn);

    player.x = spawn.x;
    player.z = spawn.z;
    player.y = groundHeightAt(spawn);
    player.yaw = yaw;
    player.hp = 100;
    player.alive = true;

    this.invulnerableUntil.set(sessionId, Date.now() + RESPAWN_INVULN_MS);

    // Movement is owner-authoritative — the "state" messages a client sends
    // are ITS OWN pose. A respawn teleport must be pushed to that one client
    // so it can reset its own locally-simulated kart; other clients simply
    // see the new pose arrive via the next "state" message once the
    // respawned client resumes reporting (schema mirrors that automatically).
    this.clients.getById(sessionId)?.send("respawn", { x: spawn.x, z: spawn.z, yaw });
  }

  // ── Weapon boxes ─────────────────────────────────────────────────────
  private tickBoxes(): void {
    if (this.state.phase !== "playing") return; // no pickups during the end-of-match freeze
    for (const [boxId, box] of this.state.boxes.entries()) {
      if (!box.active) continue;
      for (const player of this.state.players.values()) {
        if (!player.alive || player.weapon !== "") continue; // reference: pickup ignored while already ARMED, no replace-on-pickup
        const dist = Math.hypot(player.x - box.x, player.z - box.z);
        if (dist > BOX_PICKUP_RADIUS_M) continue;
        player.weapon = "rocket";
        box.active = false;
        this.scheduleBoxRespawn(boxId);
        break; // one pickup per box per tick
      }
    }
  }

  private scheduleBoxRespawn(boxId: string): void {
    this.clock.setTimeout(() => {
      const box = this.state.boxes.get(boxId);
      if (!box) return;
      box.active = true;
      // Immediate re-check for someone already parked on the respawn spot —
      // mirrors `_try_give_from_overlaps()` in the reference instead of
      // waiting for the next simulation tick.
      this.tickBoxes();
    }, BOX_RESPAWN_MS);
  }
}
