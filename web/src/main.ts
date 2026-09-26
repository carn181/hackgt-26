import './style.css'
import { Hud } from './hud'
import { MicStream } from './mic'
import { VisionHost } from './vision'
import { WsClient, resolveWsUrl } from './ws'
import type { ConnState } from './ws'
import type { Mode, PresenceMsg } from './types'

const params = new URLSearchParams(location.search)

const video = document.querySelector<HTMLVideoElement>('#cam')!
const canvas = document.querySelector<HTMLCanvasElement>('#hud')!
const stage = document.querySelector<HTMLDivElement>('#stage')!
const diagToggle = document.querySelector<HTMLButtonElement>('#diag-toggle')!
const diagBody = document.querySelector<HTMLDivElement>('#diag-body')!
const diagSummary = document.querySelector<HTMLSpanElement>('#diag-summary')!
const connBadge = document.querySelector<HTMLDivElement>('#conn')!
const notice = document.querySelector<HTMLDivElement>('#notice')!
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('#modes button')]
const camButton = document.querySelector<HTMLButtonElement>('#cam-start')!
const cameraError = document.querySelector<HTMLDivElement>('#camera-error')!
const cameraErrorMessage = document.querySelector<HTMLParagraphElement>('#camera-error-message')!
const cameraRetry = document.querySelector<HTMLButtonElement>('#camera-retry')!
const controls = document.querySelector<HTMLDivElement>('#controls')!

const hud = new Hud(canvas, video, (message) => {
  lastDiagnostic = message
})
const vision = new VisionHost()
const { url: wsUrl, blockedReason } = resolveWsUrl(params.get('ws'))
const ws = new WsClient(wsUrl, blockedReason)

let mode: Mode = 'all'
let lastDiagnostic = ''
let cameraStream: MediaStream | null = null
let cameraStarted = false

// ---------------------------------------------------------------------------
// HUD wiring
// ---------------------------------------------------------------------------
ws.onMessage = (msg) => hud.ingest(msg)
let lastConnState: ConnState | null = null
ws.onStatus = (status) => {
  renderConnectionBadge(status.state, status.nextRetryMs, status.lastError)
  // Re-assert the selected mode on (re)connect so the backend and the HUD never
  // disagree about what is being suppressed — but only on the transition, not on
  // every status update (which fires for each received message).
  if (status.state === 'open' && lastConnState !== 'open') ws.setMode(mode)
  lastConnState = status.state
  hud.setBackendConnected(status.state === 'open')
}
vision.onStatus = (status) => {
  hud.setVision(status.state, vision.faces)
  // §4.6 `vision` (additive): the backend cannot open the webcam this page is
  // streaming, so the face boxes travel over the socket. ~10 frames/s, and only
  // while tracking is healthy — a stale or empty frame is simply not sent.
  if (status.state === 'ready') {
    ws.faces(
      vision.faces.map((f) => ({
        xc: f.box.x + f.box.w / 2,
        w: f.box.w,
        mouth: f.jawOpen,
        mouthActive: f.mouthActive,
      })),
    )
  }
  paintDiagnostics()
}

hud.setBottomInset(controls.getBoundingClientRect().height + 14)
hud.start()

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
const relayout = () => {
  hud.resize()
  hud.setBottomInset(controls.getBoundingClientRect().height + 14)
}
window.addEventListener('resize', relayout)
window.addEventListener('orientationchange', relayout)
new ResizeObserver(relayout).observe(stage)
new ResizeObserver(relayout).observe(controls)

// ---------------------------------------------------------------------------
// Mode controls (§4.6 set_mode)
// ---------------------------------------------------------------------------
function applyMode(next: Mode): void {
  mode = next
  hud.setMode(next)
  ws.setMode(next)
  for (const button of modeButtons) {
    const active = button.dataset.mode === next
    button.setAttribute('aria-pressed', String(active))
  }
  paintDiagnostics()
}
for (const button of modeButtons) {
  button.addEventListener('click', () => applyMode(button.dataset.mode as Mode))
}
// Start in `all` before any mode control arrives.
hud.setMode('all')

// ---------------------------------------------------------------------------
// Diagnostics: compact by default, tap-expandable for the full readout
// ---------------------------------------------------------------------------
let expanded = false
diagToggle.addEventListener('click', () => {
  expanded = !expanded
  diagToggle.setAttribute('aria-expanded', String(expanded))
  diagBody.hidden = !expanded
})
diagBody.hidden = true

function micSummary(): string {
  const mics = hud.array?.mics
  if (!mics?.length) return 'mics —'
  const ok = mics.filter((m) => m.ok).length
  return `mics ${ok}/${mics.length}${ok === mics.length ? '' : ' ⚠'}`
}

