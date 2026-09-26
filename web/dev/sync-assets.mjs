#!/usr/bin/env node
// Copy the version-matched MediaPipe vision WASM assets out of node_modules into
// web/public/wasm so the app loads them from our own origin (no runtime CDN).
// Runs from npm's postinstall hook, so `npm install` is enough to be runnable.
import { cp, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, '..')

const src = path.join(webRoot, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const dest = path.join(webRoot, 'public', 'wasm')

try {
  const files = await readdir(src)
  await mkdir(dest, { recursive: true })
  for (const f of files) await cp(path.join(src, f), path.join(dest, f))
  console.log(`[sync-assets] copied ${files.length} files → web/public/wasm`)
} catch (err) {
  console.warn(`[sync-assets] skipped: ${err.message}`)
  console.warn('[sync-assets] run `npm install` first, then `node dev/sync-assets.mjs`')
}
