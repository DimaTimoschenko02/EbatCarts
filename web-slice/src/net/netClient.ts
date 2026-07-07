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
}

export interface NetCallbacks {
  onPlayerAdd: (sessionId: string, player: RemotePlayerState) => void;
  onPlayerRemove: (sessionId: string) => void;
  // Fired whenever any tracked field on a remote player's schema changes —
  // used to push a fresh snapshot into that kart's interpolation buffer.
  onPlayerChange: (sessionId: string, player: RemotePlayerState) => void;
}

const SEND_INTERVAL_MS = 50; // ~20Hz, matches the room's default patch rate
const DEFAULT_PORT = 8091;

export class NetClient {
  private room: Room<any, any> | null = null;
  private sendTimer: ReturnType<typeof setInterval> | null = null;
  private lastSent: RemotePose | null = null;

  get connected(): boolean {
    return this.room !== null;
  }

  get sessionId(): string | null {
    return this.room?.sessionId ?? null;
  }

  get playerCount(): number {
    return this.room ? this.room.state.players.size : 0;
  }

  // Resolves once connected+joined, or immediately (offline mode) if the
  // server can't be reached. Never rejects/throws past this point — a
  // network hiccup must never take down the local game.
  async connect(nick: string, callbacks: NetCallbacks): Promise<boolean> {
    try {
      const client = new Client(`http://${location.hostname}:${DEFAULT_PORT}`);
      const room = await client.joinOrCreate("match", { nick, kartType: "racer" });
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
  startSending(getLocalState: () => RemotePose): void {
    this.stopSending();
    this.sendTimer = setInterval(() => {
      if (!this.room) return;
      const pose = getLocalState();
      // Skip redundant sends of an unchanged pose (e.g. parked at spawn) —
      // cheap bandwidth win, doesn't change interpolation on the far end
      // since the receiver just holds the last snapshot (see snapshotBuffer).
      if (this.lastSent && poseEquals(this.lastSent, pose)) return;
      this.lastSent = pose;
      this.room.send("state", pose);
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

function poseEquals(a: RemotePose, b: RemotePose): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.yaw === b.yaw;
}
