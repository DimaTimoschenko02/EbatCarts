#!/usr/bin/env node
// Smoke test for match flow (server/rooms/MatchRoom.ts endMatch()/
// restartMatch(), server/schema/MatchState.ts matchEndsAt/phase): spins up a
// throwaway match server with a 3s match duration (MATCH_DURATION_MS env
// override, see MatchRoom.ts), connects two clients, waits for "match:end",
// asserts phase + scoreboard, waits for "match:restart", asserts kills/deaths
// reset to 0. Same shape as tools/combat_smoke.mjs / tools/net_smoke.mjs
// (standalone Node script, no test framework, relative-import the sdk for
// the same reason documented in net_smoke.mjs's file header).
//
// Runs on its own PORT (env override added to web-slice/server/index.ts)
// rather than the default 8091 — a real dev server was found LISTENING there
// with live ESTABLISHED client connections when this was written
// (2026-07-07), and killing that would yank someone's actual playtest out
// from under them. Using a disposable port sidesteps the whole "is it safe
// to kill" question entirely.
//
// WINDOWS GOTCHA: `spawn(..., { shell: true })` on Windows makes `child.pid`
// the PID of the cmd.exe shell wrapper, not the node.exe process actually
// listening on the port — `child.kill()` only kills that shell and leaves
// node.exe running as an orphan (port stays bound). `taskkill /T` (kill the
// whole process TREE rooted at that PID) is what actually reaps node.exe
// too; a bare `child.kill()` here would silently leak a listening process on
// every run of this script.
import { spawn, execSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webSliceDir = path.join(here, "..", "web-slice");
const sdkEntry = new URL("../web-slice/node_modules/@colyseus/sdk/build/index.mjs", import.meta.url);
const { Client } = await import(sdkEntry.href);

const PORT = 8095; // disposable, distinct from the real dev server's 8091 — see file header
const MATCH_DURATION_MS = 3000;
const RESTART_DELAY_MS = 15_000; // must match MatchRoom.ts MATCH_RESTART_DELAY_MS
const SERVER_START_TIMEOUT_MS = 15_000;

function log(...args) {
  console.log("[match_flow_smoke]", ...args);
}

function assertPortFree(port) {
  let out = "";
  try {
    out = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8" });
  } catch {
    return; // findstr exits 1 (no match) when the port is free — that's the happy path
  }
  // Only a LISTENING socket means something is actually bound to the port —
  // TIME_WAIT/CLOSE_WAIT entries are just the OS cleaning up connections
  // from a PREVIOUS run of this exact script (colyseus/ws teardown lingers a
  // few seconds on Windows) and don't block a new bind() on the same port.
  const listening = out.split("\n").some(line => /LISTENING/i.test(line));
  if (listening) {
    throw new Error(`port ${port} is already LISTENING (something else is using it), refusing to start a second server on it:\n${out}`);
  }
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

async function waitFor(check, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for: ${description}`);
}

// See file header WINDOWS GOTCHA — kills the whole process tree, not just
// the shell wrapper `spawn(shell:true)` hands back as `proc.pid`.
function killTree(pid) {
  try {
    execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
  } catch (e) {
    console.warn(`[match_flow_smoke] taskkill failed for pid ${pid} (may already be dead):`, e.message);
  }
}

async function main() {
  assertPortFree(PORT);

  log(`spawning match server on :${PORT} (MATCH_DURATION_MS=${MATCH_DURATION_MS}, cwd=${webSliceDir})...`);
  const server = spawn("npx", ["tsx", "--tsconfig", "server/tsconfig.json", "server/index.ts"], {
    cwd: webSliceDir,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), MATCH_DURATION_MS: String(MATCH_DURATION_MS) },
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
    if (roomA.state.phase !== "playing") {
      throw new Error(`expected phase="playing" right after join, got "${roomA.state.phase}"`);
    }
    if (!(roomA.state.matchEndsAt > Date.now())) {
      throw new Error(`expected matchEndsAt in the future, got ${roomA.state.matchEndsAt} (now=${Date.now()})`);
    }
    log(`PASS: initial phase="playing", matchEndsAt=${roomA.state.matchEndsAt}`);

    // Give A a kill so the "match:end" scoreboard snapshot has non-zero
    // numbers to assert on. Box "0" (server/config/arena.ts BOX_GRID) sits at
    // world (-9.5, -0.5) per arena_slice.json's origin_offset — same
    // coordinates tools/combat_smoke.mjs uses. Park A on it, B a few meters
    // down A's forward line, and fire.
    roomA.send("state", { x: -9.45, y: 0, z: -0.5, yaw: 0 });
    roomB.send("state", { x: -9.45, y: 0, z: -3.5, yaw: 0 });
    await waitFor(
      () => roomA.state.players.get(roomA.sessionId)?.weapon === "rocket",
      "A picks up the rocket box",
      3000
    );
    roomA.send("fire");
    await waitFor(
      () => (roomA.state.players.get(roomB.sessionId)?.hp ?? 100) < 100,
      "B takes damage from A's volley",
      3000
    );
    log("PASS: A scored at least some damage before match end (scoreboard will have non-zero numbers)");

    let matchEndMsg = null;
    roomA.onMessage("match:end", msg => { matchEndMsg = msg; });
    await waitFor(() => matchEndMsg !== null, "\"match:end\" broadcast arrives", MATCH_DURATION_MS + 5000);
    log(`PASS: match:end received, restartAt=${matchEndMsg.restartAt}, table=${JSON.stringify(matchEndMsg.table)}`);

    await waitFor(() => roomA.state.phase === "ended", "schema phase flips to \"ended\"", 2000);
    log("PASS: schema phase === \"ended\"");

    const rowA = matchEndMsg.table.find(r => r.id === roomA.sessionId);
    if (!rowA) throw new Error(`A's sessionId not found in match:end table: ${JSON.stringify(matchEndMsg.table)}`);
    if (rowA.kills < 1) throw new Error(`expected A.kills >= 1 in the scoreboard snapshot, got ${rowA.kills}`);
    log(`PASS: scoreboard snapshot includes A with kills=${rowA.kills}`);

    // Weapon was already consumed by the shot above (single-slot, no ammo
    // counter — see docs/p2-port-notes.md §1) and tickBoxes() is disabled
    // while phase="ended", so A can't re-arm during the freeze even though
    // it's still parked on the box; assert that directly.
    await delay(500);
    if (roomA.state.players.get(roomA.sessionId).weapon === "rocket") {
      throw new Error("A re-armed during the end-of-match freeze — tickBoxes() should be disabled while phase=\"ended\"");
    }
    log("PASS: no weapon-box pickups during the freeze");

    let restartMsg = null;
    roomA.onMessage("match:restart", msg => { restartMsg = msg; });
    await waitFor(() => restartMsg !== null, "\"match:restart\" broadcast arrives", RESTART_DELAY_MS + 5000);
    log(`PASS: match:restart received, matchEndsAt=${restartMsg.matchEndsAt}`);

    await waitFor(() => roomA.state.phase === "playing", "schema phase flips back to \"playing\"", 2000);
    const postRestartA = roomA.state.players.get(roomA.sessionId);
    const postRestartB = roomA.state.players.get(roomB.sessionId);
    if (postRestartA.kills !== 0 || postRestartB.deaths !== 0) {
      throw new Error(
        `expected kills/deaths reset after restart, got A.kills=${postRestartA.kills}, B.deaths=${postRestartB.deaths}`
      );
    }
    if (!postRestartA.alive || !postRestartB.alive) {
      throw new Error(`expected both players alive after restart, got A.alive=${postRestartA.alive}, B.alive=${postRestartB.alive}`);
    }
    if (!(restartMsg.matchEndsAt > Date.now())) {
      throw new Error(`expected the new matchEndsAt to be in the future, got ${restartMsg.matchEndsAt}`);
    }
    log("PASS: kills/deaths reset to 0, both players alive, new matchEndsAt is in the future");

    await roomA.leave();
    await roomB.leave();
  } catch (e) {
    console.error("[match_flow_smoke] FAIL:", e);
    exitCode = 1;
  } finally {
    killTree(server.pid);
    await delay(300); // let the OS actually release the port before we check
    try {
      assertPortFree(PORT);
      log(`confirmed :${PORT} is free after teardown`);
    } catch (e) {
      console.error("[match_flow_smoke] WARN: port still bound after teardown —", e.message);
    }
  }
  process.exit(exitCode);
}

main();
