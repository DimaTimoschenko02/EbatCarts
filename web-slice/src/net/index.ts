// Single entry point for the multiplayer skeleton — main.ts makes exactly
// one call to initNet() and never touches net/ internals again. Everything
// else (connecting, throttled sending, remote kart interpolation, its own
// per-frame update loop) lives in this module tree.
import * as THREE from "three";
import { NetClient, type RemotePose } from "./netClient";
import { RemoteKartManager } from "./remoteKarts";

export interface InitNetOptions {
  scene: THREE.Scene;
  // Polled at the send rate (not per physics substep) to get this client's
  // own kart pose to report — see NetClient.startSending.
  getLocalState: () => RemotePose;
  nick?: string;
}

// Fire-and-forget: connects in the background, wires remote-kart rendering,
// and runs its own rAF loop for interpolation so main.ts's render loop never
// needs to know net/ exists beyond this one call. Returns the NetClient in
// case the caller wants to disconnect() on teardown (not used yet — no
// scene teardown exists today).
export function initNet(opts: InitNetOptions): NetClient {
  const client = new NetClient();
  const remotes = new RemoteKartManager(opts.scene);
  window.__net = { connected: false, players: 0 };

  const nick = opts.nick ?? `guest-${Math.floor(Math.random() * 10000)}`;
  client
    .connect(nick, {
      onPlayerAdd: (id, player) => remotes.add(id, player),
      onPlayerRemove: id => remotes.remove(id),
      onPlayerChange: (id, player) => remotes.onSnapshot(id, player),
    })
    .then(connected => {
      window.__net.connected = connected;
      if (connected) client.startSending(opts.getLocalState);
    });

  function frame(): void {
    requestAnimationFrame(frame);
    remotes.update();
    window.__net.players = remotes.count;
  }
  requestAnimationFrame(frame);

  return client;
}
