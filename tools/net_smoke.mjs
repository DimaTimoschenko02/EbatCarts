#!/usr/bin/env node
// Smoke test for the Colyseus match server skeleton (web-slice/server/).
// Spawns the real server (`npx tsx server/index.ts`, cwd=web-slice), connects
// two @colyseus/sdk clients, has client A report a few positions, and asserts
// client B sees A's LAST reported position in room.state.players. No test
// framework — this is a standalone Node script per the project's
// "temporary/diagnostic scripts live in tools/, never src/" rule.
//
// NOTE on the import below: this file lives at <repo>/tools/, and
// @colyseus/sdk is only installed under <repo>/web-slice/node_modules/ (a
// sibling directory, not an ancestor) — Node's bare-specifier node_modules
// resolution would never find it from here. Importing the package's actual
// ESM entry file by relative path sidesteps that: Node loads that exact file,
// and everything IT imports (schema, shared-types, msgpackr, ...) resolves
// fine because those bare imports are resolved relative to THAT file's
// location, whose ancestry does include web-slice/node_modules.
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
  console.log("[net_smoke]", ...args);
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

async function main() {
  log(`spawning match server (cwd=${webSliceDir})...`);
  // --tsconfig is mandatory here — see the gotcha comment in
  // web-slice/server/index.ts (tsx would otherwise pick up the client
  // tsconfig.json and silently miscompile the schema decorators).
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

    const positions = [
      { x: 1, y: 0, z: 2, yaw: 0.1 },
      { x: 3, y: 0, z: 4.5, yaw: 0.2 },
      { x: 5.5, y: 0, z: 6.5, yaw: 0.31 },
    ];
    for (const pose of positions) {
      roomA.send("state", pose);
      await delay(150); // > SEND_INTERVAL_MS in netClient.ts / room patch rate
    }
    await delay(400); // let the last patch propagate to B

    if (roomB.state.players.size !== 2) {
      throw new Error(`expected 2 players in B's state, got ${roomB.state.players.size}`);
    }
    const seenA = roomB.state.players.get(roomA.sessionId);
    if (!seenA) throw new Error("B does not see A in state.players at all");

    const want = positions[positions.length - 1];
    const got = { x: seenA.x, y: seenA.y, z: seenA.z, yaw: seenA.yaw };
    const closeEnough = Math.abs(got.x - want.x) < 1e-6 && Math.abs(got.z - want.z) < 1e-6 && Math.abs(got.yaw - want.yaw) < 1e-6;
    if (!closeEnough) {
      throw new Error(`B sees a stale/wrong pose for A: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
    log(`PASS: B correctly sees A's last reported pose ${JSON.stringify(got)}`);

    await roomA.leave();
    await roomB.leave();
  } catch (e) {
    console.error("[net_smoke] FAIL:", e);
    exitCode = 1;
  } finally {
    server.kill();
  }
  process.exit(exitCode);
}

main();
