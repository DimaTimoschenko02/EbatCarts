import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Dev-only persistence for src/debug/paramPanel.ts. `apply: "serve"` +
// configureServer means this route only exists under `vite dev` — a prod
// `vite build` never registers middleware, so there is no server to hit
// `/__dev-params` against (fetch fails, panel falls back to localStorage).
// Writes go through a .tmp + rename so a crash/kill mid-write can't leave a
// half-written JSON file (rename is atomic on the same filesystem).
function devParamsFilePlugin(): Plugin {
  const filePath = resolve(__dirname, "dev-params.local.json");
  return {
    name: "dev-params-file",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev-params", (req, res) => {
        if (req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          try {
            res.end(readFileSync(filePath, "utf-8"));
          } catch {
            res.end("{}"); // no file yet — first run, or user deleted it
          }
          return;
        }
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString("utf-8"); });
          req.on("end", () => {
            try {
              const parsed: unknown = JSON.parse(body);
              const tmpPath = `${filePath}.tmp`;
              writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), "utf-8");
              renameSync(tmpPath, filePath);
              res.statusCode = 204;
              res.end();
            } catch (err) {
              res.statusCode = 400;
              res.end(String(err));
            }
          });
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

export default defineConfig({
  plugins: [devParamsFilePlugin()],
  server: {
    // Keep the already-documented LAN address (http://192.168.0.101:8090)
    // working for the two-laptop agent testing topology (see
    // memory: project_p0_testability_done.md gotcha — LAN IP not localhost).
    port: 8090,
    host: true,
    strictPort: true,
  },
  build: {
    // Three standalone HTML entries share one Vite project: the game
    // (index.html), the map editor (editor.html), and the lobby
    // (lobby.html). Without this, `npm run build` only bundled index.html
    // and silently dropped the other two pages from prod output.
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        editor: resolve(__dirname, "editor.html"),
        lobby: resolve(__dirname, "lobby.html"),
      },
    },
  },
});
