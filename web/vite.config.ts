import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Reachable from other tailnet devices (e.g. phone via `tailscale serve`).
    host: true,
    allowedHosts: [".ts.net"],
    // Same-origin WS so the page works from any host, incl. HTTPS (wss).
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
    },
  },
});
