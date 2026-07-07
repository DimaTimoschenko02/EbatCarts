// Single entry point for the multiplayer skeleton — main.ts makes exactly
// one call to initNet() and never touches net/ internals again. Everything
// else (connecting, throttled sending, remote kart interpolation, its own
// per-frame update loop) lives in this module tree.
import * as THREE from "three";
import { NetClient, type NetCallbacks, type RemotePose } from "./netClient";
import { RemoteKartManager } from "./remoteKarts";
import type { KartObstacle } from "../physics/kartCollision";

// Returned by initNet() — bundles the NetClient (combat wiring, getSelf/
// getBoxes/sendFire, see main.ts + combat/index.ts) with a way to read the
// currently-rendered remote kart positions for LOCAL kart-vs-kart collision
// (physics/kartCollision.ts). Kept as a plain object rather than growing
// NetClient itself: RemoteKartManager is a rendering concern net/index.ts
// owns, NetClient doesn't need to know it exists.
export interface NetHandle {
  client: NetClient;
  getObstacles: () => KartObstacle[];
}

export interface InitNetOptions {
  scene: THREE.Scene;
  // Polled at the send rate (not per physics substep) to get this client's
  // own kart pose to report — see NetClient.startSending.
  getLocalState: () => RemotePose;
  nick?: string;
  // Combat wiring (src/combat/index.ts createCombat().netCallbacks) — passed
  // straight through to NetClient.connect() alongside the movement-relay
  // callbacks above. Optional so net/ still works standalone (e.g. tests)
  // without a combat module attached.
  combat?: Pick<NetCallbacks, "onRocketSpawn" | "onRocketExplode" | "onKill" | "onRespawn" | "onMatchEnd" | "onMatchRestart">;
}

// Fire-and-forget: connects in the background, wires remote-kart rendering,
// and runs its own rAF loop for interpolation so main.ts's render loop never
// needs to know net/ exists beyond this one call. Returns the NetClient in
// case the caller wants to disconnect() on teardown (not used yet — no
// scene teardown exists today).
export function initNet(opts: InitNetOptions): NetHandle {
  const client = new NetClient();
  const remotes = new RemoteKartManager(opts.scene);
  window.__net = { connected: false, players: 0, delayMs: 0, jitterMs: 0, underruns: 0 };

  // Lobby hand-off contract (src/lobby/main.ts): nick in
  // localStorage["sk-nick"], room code in the ?room= query param.
  const nick = opts.nick
    ?? localStorage.getItem("sk-nick")
    ?? `guest-${Math.floor(Math.random() * 10000)}`;
  const roomCode = new URLSearchParams(location.search).get("room") ?? undefined;
  client
    .connect(nick, {
      onPlayerAdd: (id, player) => remotes.add(id, player),
      onPlayerRemove: id => remotes.remove(id),
      onPlayerChange: (id, player) => remotes.onSnapshot(id, player),
      ...opts.combat,
    }, roomCode)
    .then(connected => {
      window.__net.connected = connected;
      if (connected) client.startSending(opts.getLocalState);
    });

  function frame(): void {
    requestAnimationFrame(frame);
    remotes.update();
    window.__net.players = remotes.count;
    const stats = remotes.getNetStats();
    window.__net.delayMs = Math.round(stats.delayMs);
    window.__net.jitterMs = Math.round(stats.jitterMs);
    window.__net.underruns = stats.underruns;
  }
  requestAnimationFrame(frame);

  return { client, getObstacles: () => remotes.getObstacles() };
}
