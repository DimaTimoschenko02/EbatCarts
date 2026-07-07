// Owner-authoritative position relay: each client simulates its own kart
// locally (existing bicycle physics in src/physics/, untouched) and reports
// its pose here at ~20Hz. The server does not simulate movement — it only
// holds the last reported pose per player and validates it before writing to
// state, so a compromised/buggy client can't push NaN/huge coordinates into
// the shared state that every other client renders.
import { Client, Room } from "colyseus";
import { MatchState, Player } from "../schema/MatchState";

// Same spawn as the offline single-player kart (src/main.ts SPAWN) — just
// inside the ring road, facing -Z. TODO: read spawn points from the map JSON
// (public/maps/*.json) once the match room knows which map is active; for
// now every player spawns at the same point (multi-spawn deferred).
const SPAWN = { x: 0, y: 0, z: 6.5, yaw: 0 };

const MAX_COORD = 1000; // sanity bound — well outside any real arena extent

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

export class MatchRoom extends Room<{ state: MatchState }> {
  maxClients = 8;

  onCreate(): void {
    this.setState(new MatchState());

    this.onMessage("state", (client, data: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return; // message arrived after leave/before join settled
      const validated = validateStateMessage(data, client.sessionId);
      if (!validated) return;
      player.x = validated.x;
      player.y = validated.y;
      player.z = validated.z;
      player.yaw = validated.yaw;
    });
  }

  onJoin(client: Client, options?: { nick?: string; kartType?: string }): void {
    const player = new Player();
    player.x = SPAWN.x;
    player.y = SPAWN.y;
    player.z = SPAWN.z;
    player.yaw = SPAWN.yaw;
    player.nick = options?.nick?.slice(0, 24) || "guest";
    player.kartType = options?.kartType === "racer" ? "racer" : "racer"; // only one kart type exists today
    player.hp = 100;
    this.state.players.set(client.sessionId, player);
    console.log(`[match] ${client.sessionId} joined as "${player.nick}" (${this.state.players.size}/${this.maxClients})`);
  }

  onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
    console.log(`[match] ${client.sessionId} left (${this.state.players.size}/${this.maxClients})`);
  }
}
