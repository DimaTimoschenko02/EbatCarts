import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
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
