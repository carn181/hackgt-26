#!/usr/bin/env node
// Local mock of the frozen backend WS contract (README §4.5 / §4.6).
//
// Purpose: unblock the HUD before the real backend exists. It replays the four
// prompt demo beats (Clapping -40°, Speech +10° with transcript, a playback speech
// event with no matching mouth, urgent Alarm +120°), plus array_status, a
// backend_status heartbeat, presence, and timeline snapshots.
//
// This file only *speaks* the frozen contract. It never changes it.

import { WebSocketServer } from 'ws'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

const HOST = '127.0.0.1'
const PORT = 8000
const WS_PATH = '/ws'

// ---------------------------------------------------------------------------
// Geometry: single source of truth is config/array.json (never duplicated here).
// ---------------------------------------------------------------------------
const array = JSON.parse(await readFile(path.join(repoRoot, 'config', 'array.json'), 'utf8'))

let calib = {}
try {
  calib = JSON.parse(await readFile(path.join(repoRoot, 'config', 'calib.json'), 'utf8'))
} catch {
  // config/calib.json is owned by member D; absence is not an error here.
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

const calibration = {
  baseline_m: num(array.baseline_m) ?? 0,
  spacing_m: num(array.spacing_m) ?? 0,
  // Measured head yaw wins when D has filled it in; array.json is the fallback.
  head_yaw_offset_deg: num(calib.head_yaw_offset_deg) ?? num(array.head_yaw_offset_deg) ?? 0,
  camera_fov_deg: num(calib.camera_fov_deg) ?? num(array.camera_fov_deg) ?? 62,
}
// Only report an audio delay that was actually measured (README §7.2.5, owner D).
const audioDelay = num(calib.audio_delay_ms)
if (audioDelay !== undefined) calibration.audio_delay_ms = audioDelay

// ---------------------------------------------------------------------------
// Mock-only provenance. Every fabricated value is visibly marked MOCK so a HUD
// reader can never mistake this stream for a measured backend.
// ---------------------------------------------------------------------------
const MOCK_REV = 'MOCK'
const MOCK_SHA = 'MOCK-' + '0'.repeat(64)

const MICS = [
  { id: 0, ok: true },
  { id: 1, ok: true },
  { id: 2, ok: false }, // one dead mic, so mic-health rendering is exercised
  { id: 3, ok: true },
]

const t0 = Date.now()
const nowT = () => Number(((Date.now() - t0) / 1000).toFixed(3))

const log = (...args) => console.log(`[mock-ws t=${nowT().toFixed(1)}s]`, ...args)

// ---------------------------------------------------------------------------
// Demo script
// ---------------------------------------------------------------------------
const BEAT_GAP_S = 2.0 // beats are evenly spaced 2 s apart (plan step 1)
const RAMP_STEP_MS = 250
const RAMP_FROM_DEG = -10
const RAMP_TO_DEG = 10
const RAMP_STEPS = 9
const CYCLE_S = 16 // long enough for the urgent event (6 s life) to expire in quiet air

function* script(cycle) {
  const id = (name) => `c${cycle}-${name}`

  // ---- urgency-tier furniture (C7): two low events so captions coalesce into a
  //      `+N low` chip, one high event so `important`/`quiet` filtering is visible.
  yield { at: 0.4, msg: { type: 'sound_event', id: id('low1'), class: 'Footsteps', confidence: 0.55, bearing_deg: -62, elevation_deg: null, accuracy_deg: 20, ambiguous: false, urgency: 'low', source: 'array' } }
  yield { at: 0.6, msg: { type: 'sound_event', id: id('low2'), class: 'Rustling leaves', confidence: 0.48, bearing_deg: 71, elevation_deg: null, accuracy_deg: 22, ambiguous: false, urgency: 'low', source: 'array' } }
  yield { at: 0.8, msg: { type: 'sound_event', id: id('high'), class: 'Glass breaking', confidence: 0.72, bearing_deg: -15, elevation_deg: null, accuracy_deg: 16, ambiguous: false, urgency: 'high', source: 'array' } }

  // ---- beat 1: Clapping at -40°, ambiguous (linear array, front/back ambiguity)
  yield { at: 1.0, msg: { type: 'sound_event', id: id('clap'), class: 'Clapping', confidence: 0.9, bearing_deg: -40, elevation_deg: null, accuracy_deg: 12, ambiguous: true, urgency: 'normal', source: 'array' } }

  // ---- beat 2: Speech at +10° with a transcript (person beat: anchored to a face)
  yield { at: 3.0, msg: { type: 'sound_event', id: id('speech'), class: 'Speech', confidence: 0.91, bearing_deg: 10, elevation_deg: null, accuracy_deg: 10, ambiguous: false, urgency: 'normal', source: 'array' } }
  yield { at: 3.2, msg: { type: 'speech', id: id('s1'), parent_event: id('speech'), bearing_deg: 10, text: 'did you see', partial: true, confidence: 0.62, lang: 'en' } }
  yield { at: 3.8, msg: { type: 'speech', id: id('s1'), parent_event: id('speech'), bearing_deg: 10, text: 'did you see that', partial: false, confidence: 0.78, lang: 'en' } }

  // ---- beat 3: playback. Loudspeaker off to the left at -25°: no face sits at that
  //      bearing, so the HUD must free-float the bubble and label it playback.
  yield { at: 5.0, msg: { type: 'presence', human: true, source: 'pir' } }
  yield { at: 5.2, msg: { type: 'sound_event', id: id('playback'), class: 'Speech', confidence: 0.83, bearing_deg: -25, elevation_deg: null, accuracy_deg: 14, ambiguous: false, urgency: 'normal', source: 'array' } }
  yield { at: 5.4, msg: { type: 'speech', id: id('s2'), parent_event: id('playback'), bearing_deg: -25, text: 'welcome to the demo', partial: true, confidence: 0.7, lang: 'en' } }
  yield { at: 6.0, msg: { type: 'speech', id: id('s2'), parent_event: id('playback'), bearing_deg: -25, text: 'welcome to the demo, this is a recording', partial: false, confidence: 0.86, lang: 'en' } }

  // ---- timeline snapshot mid-flight: the client already holds these ids, so this
  //      exercises merge-by-id (no duplicate captions) and ordering by t.
  yield { at: 6.4, action: 'timeline' }

  // ---- moving target: same event id re-sent every 250 ms, walking -10° → +10° so
  //      C9 interpolation is visible without a separate replay feature. The final
  //      step is deliberately *not* sent live: it arrives only inside the next
  //      timeline snapshot, which is how a real backend heals a client that
  //      missed an update (in-place update of an existing id, never a duplicate).
  for (let i = 0; i < RAMP_STEPS - 1; i++) {
    const frac = i / (RAMP_STEPS - 1)
    const bearing = RAMP_FROM_DEG + (RAMP_TO_DEG - RAMP_FROM_DEG) * frac
    yield {
      at: 7.0 + (i * RAMP_STEP_MS) / 1000,
      msg: { type: 'sound_event', id: id('ramp'), class: 'Clapping', confidence: 0.76, bearing_deg: Number(bearing.toFixed(2)), elevation_deg: null, accuracy_deg: 8, ambiguous: false, urgency: 'normal', source: 'array' },
    }
  }

  yield {
    at: 9.1,
    action: 'timeline',
    refresh: { id: id('ramp'), class: 'Clapping', confidence: 0.79, bearing_deg: RAMP_TO_DEG, elevation_deg: null, accuracy_deg: 8, ambiguous: false, urgency: 'normal', source: 'array' },
  }

  // ---- beat 4: urgent Alarm at +120° — must displace every other caption/bubble.
  yield { at: 9.5, msg: { type: 'sound_event', id: id('alarm'), class: 'Alarm', confidence: 0.94, bearing_deg: 120, elevation_deg: null, accuracy_deg: 18, ambiguous: true, urgency: 'urgent', source: 'array' } }
  yield { at: 9.7, action: 'timeline' }
}

const connections = new Set()

const send = (ws, msg) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

const broadcast = (msg) => {
  for (const ws of connections) send(ws, msg)
}

function backendStatus() {
  return {
    type: 'backend_status',
    t: nowT(),
    model: 'yamnet',
    model_path: 'models/yamnet.tflite',
    model_sha256: MOCK_SHA, // MOCK: not a real model hash
    classes: 521,
    sample_rate: 16000,
    transport: 'udp',
    git_rev: MOCK_REV, // MOCK: not a real revision
  }
}

function arrayStatus() {
  return { type: 'array_status', t: nowT(), mics: MICS, calibration, transport: 'udp' }
}

/** Recent timeline snapshot: only events still inside the 6 s marker lifetime. */
function timelineSnapshot() {
  const cutoff = nowT() - 5
  const events = [...recent].filter((e) => e.t >= cutoff)
  return { type: 'timeline', t: nowT(), events }
}

// Newest-wins by id, mirroring the client's merge rule. The frozen timeline
// payload holds only sound_event / speech objects (README §4.5).
const recent = []
function remember(msg) {
  if (msg.type !== 'sound_event' && msg.type !== 'speech') return
  const i = recent.findIndex((e) => e.id === msg.id)
  if (i >= 0) recent[i] = msg
  else recent.push(msg)
  while (recent.length > 12) recent.shift()
}

function startClientScript(ws) {
  const timers = []
  const pending = []
  let cycle = 1
  let cycleBase = 0
  const push = (ms, fn) => timers.push(setTimeout(fn, ms))
  const appendCycle = () => {
    // `at` in the script is relative to the start of its cycle.
    for (const step of script(cycle)) pending.push({ ...step, at: step.at + cycleBase })
    cycleBase += CYCLE_S
    cycle += 1
  }
  appendCycle() // prime the first cycle; later cycles are appended as the queue drains

  // Drain the queue on a short tick so the script stays readable and the next
  // cycle can simply be appended to it.
  const base = Date.now()
  push(0, function tick() {
    const elapsed = (Date.now() - base) / 1000
    let guard = 0
    while (pending.length && pending[0].at <= elapsed && guard++ < 200) {
      handleStep(ws, pending.shift())
    }
    if (!pending.length) appendCycle()
    if (connections.has(ws)) push(60, tick)
  })

  // Heartbeats.
  push(200, () => {
    send(ws, backendStatus())
    send(ws, arrayStatus())
    log('sent backend_status + array_status (MOCK sha/rev)')
  })
  const heartbeat = setInterval(() => {
    send(ws, arrayStatus())
  }, 1000)
  const statusInterval = setInterval(() => send(ws, backendStatus()), 10000)
  timers.push(heartbeat, statusInterval)

  return () => {
    for (const t of timers) clearTimeout(t)
    clearInterval(heartbeat)
    clearInterval(statusInterval)
  }
}

function handleStep(ws, step) {
  if (step.action === 'timeline') {
    if (step.refresh) remember({ type: 'sound_event', ...step.refresh, t: nowT() })
    const snap = timelineSnapshot()
    send(ws, snap)
    log(`sent timeline snapshot (${snap.events.length} events: ${snap.events.map((e) => e.id).join(', ') || 'none'})`)
    return
  }
  // `t` is stamped at send time — the script is written ahead of time, so the
  // monotonic backend clock must be read when the message actually goes out.
  const msg = { ...step.msg, t: nowT() }
  remember(msg)
  send(ws, msg)
  const label = msg.type === 'sound_event' ? `${msg.class} ${msg.bearing_deg}° [${msg.urgency}]` : msg.type
  log(`sent ${label} id=${msg.id ?? '-'}`)
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ host: HOST, port: PORT, path: WS_PATH })

