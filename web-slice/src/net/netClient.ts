// Colyseus connection: owner-authoritative — we send OUR OWN simulated pose
// at a throttled rate and receive OTHER players' poses via schema callbacks.
// No server physics/prediction here (see server/rooms/MatchRoom.ts).
//
// Networking is strictly optional: if the match server (default :8091) is
// unreachable, connect() resolves to null and the game keeps running
// perfectly fine offline (single-player is the fallback, not an error case).
//
// Deliberately NOT importing server/schema/MatchState.ts here: that module is
// decorator syntax that only compiles under server/tsconfig.json's
// experimentalDecorators. Importing its types (even `import type`) would
// pull the file into the client tsc program and break `npx tsc --noEmit`
// from web-slice/. The Colyseus wire protocol supports schema auto-discovery
// via Reflection, so the client never needs the server's class definitions
// at compile time — RemotePlayerState below just mirrors the shape.
import { Callbacks, Client, type Room } from "@colyseus/sdk";

export interface RemotePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

// Structural mirror of server/schema/MatchState.ts's Player fields — kept in
// sync by hand (small enough that a shared schema-derived type isn't worth
// the cross-context import cost yet).
export interface RemotePlayerState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  nick: string;
  kartType: string;
  hp: number;
  alive: boolean;
  weapon: string; // "" | "rocket"
  kills: number;
  deaths: number;
}

// Wire payloads for the combat broadcast/targeted messages (server/rooms/
// MatchRoom.ts) — projectiles are NOT schema-tracked (see that file's header
// for why), so these are the only source of truth for rendering them.
export interface RocketSpawnMsg {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  speed: number;
  lifetime: number;
}
export interface RocketExplodeMsg {
  id: string;
  x: number;
  y: number;
  z: number;
}
export interface KillMsg {
  victimId: string;
  killerId: string;
}
export interface RespawnMsg {
  x: number;
  z: number;
  yaw: number;
}

// Match flow (server/rooms/MatchRoom.ts endMatch()/restartMatch(),
// server/schema/MatchState.ts matchEndsAt/phase). Sent as plain broadcast
// messages rather than read live off room.state — the scoreboard table is a
// point-in-time snapshot, not a tracked collection, so this keeps the wire
// contract in the same "server broadcasts an event, client renders it" shape
// as the rest of combat/ (rocket:spawn, kill, respawn) instead of adding a
// third way (schema polling) to observe match state.
export interface ScoreboardRow {
  id: string;
  nick: string;
  kills: number;
  deaths: number;
}
export interface MatchEndMsg {
  table: ScoreboardRow[];
  restartAt: number; // unix ms — when restartMatch() is scheduled to run
}
export interface MatchRestartMsg {
  matchEndsAt: number; // unix ms — new match's end time
}

// Structural mirror of server/schema/MatchState.ts's WeaponBox fields.
export interface BoxState {
  id: string;
  x: number;
  y: number;
  z: number;
  active: boolean;
}

export interface NetCallbacks {
  onPlayerAdd: (sessionId: string, player: RemotePlayerState) => void;
  onPlayerRemove: (sessionId: string) => void;
  // Fired whenever any tracked field on a remote player's schema changes —
  // used to push a fresh snapshot into that kart's interpolation buffer.
  onPlayerChange: (sessionId: string, player: RemotePlayerState) => void;
  // Combat events — see server/rooms/MatchRoom.ts for the authoritative side.
  onRocketSpawn?: (msg: RocketSpawnMsg) => void;
  onRocketExplode?: (msg: RocketExplodeMsg) => void;
  onKill?: (msg: KillMsg) => void;
  // Targeted at this client only (teleport-on-respawn) — see MatchRoom.ts
  // respawnPlayer() for why this can't ride the normal schema pose channel.
  onRespawn?: (msg: RespawnMsg) => void;
  // Match flow — see MatchRoom.ts endMatch()/restartMatch().
  onMatchEnd?: (msg: MatchEndMsg) => void;
  onMatchRestart?: (msg: MatchRestartMsg) => void;
}

// 30Hz: fixed, regular cadence matters more than saving a few bytes here —
// see startSending() for why we deliberately do NOT skip unchanged poses
// anymore (that "optimization" created irregular arrival gaps that fed
// straight into the interpolation buffer as visible judder on remote
// clients — see network-programmer session notes, 2026-07-07).
const SEND_INTERVAL_MS = 1000 / 30;
const DEFAULT_PORT = 8091;

export class NetClient {
  private room: Room<any, any> | null = null;
  private sendTimer: ReturnType<typeof setInterval> | null = null;

  get connected(): boolean {
    return this.room !== null;
  }

  get sessionId(): string | null {
    return this.room?.sessionId ?? null;
  }

  get playerCount(): number {
    return this.room ? this.room.state.players.size : 0;
  }

