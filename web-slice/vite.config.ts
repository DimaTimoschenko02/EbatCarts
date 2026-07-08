import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

// Dev-only save/load bridge for src/editor/main.ts. The editor's Export/Import
// buttons round-trip through the browser's local filesystem (file download /
// <input type=file>), which is useless when the editor is opened from a
// laptop other than the one the repo lives on (see the two-laptop LAN
// topology, memory: project_p0_testability_done.md). This plugin lets the
// editor read/write public/maps/*.json directly on the machine running
// `vite dev`, so "Save to server" + "Load" close the loop over LAN.
// GET  /__editor-maps          -> {"maps": ["arena_slice", ...]}  (names, no .json)
// POST /__editor-maps {name, data} -> writes public/maps/<name>.json
//   - name is restricted to [a-z0-9_-]+ to keep this within the maps folder
//   - overwriting an existing file first copies it to public/maps/.backup/
//     <name>.<timestamp>.json so a bad overwrite is always recoverable
function editorMapsFilePlugin(): Plugin {
  const mapsDir = resolve(__dirname, "public/maps");
  const backupDir = resolve(mapsDir, ".backup");
  const nameRe = /^[a-z0-9_-]+$/;

  function readMapNames(): string[] {
    try {
      return readdirSync(mapsDir)
        .filter(f => f.endsWith(".json"))
        .map(f => f.slice(0, -".json".length));
    } catch {
      return [];
    }
  }

  return {
    name: "editor-maps-file",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__editor-maps", (req, res) => {
        if (req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ maps: readMapNames() }));
          return;
        }
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString("utf-8"); });
          req.on("end", () => {
            try {
              const parsed = JSON.parse(body) as { name?: unknown; data?: unknown };
              const name = parsed.name;
              if (typeof name !== "string" || !nameRe.test(name)) {
                res.statusCode = 400;
                res.end("invalid map name — use [a-z0-9_-]+ only");
                return;
              }
              const targetPath = resolve(mapsDir, `${name}.json`);
              if (existsSync(targetPath)) {
                if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
                const stamp = new Date().toISOString().replace(/[:.]/g, "-");
                renameSync(targetPath, resolve(backupDir, `${name}.${stamp}.json`));
              } else if (!existsSync(mapsDir)) {
                mkdirSync(mapsDir, { recursive: true });
              }
              writeFileSync(targetPath, JSON.stringify(parsed.data, null, 2), "utf-8");
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
  plugins: [devParamsFilePlugin(), editorMapsFilePlugin()],
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
