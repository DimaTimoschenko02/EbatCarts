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
});