wss.on('listening', () => {
  log(`mock backend listening on ws://${HOST}:${PORT}${WS_PATH}`)
  log(
    `geometry from config/array.json: spacing=${calibration.spacing_m} m baseline=${calibration.baseline_m} m ` +
      `yaw=${calibration.head_yaw_offset_deg}° fov=${calibration.camera_fov_deg}°` +
      (audioDelay === undefined ? ' audio_delay=unmeasured' : ` audio_delay=${audioDelay} ms`),
  )
  log('beats: Clapping -40° → Speech +10° → playback Speech -25° → ramp -10…+10° → urgent Alarm +120°，cycle 16 s')
})

wss.on('connection', (ws, req) => {
  connections.add(ws)
  log(`client connected from ${req.socket.remoteAddress ?? '?'} (${connections.size} open)`)
  const stop = startClientScript(ws)

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      log(`ignored unparseable client message: ${String(raw).slice(0, 80)}`)
      return
    }
    if (msg?.type === 'set_mode') {
      log(`received set_mode: mode=${msg.mode}`)
      return
    }
    if (msg?.type === 'ping') {
      // Echo the exact payload back: this is what the prompt's latency
      // measurement path (performance.now() delta) reads.
      send(ws, msg)
      return
    }
    log(`ignored unknown client message type: ${msg?.type}`)
  })

  ws.on('close', () => {
    connections.delete(ws)
    stop()
    log(`client disconnected (${connections.size} open)`)
  })
  ws.on('error', (err) => log(`client socket error: ${err.message}`))
})
