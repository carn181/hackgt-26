import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// `npm run phone` (web/dev/phone-dev.mjs) sets TLS_CERT_FILE + TLS_KEY_FILE after
// making a certificate that covers this laptop's LAN address. Both or neither: a
// silent fallback to plain HTTP would look like it worked while the phone blocks
// the camera *and* the microphone, because getUserMedia needs a secure context.
const certFile = process.env.TLS_CERT_FILE;
const keyFile = process.env.TLS_KEY_FILE;
if (Boolean(certFile) !== Boolean(keyFile)) {
  throw new Error(
    "TLS_CERT_FILE and TLS_KEY_FILE must be set together (see web/dev/phone-dev.mjs)",
  );
}
const https =
  certFile && keyFile
    ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
    : undefined;

export default defineConfig({
  server: {
    // Reachable from other tailnet devices (e.g. phone via `tailscale serve`).
    host: true,
    allowedHosts: [".ts.net"],
    https,
    // Same-origin WS so the page works from any host, incl. HTTPS (wss).
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
    },
  },
});
