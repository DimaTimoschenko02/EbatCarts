// Thin combat wiring — keeps main.ts to a single createCombat() call plus
// one update() call per frame. Owns: fire input -> network, rocket/explosion
// rendering, weapon-box rendering, HUD (hp/weapon/kills/deaths + respawn
// overlay + kill feed), and the local kart's visibility/teleport on
// death/respawn. See docs/p2-port-notes.md §1-3 for the design this ports
// and server/rooms/MatchRoom.ts for the authoritative side — this module
// never decides game rules, it only renders what the server says happened
// and forwards the local player's fire button press.
import * as THREE from "three";
import type { Kart } from "../kart/kart";
import type { InputController } from "../core/input";
import type { NetCallbacks, NetClient } from "../net/netClient";
import { RocketManager } from "./rockets";
import { BoxManager } from "./boxes";
import { CombatHud } from "./hud";

export type CombatNetCallbacks = Pick<NetCallbacks, "onRocketSpawn" | "onRocketExplode" | "onKill" | "onRespawn">;

export interface CombatHandle {
  // Passed into NetClient.connect() (via initNet's InitNetOptions) alongside
  // the movement-relay callbacks — see main.ts wiring.
  netCallbacks: CombatNetCallbacks;
  // Call once per rendered frame, after the kart/camera update for that frame.
  update(client: NetClient, input: InputController, dt: number): void;
}

export function createCombat(scene: THREE.Scene, kart: Kart): CombatHandle {
  const rockets = new RocketManager(scene);
  const boxes = new BoxManager(scene);
  const hud = CombatHud.mount();

  const netCallbacks: CombatNetCallbacks = {
    onRocketSpawn: msg => rockets.spawn(msg),
    onRocketExplode: msg => rockets.explode(msg),
    onKill: msg => hud.pushKillFeed(msg),
    // Movement is owner-authoritative (see net/netClient.ts) — the server
    // can't just patch our own schema pose to move us, it has to explicitly
    // tell THIS client to teleport its locally-simulated kart.
    onRespawn: msg => kart.teleport(msg.x, msg.z, msg.yaw),
  };

  return {
    netCallbacks,
    update(client, input, dt) {
      const self = client.getSelf();
      hud.updateStats(self);
      // Offline / not-yet-joined: self is null, always render the kart.
      kart.group.visible = self ? self.alive : true;

      // Edge-triggered regardless of alive state (so a press during death
      // doesn't queue up and fire immediately on respawn) — only actually
      // sent to the server while alive (or unknown/offline, where the
      // server-side guard is the real authority anyway).
      const wantsFire = input.consumeFire();
      if (wantsFire && (!self || self.alive)) client.sendFire();

      rockets.update();
      boxes.sync(client.getBoxes(), dt);
    },
  };
}