function renderConnectionBadge(state: ConnState, nextRetryMs: number, error: string): void {
  connBadge.dataset.state = state
  if (state === 'open') {
    connBadge.textContent = 'live'
    connBadge.title = wsUrl
    return
  }
  if (state === 'blocked') {
    connBadge.textContent = 'ws override blocked'
    connBadge.title = error
    return
  }
  if (state === 'connecting') {
    connBadge.textContent = 'connecting…'
    return
  }
  const retry = nextRetryMs ? ` · ${(nextRetryMs / 1000).toFixed(0)}s` : ''
  connBadge.textContent = `no backend${retry}`
  connBadge.title = error || wsUrl
}

function paintDiagnostics(): void {
  const snap = hud.snapshot()
  const wsStatus = ws.status
  const backend = snap.backend
  const array = snap.array
  const mic = micSummary()
  const model = backend ? backend.model : '—'
  const transport = backend?.transport ?? array?.transport ?? '—'
  const revision = backend?.git_rev ?? '—'
  diagSummary.textContent = `${wsStatus.state} · ${model} · ${transport} · ${revision} · ${mic}`

  const mics = array?.mics?.map((m) => `${m.id}:${m.ok ? 'ok' : 'FAIL'}`).join('  ') ?? '—'
  const calib = snap.calibration
  const calibText = calib
    ? `yaw ${calib.head_yaw_offset_deg}° · fov ${calib.camera_fov_deg}° · spacing ${calib.spacing_m} m · baseline ${calib.baseline_m} m · audio delay ${
        calib.audio_delay_ms === undefined ? 'unmeasured' : `${calib.audio_delay_ms} ms`
      }`
    : 'pending — no array_status yet'
  const presence: PresenceMsg | null = snap.presence
  const latency =
    wsStatus.latencyMs === null
      ? 'no echo'
      : `${wsStatus.latencyMs.toFixed(1)} ms (median ${(wsStatus.latencyMedianMs ?? 0).toFixed(1)} ms)`

  diagBody.innerHTML = `
    <dl>
      <dt>connection</dt><dd>${wsStatus.state} · ${wsStatus.url}</dd>
      <dt>received</dt><dd>${wsStatus.received} messages · ${wsStatus.unknownTypes} unknown · ${wsStatus.malformed} malformed</dd>
      <dt>model</dt><dd>${model}${backend?.model_path ? ` · ${backend.model_path}` : ''} · ${backend?.classes ?? '—'} classes · ${backend?.sample_rate ?? '—'} Hz</dd>
      <dt>model sha256</dt><dd class="wrap">${backend?.model_sha256 ?? '—'}</dd>
      <dt>git rev</dt><dd>${revision}</dd>
      <dt>transport</dt><dd>${transport}</dd>
      <dt>mics</dt><dd>${mics}</dd>
      <dt>calibration</dt><dd class="wrap">${calibText}</dd>
      <dt>presence</dt><dd>${presence ? `${presence.human ? 'human' : 'none'} · ${presence.source ?? '?'}` : '—'}</dd>
      <dt>render</dt><dd>${snap.fps.toFixed(1)} fps (5 s rolling) · dpr ${window.devicePixelRatio.toFixed(2)}</dd>
      <dt>latency</dt><dd>${latency}</dd>
      <dt>face tracking</dt><dd>${vision.status.state}${vision.status.delegate ? ` · ${vision.status.delegate}` : ''} · ${vision.status.analyzedFrames} frames (${vision.status.analyzedFps.toFixed(1)}/s${vision.status.inferenceMs === null ? '' : ` · ${vision.status.inferenceMs.toFixed(0)} ms/frame`}) · ${snap.faces.length} face(s)</dd>
      <dt>mode</dt><dd>${mode} · ${snap.events.filter((e) => e.urgency === 'urgent').length} urgent active</dd>
      <dt>events</dt><dd>${snap.counts.events} tracked · ${snap.counts.speeches} speech · ${snap.counts.mergedTimeline} merged from timeline · ${snap.counts.staleTimeline} stale ignored · ${snap.counts.rejected} rejected · ${snap.counts.backendRestarts} backend restarts</dd>
      <dt>captions</dt><dd class="wrap">${snap.captions.length ? snap.captions.join('<br>') : '—'}</dd>
      <dt>diagnostic</dt><dd class="wrap">${lastDiagnostic || '—'}</dd>
      <dt>vision error</dt><dd class="wrap">${vision.status.lastError || '—'}</dd>
    </dl>
  `
}

