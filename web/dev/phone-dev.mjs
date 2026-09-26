#!/usr/bin/env node
// One command for trying the HUD on a phone: make a certificate that covers this
// laptop's current LAN address, then run Vite over HTTPS on it.
//
//   npm run phone
//
// Why HTTPS: a phone camera needs a secure context, and a secure page cannot open
// a plain ws:// socket. Over HTTPS the app uses same-origin wss://<host>/ws, which
// Vite proxies to the backend — so nothing about the frozen contract changes.
//
// Certificates land in web/.certs/ (gitignored, never committed). mkcert is used
// when available (its CA can be trusted on the phone, which is what makes the
// camera work); otherwise a plain self-signed pair is generated and the phone will
// keep showing a certificate warning.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const certsDir = path.join(webRoot, '.certs')
const certPath = path.join(certsDir, 'cert.pem')
const keyPath = path.join(certsDir, 'key.pem')
const sansPath = path.join(certsDir, 'sans.txt')

const PORT = process.env.PORT ?? '5173'
const HOSTNAMES = ['localhost', '127.0.0.1']

function lanAddresses() {
  const addresses = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      addresses.push(entry.address)
    }
  }
  // Prefer the usual private ranges so a VPN/docker bridge does not win.
  const privateFirst = (ip) => (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 0 : 1)
  return addresses.sort((a, b) => privateFirst(a) - privateFirst(b))
}

const exists = (cmd) => {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** `mkcert` directly, through nix, or nothing. */
function mkcertCommand() {
  if (exists('mkcert')) return ['mkcert']
  if (exists('nix')) return ['nix', 'shell', 'nixpkgs#mkcert', '-c', 'mkcert']
  return null
}

function opensslCommand() {
  if (exists('openssl')) return ['openssl']
  if (exists('nix')) return ['nix', 'shell', 'nixpkgs#openssl', '-c', 'openssl']
  return null
}

const ips = lanAddresses()
if (!ips.length) {
  console.error('phone-dev: no non-internal IPv4 address found — connect the laptop to WiFi first.')
  process.exit(1)
}
const phoneIp = ips[0]
const wanted = [...HOSTNAMES, ...ips].join(' ')
const previous = existsSync(sansPath) ? readFileSync(sansPath, 'utf8').trim() : ''

mkdirSync(certsDir, { recursive: true })

if (existsSync(certPath) && existsSync(keyPath) && previous === wanted) {
  console.log(`phone-dev: reusing web/.certs (covers ${wanted})`)
} else {
  const mkcert = mkcertCommand()
  if (mkcert) {
    console.log('phone-dev: mkcert …')
    const [cmd, ...args] = mkcert
    try {
      execFileSync(cmd, [...args, '-cert-file', certPath, '-key-file', keyPath, ...HOSTNAMES, ...ips], {
        cwd: webRoot,
        stdio: 'inherit',
      })
    } catch {
      console.error('phone-dev: mkcert failed; see the output above.')
      process.exit(1)
    }
    let caPath = ''
    try {
      caPath = execFileSync(cmd, [...args, '-CAROOT'], { cwd: webRoot, encoding: 'utf8' }).trim()
    } catch {
      caPath = ''
    }
    console.log(`phone-dev: CA certificate to import on the phone: ${caPath}/rootCA.pem`)
    console.log('  android: Settings → Security → Encryption & credentials → Install a certificate → CA certificate')
    console.log('  ios:     open the .pem → Settings → General → VPN & Device Management → install,')
    console.log('           then Settings → General → About → Certificate Trust Settings → enable full trust')
    if (caPath) console.log(`  laptop:  mkcert -install   (so the laptop browser trusts it too)`)
  } else {
    const openssl = opensslCommand()
    if (!openssl) {
      console.error('phone-dev: neither mkcert nor openssl nor nix is available — install one of them.')
      process.exit(1)
    }
    console.log('phone-dev: mkcert unavailable, generating a self-signed pair (the phone will warn) …')
    const sans = [...HOSTNAMES.map((h) => `DNS:${h}`), ...ips.map((ip) => `IP:${ip}`)].join(',')
    const [cmd, ...args] = openssl
    try {
      execFileSync(
        cmd,
        [...args, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '30', '-subj', '/CN=sound-hud-dev', '-addext', `subjectAltName=${sans}`],
        { cwd: webRoot, stdio: 'inherit' },
      )
    } catch {
      console.error('phone-dev: openssl failed; see the output above.')
      process.exit(1)
    }
    console.log('phone-dev: self-signed cert. The phone must accept the warning, and some browsers then')
    console.log('          still refuse the camera. `nix shell nixpkgs#mkcert` + a trusted CA is the reliable path.')
  }
  writeFileSync(sansPath, `${wanted}\n`)
}

console.log(`\nphone-dev: open https://${phoneIp}:${PORT}/ on the phone (same WiFi as this laptop).`)
console.log('phone-dev: the HUD takes ws through this origin; keep `npm run mock` running for the event stream.\n')

// --strictPort: a busy port must fail loudly, never silently shift and make the
// URL printed above wrong for the phone.
const child = spawn('npm', ['run', 'dev', '--', '--host', '0.0.0.0', '--port', PORT, '--strictPort'], {
  cwd: webRoot,
  stdio: 'inherit',
  env: { ...process.env, TLS_CERT_FILE: certPath, TLS_KEY_FILE: keyPath },
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', (code) => process.exit(code ?? 0))
