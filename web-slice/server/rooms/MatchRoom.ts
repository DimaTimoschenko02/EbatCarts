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
  computeMuzzleDirections,
  findProximityHit,
  isBlockedByTerrain,
  stepRocket,
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
  z: number;
  dx: number;
  dz: number;
  speed: number;
  age: number;
  lifetime: number;
  flightHeight: number; // constant — gravityScale=0, rocket flies dead level
}

export class MatchRoom extends Room<{ state: MatchState }> {
  maxClients = 8;

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

  // ── Fire ────────────────────────────────────────────────────────────
  private handleFire(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (!player.alive || player.weapon !== "rocket") return; // can_fire() guard: alive AND armed

    // Consume immediately (ARMED -> EMPTY), no ammo counter, no separate
    // cooldown timer — matches the reference (docs/p2-port-notes.md §1).
    player.weapon = "";

    const fwd = { x: -Math.sin(player.yaw), z: -Math.cos(player.yaw) };
    const originX = player.x + fwd.x * MUZZLE_FORWARD_OFFSET_M;
    const originZ = player.z + fwd.z * MUZZLE_FORWARD_OFFSET_M;
    const flightHeight = player.y + MUZZLE_HEIGHT_OFFSET_M;

    for (const dir of computeMuzzleDirections(player.yaw, ROCKET)) {
      const id = `r${this.nextRocketId++}`;
      const rocket: ActiveRocket = {
        id,
        ownerId: client.sessionId,
        x: originX,
        z: originZ,
        dx: dir.dx,
        dz: dir.dz,
        speed: ROCKET.speed,
        age: 0,
        lifetime: ROCKET.lifetime,
        flightHeight,
      };
      this.rockets.push(rocket);
      this.broadcast("rocket:spawn", {
        id,
        ownerId: client.sessionId,
        x: rocket.x,
        y: flightHeight,
        z: rocket.z,
        dx: dir.dx,
        dz: dir.dz,
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
      const next = stepRocket({ x: rocket.x, z: rocket.z }, { x: rocket.dx, z: rocket.dz }, rocket.speed, dt);
      rocket.x = next.x;
      rocket.z = next.z;

      const hitId = findProximityHit(rocket, alive, ROCKET.hitRadius, rocket.ownerId, ROCKET.selfDamage);
      const blocked = isBlockedByTerrain(rocket, rocket.flightHeight, ARENA_HEIGHTFIELD);
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
    this.broadcast("rocket:explode", { id: rocket.id, x: rocket.x, y: rocket.flightHeight, z: rocket.z });
    const damage = computeAoeDamage({ x: rocket.x, z: rocket.z }, alive, ROCKET, rocket.ownerId);
    for (const [victimId, dmg] of damage) {
      this.applyDamage(victimId, dmg, rocket.ownerId);
    }
  }

  private applyDamage(victimId: string, dmg: number, killerId: string): void {
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
    // Weapon is NOT cleared on death — matches the actual reference code
    // (docs/p2-port-notes.md §1 step 8 flags this as likely an oversight in
    // the original, not a deliberate design choice, but we port the code as
    // written, not the GDD's stated intent).
    if (killerId !== victimId) {
      const killer = this.state.players.get(killerId);
      if (killer) killer.kills += 1;
    }
    this.broadcast("kill", { victimId, killerId });
    this.clock.setTimeout(() => this.respawnPlayer(victimId), DEATH_RESPAWN_DELAY_MS);
  }

  private respawnPlayer(sessionId: string): void {
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