// ---------------------------------------------------------------------------
// Unanchored / degraded notices
// ---------------------------------------------------------------------------
function paintNotice(): void {
  const snap = hud.snapshot()
  const wsStatus = ws.status
  const messages: string[] = []
  let plate = ''

  if (!snap.calibration) {
    // No calibration means no marker can be placed honestly (README §4.5 makes
    // `array_status.calibration` the mapping's source). Say which link is missing.
    if (wsStatus.state !== 'open' && wsStatus.attempt === 0 && wsStatus.received === 0) {
      plate = 'CONNECTING · waiting for the backend'
      messages.push(`CONNECTING — ${wsStatus.url}`)
    } else if (wsStatus.state === 'open' && wsStatus.received > 0) {
      plate = 'CALIBRATION PENDING · backend sent no array_status.calibration'
      messages.push('CALIBRATION PENDING — connected, but no `array_status.calibration` yet (§4.5)')
    } else if (wsStatus.state === 'open') {
      plate = 'CALIBRATION PENDING · waiting for array_status'
      messages.push('CALIBRATION PENDING — connected, waiting for the first `array_status`')
    } else if (wsStatus.state === 'blocked') {
      plate = 'NO BACKEND · insecure override blocked'
      messages.push(`NO BACKEND — ${wsStatus.lastError}`)
    } else if (wsStatus.received > 0) {
      plate = `FEED LOST · disconnected after ${wsStatus.received} messages`
      messages.push(`FEED LOST — the backend at ${wsStatus.url} disconnected after ${wsStatus.received} messages; restart it`)
    } else {
      plate = 'NO BACKEND · nothing connected'
      messages.push(`NO BACKEND — nothing answered on ${wsStatus.url}; start it with \`npm run mock\` (or B's server)`)
    }
  }
  if (vision.status.state === 'unavailable') {
    messages.push('FACE TRACKING UNAVAILABLE — captions shown unanchored')
  }
  notice.hidden = messages.length === 0
  notice.textContent = messages.join(' · ')
  hud.setStatusLine(plate)
}

// ---------------------------------------------------------------------------
// Camera (user-initiated; raw preview is never mirrored so bearing signs hold)
// ---------------------------------------------------------------------------
function describeCameraError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  if (!window.isSecureContext) {
    return 'Camera needs a secure context. Open this page over https:// (or http://localhost) — plain http over the LAN will not work.'
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera permission denied. Allow camera access for this site, then retry.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No usable camera found. Connect a camera (or use a device with one) and retry.'
  }
  return `Camera failed: ${err instanceof Error ? err.message : String(err)}`
}

async function startCamera(): Promise<void> {
  cameraError.hidden = true
  camButton.disabled = true
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
    cameraStream = stream
    video.srcObject = stream
    await video.play()
    cameraStarted = true
    camButton.hidden = true
    vision.start(video)
    paintDiagnostics()
  } catch (err) {
    cameraErrorMessage.textContent = describeCameraError(err)
    cameraError.hidden = false
    lastDiagnostic = cameraErrorMessage.textContent
  } finally {
    camButton.disabled = false
  }
}

camButton.addEventListener('click', () => void startCamera())
cameraRetry.addEventListener('click', () => void startCamera())
window.addEventListener('pagehide', () => {
  cameraStream?.getTracks().forEach((t) => t.stop())
})

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
ws.connect()
hud.setVision(vision.status.state, vision.faces)

// §4.6 `audio`: `?mic=1` makes this browser the backend's microphone. The phone
// is a better sensor than the laptop's DMIC pair and is not attached to the
// chassis, so a clap arrives as airborne sound (see web/src/mic.ts).
const mic = new MicStream()
const micWanted = params.get('mic') === '1'
mic.onStatus = (status) => {
  if (status.state === 'error') console.warn('mic:', status.lastError)
  else console.info(`mic: ${status.state}${status.sampleRate ? ` @ ${status.sampleRate} Hz` : ''} (${status.frames} frames, ${status.seconds.toFixed(1)}s sent)`)
}
if (micWanted) {
  ws.onStatus = ((previous) => (status: Parameters<NonNullable<typeof ws.onStatus>>[0]) => {
    previous(status)
    if (status.state === 'open' && mic.status.state !== 'running' && mic.status.state !== 'starting') {
      void mic.start((base64, seq, rate, channels) => ws.audio(base64, seq, rate, channels))
    }
  })(ws.onStatus)
}

renderConnectionBadge(ws.status.state, 0, ws.status.lastError)
paintDiagnostics()
paintNotice()
setInterval(() => {
  paintDiagnostics()
  paintNotice()
}, 250)

// Read-only introspection for `web/dev/evidence.md` runs and manual debugging.
Object.defineProperty(window, '__hud', {
  value: {
    snapshot: () => hud.snapshot(),
    ws: () => ws.status,
    vision: () => vision.status,
    mic: () => mic.status,
    cameraStarted: () => cameraStarted,
  },
})
