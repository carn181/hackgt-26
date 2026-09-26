import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

// Local development is plain HTTP on localhost (a secure context as far as
// camera + getUserMedia are concerned). When both TLS_CERT_FILE and
// TLS_KEY_FILE are provided we serve HTTPS on the requested LAN host so a phone
// can load the same origin — and reach the backend through the same-origin /ws
// proxy, which avoids the mixed-content block on a plain ws:// URL.
//
// Setting only one of the pair is a configuration error, not a silent fallback.
const certFile = process.env.TLS_CERT_FILE
const keyFile = process.env.TLS_KEY_FILE

if ((certFile && !keyFile) || (!certFile && keyFile)) {
  throw new Error(
    'configuration error: TLS_CERT_FILE and TLS_KEY_FILE must be set together (or both unset for HTTP dev). ' +
      `Got TLS_CERT_FILE=${certFile ?? 'unset'} TLS_KEY_FILE=${keyFile ?? 'unset'}.`,
  )
}

const webRoot = path.dirname(fileURLToPath(import.meta.url))
const WASM_DIR = path.join(webRoot, 'public', 'wasm')

/** Non-internal IPv4 addresses, so a phone knows where to point itself. */
function lanAddresses(): string[] {
  const addresses: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      addresses.push(entry.address)
    }
  }
  return addresses
}

/**
 * Print the URL the phone should open, and be explicit about what does and does
 * not work there. `getUserMedia` needs a secure context, so a plain http:// LAN
 * URL gives a HUD without camera/face tracking — say that out loud instead of
 * letting someone debug a silently blocked camera.
 */
function phoneUrlBanner(): Plugin {
  return {
    name: 'phone-url-banner',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const tls = Boolean(server.config.server.https)
        const protocol = tls ? 'https' : 'http'
        const address = server.httpServer?.address()
        const port = typeof address === 'object' && address ? address.port : (server.config.server.port ?? 5173)
        const lan = lanAddresses().map((ip) => `${protocol}://${ip}:${port}/`)
        const log = server.config.logger.info
        log(`\n  phone:  ${lan.length ? lan.join('  ') : '(no LAN address found — check your network)'}`)
        log(`  socket: ${tls ? 'wss' : 'ws'}://<that host>/ws  → proxied to ws://127.0.0.1:8000`)
        log(
          tls
            ? '  tls:    served from TLS_CERT_FILE/TLS_KEY_FILE — import that CA on the phone once, or the camera stays blocked'
            : '  camera: BLOCKED on a phone over http (needs a secure context). Run `npm run phone` for HTTPS.',
        )
      })
    },
  }
}

/**
 * Serve public/wasm/* verbatim.
 *
 * MediaPipe loads its Emscripten glue at runtime with a dynamically built URL, so
 * the request never goes through Vite's module pipeline — but Vite's import
 * analysis can still decorate it with an `?import` query, which the transform
 * middleware rejects for files inside `public/`. Serving the directory from this
 * middleware (installed ahead of Vite's own) keeps those assets raw and local:
 * no CDN at runtime.
 */
function mediapipeWasmPlugin(): Plugin {
  return {
    name: 'serve-mediapipe-wasm-raw',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith('/wasm/')) {
          next()
          return
        }
        // basename() also guards against path traversal.
        const file = path.join(WASM_DIR, path.basename(decodeURIComponent(url.split('?')[0])))
        if (!existsSync(file)) {
          next()
          return
        }
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        res.setHeader('Cache-Control', 'no-cache')
        createReadStream(file).pipe(res)
      })
    },
  }
}

export default defineConfig({
  plugins: [mediapipeWasmPlugin(), phoneUrlBanner()],
  server: {
    // With TLS configured the point is reaching the laptop from a phone, so
    // listen on the LAN; an explicit --host on the CLI still wins.
    host: certFile ? true : undefined,
    https: certFile && keyFile ? { cert: readFileSync(certFile), key: readFileSync(keyFile) } : undefined,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
      },
    },
  },
})