  // Polled (not push-based) by the combat HUD each frame — simpler than
  // wiring a dedicated onChange callback for "myself" when onAdd/onChange
  // already deliberately skip the local sessionId (see connect()).
  getSelf(): RemotePlayerState | null {
    if (!this.room) return null;
    return (this.room.state.players.get(this.room.sessionId) as unknown as RemotePlayerState) ?? null;
  }

  // Fire-and-forget: server validates alive+armed and silently no-ops
  // otherwise (see MatchRoom.handleFire) — the client doesn't need a
  // request/response round trip, it just renders whatever "rocket:spawn"
  // messages come back.
  sendFire(): void {
    this.room?.send("fire");
  }

  // Read directly off the schema (server/schema/MatchState.ts) rather than a
  // dedicated message — these two fields change rarely (once per match) and
  // are polled once per rendered frame by the HUD countdown, same cadence
  // and pattern as getBoxes() below.
  getMatchEndsAt(): number {
    return this.room ? (this.room.state as { matchEndsAt: number }).matchEndsAt : 0;
  }
  getMatchPhase(): string {
    return this.room ? (this.room.state as { phase: string }).phase : "playing";
  }

  // Weapon boxes are few (6-8) and change rarely — polling the whole list
  // once per rendered frame is simpler than wiring per-box onAdd/onChange
  // callbacks like RemoteKartManager does for the (much larger, much more
  // frequently updated) player list.
  getBoxes(): BoxState[] {
    if (!this.room) return [];
    const out: BoxState[] = [];
    const boxes = this.room.state.boxes as Map<string, { x: number; y: number; z: number; active: boolean }>;
    for (const [id, box] of boxes.entries()) {
      out.push({ id, x: box.x, y: box.y, z: box.z, active: box.active });
    }
    return out;
  }

  // Resolves once connected+joined, or immediately (offline mode) if the
  // server can't be reached. Never rejects/throws past this point — a
  // network hiccup must never take down the local game.
  async connect(nick: string, callbacks: NetCallbacks, code?: string): Promise<boolean> {
    try {
      const client = new Client(`http://${location.hostname}:${DEFAULT_PORT}`);
      // `code` partitions rooms server-side (filterBy in server/index.ts) —
      // same code from the lobby invite link → same room.
      const room = await client.joinOrCreate("match", { nick, kartType: "racer", ...(code ? { code } : {}) });
      this.room = room;

      const cb = Callbacks.get(room);
      // `room` is loosely typed (Room<any, any>, see the file header for why)
      // so the collection callbacks come back as `unknown` — cast at the
      // boundary to the hand-maintained RemotePlayerState shape.
      cb.onAdd("players", (player: unknown, sessionId: unknown) => {
        const p = player as RemotePlayerState;
        const id = sessionId as string;
        if (id === room.sessionId) return; // don't render our own kart twice
        callbacks.onPlayerAdd(id, p);
        cb.onChange(p as object, () => callbacks.onPlayerChange(id, p));
      });
      cb.onRemove("players", (_player: unknown, sessionId: unknown) => {
        const id = sessionId as string;
        if (id === room.sessionId) return;
        callbacks.onPlayerRemove(id);
      });

      if (callbacks.onRocketSpawn) room.onMessage("rocket:spawn", callbacks.onRocketSpawn);
      if (callbacks.onRocketExplode) room.onMessage("rocket:explode", callbacks.onRocketExplode);
      if (callbacks.onKill) room.onMessage("kill", callbacks.onKill);
      if (callbacks.onRespawn) room.onMessage("respawn", callbacks.onRespawn);
      if (callbacks.onMatchEnd) room.onMessage("match:end", callbacks.onMatchEnd);
      if (callbacks.onMatchRestart) room.onMessage("match:restart", callbacks.onMatchRestart);

      room.onLeave(() => {
        console.warn("[net] disconnected from match server");
        this.room = null;
        this.stopSending();
      });

      return true;
    } catch (e) {
      console.warn("[net] offline mode (match server unreachable)", e);
      this.room = null;
      return false;
    }
  }

  // Starts throttled position reporting. `getLocalState` is polled on a
  // timer (not per-physics-substep) so network send rate is decoupled from
  // the 120Hz physics tick.
  //
  // Deliberately ALWAYS sends, even when parked at spawn / pose unchanged.
  // An earlier version skipped redundant sends as a bandwidth optimization,
  // but that made send timing irregular from the receiver's point of view
  // (a "no changes, skip" gap looks identical to a dropped/delayed packet).
  // Those irregular gaps fed straight into SnapshotBuffer as noisy
  // timestamps, which read as remote karts stutter-stepping even when their
  // actual motion was smooth. Regular cadence is worth more than the tiny
  // bandwidth saved by skipping idle frames.
  startSending(getLocalState: () => RemotePose): void {
    this.stopSending();
    this.sendTimer = setInterval(() => {
      if (!this.room) return;
      this.room.send("state", getLocalState());
    }, SEND_INTERVAL_MS);
  }

  private stopSending(): void {
    if (this.sendTimer !== null) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
  }

  disconnect(): void {
    this.stopSending();
    this.room?.leave();
    this.room = null;
  }
}
