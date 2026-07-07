// Colyseus match server bootstrap. Fully separate process from the Vite dev
// server (:8090) and the Express master (:8080, see ../../server/) — this is
// the room/matchmaking backend for the three.js client's multiplayer skeleton.
// Run with `npm run server` (tsx, no build step) from web-slice/.
//
// GOTCHA: always launch this with `--tsconfig server/tsconfig.json`
// (baked into the `server` npm script). tsx auto-discovers the NEAREST
// tsconfig.json by walking up from cwd, which is web-slice/tsconfig.json —
// the CLIENT config, which has no `experimentalDecorators`. Without the
// explicit flag, `@type()` decorators in schema/MatchState.ts get compiled
// with stage-3 (native) decorator semantics instead of legacy ones and crash
// at runtime with "Cannot read properties of undefined (reading
// 'constructor')" deep inside @colyseus/schema's annotations.ts.
import { defineRoom, defineServer, listen, WebSocketTransport } from "colyseus";
import { MatchRoom } from "./rooms/MatchRoom";

const PORT = 8091; // 8080 = master Express, 8090 = Vite dev server — both taken

const gameServer = defineServer({
  transport: new WebSocketTransport(),
  rooms: {
    // filterBy("code"): clients joining with the same ?room= code from the
    // lobby land in the same room; clients with no code share default rooms.
    match: defineRoom(MatchRoom).filterBy(["code"]),
  },
});

listen(gameServer, PORT).then(() => {
  console.log(`[net] match server listening :${PORT}`);
});
