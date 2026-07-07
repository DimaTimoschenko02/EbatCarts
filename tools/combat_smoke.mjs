#!/usr/bin/env node
// Smoke test for the combat vertical slice (server/rooms/MatchRoom.ts +
// server/weapons/rocketSim.ts + server/spawn/spawnSelect.ts): weapon-box
// pickup, fire, AOE damage, death, and respawn. Same shape as
// tools/net_smoke.mjs (standalone Node script, no test framework — see that
// file's header for the "why relative-import the sdk" explanation, which
// applies here unchanged).
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webSliceDir = path.join(here, "..", "web-slice");
const sdkEntry = new URL("../web-slice/node_modules/@colyseus/sdk/build/index.mjs", import.meta.url);
const { Client } = await import(sdkEntry.href);

const PORT = 8091;
const SERVER_START_TIMEOUT_MS = 15_000;

function log(...args) {
  console.log("[combat_smoke]", ...args);
}

async function waitForServerReady(proc) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("server did not report ready within timeout")), SERVER_START_TIMEOUT_MS);
    proc.stdout.on("data", chunk => {
      const text = chunk.toString();
      process.stdout.write(`[server] ${text}`);
      if (text.includes("listening")) {
        clearTimeout(deadline);
        resolve();
      }
    });
    proc.stderr.on("data", chunk => process.stderr.write(`[server:err] ${chunk.toString()}`));
    proc.on("exit", code => {
      clearTimeout(deadline);
      reject(new Error(`server process exited early with code ${code}`));
    });
  });
}

// Polls `check()` every 100ms until it returns truthy, or throws after
// `timeoutMs`. Simulation-tick-driven server state (box pickup, rocket
// flight, damage) isn't instant from the client's perspective — schema
// patches arrive at the room's patch rate, not synchronously with our sends.
async function waitFor(check, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for: ${description}`);
}

async function main() {
  log(`spawning match server (cwd=${webSliceDir})...`);
  const server = spawn("npx", ["tsx", "--tsconfig", "server/tsconfig.json", "server/index.ts"], {
    cwd: webSliceDir,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let exitCode = 0;
  try {
    await waitForServerReady(server);
    await delay(300); // small settle margin after the listen() promise resolves

    const clientA = new Client(`http://localhost:${PORT}`);
    const clientB = new Client(`http://localhost:${PORT}`);
    const roomA = await clientA.joinOrCreate("match", { nick: "smoke-A" });
    const roomB = await clientB.joinOrCreate("match", { nick: "smoke-B" });
    log(`A joined as ${roomA.sessionId}, B joined as ${roomB.sessionId}, room=${roomA.roomId}`);

    if (roomA.roomId !== roomB.roomId) {
      throw new Error(`A and B ended up in different rooms (${roomA.roomId} vs ${roomB.roomId})`);
    }

    // Box "0" in server/config/arena.ts BOX_GRID is grid (2,11) -> world
    // (2 - 11.5, 11 - 11.5) = (-9.5, -0.5) per arena_slice.json's
    // origin_offset [-11.5, 0, -11.5]. Park A right on top of it, facing -Z
    // (yaw=0, per kart/kart.ts forwardOf convention), and park B a few
    // meters further along that same forward line so the rocket volley's
    // center ray (and the fan's edges, at this range) lands on it.
    const A_POS = { x: -9.45, y: 0, z: -0.5, yaw: 0 };
    const B_POS = { x: -9.45, y: 0, z: -3.5, yaw: 0 };

    roomA.send("state", A_POS);
    roomB.send("state", B_POS);
    await delay(500); // let the poses land and give tickBoxes a few sim ticks

    await waitFor(
      () => roomA.state.players.get(roomA.sessionId)?.weapon === "rocket",
      "A picks up the rocket from box 0",
      3000
    );
    log("PASS: A picked up the rocket weapon box");

    const initialHp = roomA.state.players.get(roomB.sessionId).hp;
    if (initialHp !== 100) throw new Error(`expected B to start at 100 hp, got ${initialHp}`);

    roomA.send("fire");
    await waitFor(
      () => {
        const b = roomA.state.players.get(roomB.sessionId);
        return b.hp < initialHp || !b.alive;
      },
      "B's hp drops after A's first volley",
      3000
    );
    log(`PASS: B took damage (hp now ${roomA.state.players.get(roomB.sessionId).hp}, alive=${roomA.state.players.get(roomB.sessionId).alive})`);

    // Finish B off if the first volley wasn't lethal — re-arm (box respawns
    // after 10s, server/rooms/MatchRoom.ts BOX_RESPAWN_MS) and fire again,
    // bounded so a genuine regression fails fast instead of hanging.
    let volleys = 1;
    const MAX_VOLLEYS = 5;
    while (roomA.state.players.get(roomB.sessionId).alive && volleys < MAX_VOLLEYS) {
      await waitFor(
        () => roomA.state.players.get(roomA.sessionId)?.weapon === "rocket",
        `A re-arms for volley ${volleys + 1}`,
        12_000
      );
      roomA.send("fire");
      volleys++;
      await delay(400); // let this volley's sim ticks + explosion resolve
    }
    if (roomA.state.players.get(roomB.sessionId).alive) {
      throw new Error(`B still alive after ${volleys} volleys`);
    }
    log(`PASS: B died after ${volleys} volley(s)`);

    const killerKills = roomA.state.players.get(roomA.sessionId).kills;
    const victimDeaths = roomA.state.players.get(roomB.sessionId).deaths;
    if (killerKills < 1) throw new Error(`expected A.kills >= 1, got ${killerKills}`);
    if (victimDeaths < 1) throw new Error(`expected B.deaths >= 1, got ${victimDeaths}`);
    log(`PASS: schema kills/deaths tallied (A.kills=${killerKills}, B.deaths=${victimDeaths})`);

    await waitFor(
      () => roomA.state.players.get(roomB.sessionId).alive === true,
      "B respawns (alive flips back to true)",
      6000
    );
    const respawned = roomA.state.players.get(roomB.sessionId);
    if (respawned.hp !== 100) throw new Error(`B respawned with hp=${respawned.hp}, expected 100`);
    const stillNearDeathSpot = Math.abs(respawned.x - B_POS.x) < 0.5 && Math.abs(respawned.z - B_POS.z) < 0.5;
    if (stillNearDeathSpot) {
      throw new Error(`B respawned suspiciously close to its death spot (${respawned.x}, ${respawned.z}) — expected a spawn-point teleport`);
    }
    log(`PASS: B respawned with full hp at (${respawned.x.toFixed(2)}, ${respawned.z.toFixed(2)})`);

    await roomA.leave();
    await roomB.leave();
  } catch (e) {
    console.error("[combat_smoke] FAIL:", e);
    exitCode = 1;
  } finally {
    server.kill();
  }
  process.exit(exitCode);
}

main();
