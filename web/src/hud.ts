// The dynamic HUD: camera-stage-aligned Canvas 2D overlay with direction markers,
// edge chevrons, speech bubbles anchored to faces, and the bottom bearing compass.
//
// Rendering rules come straight from README §4.5 and prompts/frontend.md:
//   * markers interpolate (never snap) — events arrive at 2-4 Hz,
//   * markers age out after 6 s, fading through their final second,
//   * alpha ∝ confidence and 1/accuracy_deg,
//   * out-of-FOV bearings never get clamped to a false position (chevrons instead),
//   * `ambiguous:true` renders both mirrored candidates,
//   * `elevation_deg: null` draws on the horizon line,
//   * `urgent` displaces every other caption and bubble,
//   * low-urgency captions coalesce into one `+N` chip.

import type {
  ArrayStatusMsg,
  BackendMsg,
  BackendStatusMsg,
  Calibration,
  FaceObs,
  Mode,
  PresenceMsg,
  SoundEventMsg,
  SpeechMsg,
  Urgency,
  VisionState,
} from './types'
import { mirroredBearing, projectBearing, wrapDeg } from './projection'

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

/** Marker lifetime and the fade window at the end of it (README: age out + fade). */
const LIFETIME_S = 6
const FADE_WINDOW_S = 1
/** Exponential smoothing rate for interpolated bearings (1/s). */
const SMOOTH_RATE = 9
/** 12° matches the accuracy of the prompt's sample event. */
const ACCURACY_SCALE_DEG = 12
const MIN_MARKER_ALPHA = 0.18
const COMPASS_HEIGHT = 48
/** A `t` this far behind the high-water mark means the backend restarted. */
const BACKEND_RESTART_JUMP_S = 5
const BOX_PAD_X = 7
const BOX_PAD_Y = 5
const BOX_ACCENT = 3

interface TierStyle {
  color: string
  text: string
  size: number
  weight: string
  /** Marker curtain height as a fraction of the camera frame height. */
  curtain: number
  word: string
}

const TIER: Record<Urgency, TierStyle> = {
  low: { color: '#7e97a1', text: '#cfe4ec', size: 11, weight: '400', curtain: 0.09, word: 'LOW' },
  normal: { color: '#3ad2ff', text: '#e8faff', size: 12, weight: '400', curtain: 0.15, word: 'NORMAL' },
  high: { color: '#ffb020', text: '#fff2da', size: 13, weight: '700', curtain: 0.22, word: 'HIGH' },
  urgent: { color: '#ff3b30', text: '#ffffff', size: 16, weight: '700', curtain: 0.34, word: 'URGENT' },
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface FrameRect {
  left: number
  top: number
  width: number
  height: number
  /** True when there is no camera frame yet and the canvas is used as-is. */
  full: boolean
}

interface TrackedEvent {
  msg: SoundEventMsg
  latestT: number
  bearing: number
  target: number
  mirrorBearing: number
  mirrorTarget: number
  alpha: number
  targetAlpha: number
  fade: number
  age: number
  caption: string
}

interface TrackedSpeech {
  msg: SpeechMsg
  latestT: number
  bearing: number
  target: number
  alpha: number
  targetAlpha: number
  fade: number
  age: number
  urgency: Urgency
}

export interface HudEventView {
  id: string
  class: string
  urgency: Urgency
  confidence: number
  accuracy_deg: number
  ambiguous: boolean
  bearingDeg: number
  mirrorDeg: number
  x: number | null
  inFov: boolean
  edge: 'left' | 'right'
  mirrorX: number | null
  mirrorInFov: boolean
  alpha: number
  age: number
  caption: string
}

export interface HudSpeechView {
  id: string
  text: string
  partial: boolean
  bearingDeg: number
  x: number | null
  inFov: boolean
  label: string
  anchored: boolean
  urgency: Urgency
}

export interface HudSnapshot {
  nowServer: number
  calibration: Calibration | null
  calibrationPending: boolean
  mode: Mode
  fps: number
  visionState: VisionState
  faces: FaceObs[]
  frameRect: FrameRect
  compass: { left: number; top: number; width: number; height: number }
  events: HudEventView[]
  speeches: HudSpeechView[]
  captions: string[]
  counts: {
    events: number
    speeches: number
    mergedTimeline: number
    staleTimeline: number
    rejected: number
    backendRestarts: number
  }
  presence: PresenceMsg | null
  backend: BackendStatusMsg | null
  array: ArrayStatusMsg | null
  reducedMotion: boolean
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Marker opacity: confidence scaled against accuracy, clamped into a range that
 * keeps a weak detection legible without ever dominating the frame.
 */
function markerOpacity(confidence: number, accuracyDeg: number): number {
  const raw = clamp01((confidence * ACCURACY_SCALE_DEG) / Math.max(accuracyDeg, 1))
  return Math.max(MIN_MARKER_ALPHA, raw)
}

export class Hud {
  mode: Mode = 'all'
  visionState: VisionState = 'off'
  /** Backend socket is open (drives the "no backend" vs "calibration pending" wording). */
  backendConnected = false
  /** Notice text rendered on the canvas while no calibration is available. */
  statusLine = ''
  faces: FaceObs[] = []
  backend: BackendStatusMsg | null = null
  array: ArrayStatusMsg | null = null
  presence: PresenceMsg | null = null
  calibration: Calibration | null = null
  fps = 0
  countMergedTimeline = 0
  countStaleTimeline = 0
  countRejected = 0
  countBackendRestarts = 0

  private canvas: HTMLCanvasElement
  private video: HTMLVideoElement
  private ctx: CanvasRenderingContext2D | null
  private events = new Map<string, TrackedEvent>()
  private speeches = new Map<string, TrackedSpeech>()
  private clock = { t: 0, local: 0, valid: false }
  private frameTimes: number[] = []
  private captionBuf: string[] = []
  private cssWidth = 0
  private cssHeight = 0
  private dpr = 1
  private bottomInset = 72
  private raf = 0
  private lastFrameAt = 0
  private reducedMotion: boolean
  private reducedMotionQuery: MediaQueryList
  private onDiagnostic: (message: string) => void

  constructor(canvas: HTMLCanvasElement, video: HTMLVideoElement, onDiagnostic: (message: string) => void = () => {}) {
    this.canvas = canvas
    this.video = video
    this.ctx = canvas.getContext('2d')
    this.onDiagnostic = onDiagnostic
    this.reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    this.reducedMotion = this.reducedMotionQuery.matches
    this.reducedMotionQuery.addEventListener('change', (e) => {
      this.reducedMotion = e.matches
    })
    this.resize()
  }

  start(): void {
    if (this.raf) return
    this.raf = requestAnimationFrame(this.loop)
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  /** Bottom inset (CSS px) reserved for the DOM control bar so the compass clears it. */
  setBottomInset(px: number): void {
    this.bottomInset = px
  }

  setMode(mode: Mode): void {
    this.mode = mode
  }

  setVision(state: VisionState, faces: FaceObs[]): void {
    this.visionState = state
    this.faces = faces
  }

  setBackendConnected(connected: boolean): void {
    this.backendConnected = connected
  }

  setStatusLine(text: string): void {
    this.statusLine = text
  }

  resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth
    const height = this.canvas.clientHeight || window.innerHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    this.cssWidth = width
    this.cssHeight = height
    this.dpr = dpr
    const pw = Math.round(width * dpr)
    const ph = Math.round(height * dpr)
    if (this.canvas.width !== pw) this.canvas.width = pw
    if (this.canvas.height !== ph) this.canvas.height = ph
  }

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------
  ingest(msg: BackendMsg): void {
    switch (msg.type) {
      case 'array_status':
        this.observeServerT(msg.t)
        this.array = msg
        if (msg.calibration) this.calibration = { ...msg.calibration }
        break
      case 'backend_status':
        this.observeServerT(msg.t)
        this.backend = msg
        break
      case 'presence':
        this.observeServerT(msg.t)
        this.presence = msg
        break
      case 'sound_event':
        this.observeServerT(msg.t)
        this.upsertEvent(msg)
        break
      case 'speech':
        this.observeServerT(msg.t)
        this.upsertSpeech(msg)
        break
      case 'timeline':
        this.observeServerT(msg.t)
        for (const event of msg.events) {
          if (!event || typeof event !== 'object') continue
          if (event.type === 'sound_event') this.upsertEvent(event as SoundEventMsg, true)
          else if (event.type === 'speech') this.upsertSpeech(event as SpeechMsg, true)
        }
        break
    }
  }

  private observeServerT(t: number): void {
    const local = performance.now() / 1000
    if (!this.clock.valid || t >= this.serverNow()) {
      this.clock = { t, local, valid: true }
      return
    }
    // `t` is monotonic only within one backend process (README §4.5). A large
    // backwards jump means the backend restarted its clock: adopt it and drop the
    // previous run's events, otherwise every new event would look ancient and be
    // culled on arrival.
    if (t < this.clock.t - BACKEND_RESTART_JUMP_S) {
      this.clock = { t, local, valid: true }
      this.events.clear()
      this.speeches.clear()
      this.countBackendRestarts += 1
    }
  }

  /** Backend-relative clock, extrapolated between messages with the local clock. */
  private serverNow(): number {
    if (!this.clock.valid) return 0
    return this.clock.t + Math.max(0, performance.now() / 1000 - this.clock.local)
  }

  private upsertEvent(msg: SoundEventMsg, fromTimeline = false): void {
    if (typeof msg.id !== 'string' || !Number.isFinite(msg.bearing_deg) || !Number.isFinite(msg.confidence)) {
      this.countRejected += 1
      this.onDiagnostic(`sound_event rejected: ${JSON.stringify(msg).slice(0, 120)}`)
      return
    }
    const accuracy = Number.isFinite(msg.accuracy_deg) ? Math.max(msg.accuracy_deg, 1) : ACCURACY_SCALE_DEG
    const urgency: Urgency = msg.urgency in TIER ? msg.urgency : 'normal'
    const caption =
      `${msg.class} ${Math.round(clamp01(msg.confidence) * 100)}%` +
      ` · ±${accuracy.toFixed(0)}°` +
      ` · ${TIER[urgency].word}` +
      (msg.ambiguous ? ' · AMB' : '')

    const existing = this.events.get(msg.id)
    if (existing) {
      if (fromTimeline && msg.t <= existing.latestT) {
        // Never walk an id backwards in time (stale timeline snapshot).
        this.countStaleTimeline += 1
        return
      }
      if (fromTimeline) this.countMergedTimeline += 1
      existing.msg = { ...existing.msg, ...msg, urgency }
      existing.latestT = msg.t
      existing.target = msg.bearing_deg
      existing.mirrorTarget = mirroredBearing(msg.bearing_deg)
      existing.targetAlpha = markerOpacity(msg.confidence, accuracy)
      existing.caption = caption
      return
    }

    if (this.serverNow() - msg.t > LIFETIME_S) {
      // Already expired when a timeline snapshot arrived: keep it out of the HUD.
      this.countStaleTimeline += 1
      return
    }
    this.events.set(msg.id, {
      msg: { ...msg, urgency },
      latestT: msg.t,
      bearing: msg.bearing_deg,
      target: msg.bearing_deg,
      mirrorBearing: mirroredBearing(msg.bearing_deg),
      mirrorTarget: mirroredBearing(msg.bearing_deg),
      alpha: markerOpacity(msg.confidence, accuracy),
      targetAlpha: markerOpacity(msg.confidence, accuracy),
      fade: 1,
      age: 0,
      caption,
    })
  }

  private upsertSpeech(msg: SpeechMsg, fromTimeline = false): void {
    if (typeof msg.id !== 'string' || !Number.isFinite(msg.bearing_deg) || typeof msg.text !== 'string') {
      this.countRejected += 1
      this.onDiagnostic(`speech rejected: ${JSON.stringify(msg).slice(0, 120)}`)
      return
    }
    const parent = msg.parent_event ? this.events.get(msg.parent_event) : undefined
    const urgency = parent ? parent.msg.urgency : 'normal'
    const existing = this.speeches.get(msg.id)
    if (existing) {
      if (fromTimeline && msg.t <= existing.latestT) {
        this.countStaleTimeline += 1
        return
      }
      if (fromTimeline) this.countMergedTimeline += 1
      // Partial transcripts update in place; the final text replaces them.
      existing.msg = { ...existing.msg, ...msg }
      existing.latestT = msg.t
      existing.target = msg.bearing_deg
      existing.urgency = urgency
      existing.targetAlpha = this.speechOpacity(msg.confidence)
      return
    }
    if (this.serverNow() - msg.t > LIFETIME_S) {
      this.countStaleTimeline += 1
      return
    }
    this.speeches.set(msg.id, {
      msg: { ...msg },
      latestT: msg.t,
      bearing: msg.bearing_deg,
      target: msg.bearing_deg,
      alpha: this.speechOpacity(msg.confidence),
      targetAlpha: this.speechOpacity(msg.confidence),
      fade: 1,
      age: 0,
      urgency,
    })
  }

  private speechOpacity(confidence: number): number {
    return Math.max(0.35, clamp01(0.55 + 0.45 * (Number.isFinite(confidence) ? confidence : 0.6)))
  }

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------
  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop)
    const now = performance.now()
    const dt = this.lastFrameAt ? Math.min(0.1, (now - this.lastFrameAt) / 1000) : 1 / 60
    this.lastFrameAt = now

    this.render(dt, now)

    // Rolling 5 s frame-rate figure, measured from completed Canvas frames.
    this.frameTimes.push(now)
    const cutoff = now - 5000
    while (this.frameTimes.length > 1 && this.frameTimes[0] < cutoff) this.frameTimes.shift()
    const span = (now - this.frameTimes[0]) / 1000
    this.fps = span > 0 ? (this.frameTimes.length - 1) / span : 0
  }

  private advance(dt: number, serverNow: number): void {
    const k = 1 - Math.exp(-SMOOTH_RATE * dt)
    for (const [id, e] of this.events) {
      // Interpolate along the shortest wrapped path so a bearing crossing ±180°
      // does not sweep across the whole frame.
      e.bearing = wrapDeg(e.bearing + wrapDeg(e.target - e.bearing) * k)
      e.mirrorBearing = wrapDeg(e.mirrorBearing + wrapDeg(e.mirrorTarget - e.mirrorBearing) * k)
      e.alpha += (e.targetAlpha - e.alpha) * k
      e.age = serverNow - e.msg.t
      e.fade = e.age <= LIFETIME_S - FADE_WINDOW_S ? 1 : clamp01(1 - (e.age - (LIFETIME_S - FADE_WINDOW_S)) / FADE_WINDOW_S)
      if (e.age > LIFETIME_S) this.events.delete(id)
    }
    for (const [id, s] of this.speeches) {
      s.bearing = wrapDeg(s.bearing + wrapDeg(s.target - s.bearing) * k)
      s.alpha += (s.targetAlpha - s.alpha) * k
      s.age = serverNow - s.msg.t
      s.fade = s.age <= LIFETIME_S - FADE_WINDOW_S ? 1 : clamp01(1 - (s.age - (LIFETIME_S - FADE_WINDOW_S)) / FADE_WINDOW_S)
      if (s.age > LIFETIME_S) this.speeches.delete(id)
    }
  }

  private tierVisible(urgency: Urgency): boolean {
    if (this.mode === 'quiet') return urgency === 'high' || urgency === 'urgent'
    if (this.mode === 'important') return urgency !== 'low'
    return true
  }

  private render(dt: number, nowLocal: number): void {
    const ctx = this.ctx
    if (!ctx) return
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight)
    this.captionBuf.length = 0

    const serverNow = this.serverNow()
    this.advance(dt, serverNow)

    const rect = this.frameRect()
    // `cover` crops the video, so the content rect can run past the viewport.
    // Projection uses the content rect; anything a person must read or click
    // (captions, chevrons, bubbles, compass) is clamped to `vis`.
    const vis = this.visibleRect(rect)
    const list = [...this.events.values()].filter((e) => this.tierVisible(e.msg.urgency) && e.alpha * e.fade > 0.02)
    const urgentActive = list.some((e) => e.msg.urgency === 'urgent')
    const shown = urgentActive ? list.filter((e) => e.msg.urgency === 'urgent') : list
    const lows = shown.filter((e) => e.msg.urgency === 'low')
    const collapseLow = lows.length >= 2
    const captioned = shown.filter((e) => !(collapseLow && e.msg.urgency === 'low'))
    const bubbles = urgentActive
      ? []
      : [...this.speeches.values()].filter((s) => this.tierVisible(s.urgency) && s.alpha * s.fade > 0.02)

    const pulse = this.reducedMotion || !urgentActive ? 1 : 0.72 + 0.28 * Math.sin(nowLocal / 120)

    if (!this.calibration) {
      this.drawPendingCalibration(ctx, vis)
      this.drawCompass(ctx, vis, null)
      return
    }

    const byTime = [...shown].sort((a, b) => a.msg.t - b.msg.t)
    const captions = [...captioned].sort((a, b) => a.msg.t - b.msg.t)
    this.drawMarkers(ctx, rect, vis, byTime, pulse)
    // Bubbles are placed first and captions dodge them (and each other), so a
    // transcript is never overprinted by an unrelated caption.
    const occupied = this.drawBubbles(ctx, rect, vis, bubbles)
    this.drawCaptions(ctx, rect, vis, captions, pulse, occupied)
    if (collapseLow) {
      this.drawChip(ctx, vis, `+${lows.length} low`, TIER.low, pulse)
    }
    this.drawCompass(ctx, vis, byTime)
    if (urgentActive) this.drawUrgentBanner(ctx, vis, shown, pulse)
  }

  private frameRect(): FrameRect {
    const cw = this.cssWidth || window.innerWidth
    const ch = this.cssHeight || window.innerHeight
    const vw = this.video.videoWidth
    const vh = this.video.videoHeight
    if (!vw || !vh) return { left: 0, top: 0, width: cw, height: ch, full: true }
    // object-fit: cover — the canvas must follow the *content* rect, not the element.
    const scale = Math.max(cw / vw, ch / vh)
    const width = vw * scale
    const height = vh * scale
    return { left: (cw - width) / 2, top: (ch - height) / 2, width, height, full: false }
  }

  /** The part of `rect` that is actually on screen. */
  private visibleRect(rect: FrameRect): FrameRect {
    const left = Math.max(rect.left, 0)
    const top = Math.max(rect.top, 0)
    const right = Math.min(rect.left + rect.width, this.cssWidth || window.innerWidth)
    const bottom = Math.min(rect.top + rect.height, this.cssHeight || window.innerHeight)
    return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top), full: rect.full }
  }

  /**
   * Horizon line: the camera frame's centre height, kept inside the visible band
   * so markers stay readable even when `cover` crops the video vertically.
   */
  private horizon(rect: FrameRect, vis: FrameRect): number {
    const centre = rect.top + rect.height * 0.5
    return Math.min(Math.max(centre, vis.top + vis.height * 0.12), vis.top + vis.height * 0.88)
  }

  private drawMarkers(
    ctx: CanvasRenderingContext2D,
    rect: FrameRect,
    vis: FrameRect,
    list: TrackedEvent[],
    pulse: number,
  ): void {
    const horizon = this.horizon(rect, vis)
    for (const e of list) {
      const tier = TIER[e.msg.urgency]
      const alpha = e.alpha * e.fade
      const primary = projectBearing(e.bearing, this.calibration!)
      const mirror = projectBearing(e.mirrorBearing, this.calibration!)
      const curtain = rect.height * tier.curtain

      if (primary.inFov) {
        this.drawCurtain(ctx, rect, horizon, primary.x, curtain, tier, alpha * (e.msg.urgency === 'urgent' ? pulse : 1))
      } else {
        this.drawChevron(ctx, vis, horizon, primary.edge, tier, alpha, false)
      }
      // Ambiguity: always both candidates, never one arbitrary half-space.
      if (e.msg.ambiguous) {
        if (mirror.inFov) {
          this.drawCurtain(ctx, rect, horizon, mirror.x, curtain * 0.7, tier, alpha * 0.55)
          if (primary.inFov) this.drawMirrorLink(ctx, rect, horizon, primary.x, mirror.x, tier, alpha * 0.5)
        } else {
          this.drawChevron(ctx, vis, horizon, mirror.edge, tier, alpha * 0.55, false)
        }
      }
    }
  }

  private drawCurtain(
    ctx: CanvasRenderingContext2D,
    rect: FrameRect,
    horizon: number,
    xFrac: number,
    height: number,
    tier: TierStyle,
    alpha: number,
  ): void {
    const px = rect.left + clamp01(xFrac) * rect.width
    const top = horizon - height * 0.62
    const bottom = horizon + height * 0.38
    ctx.globalAlpha = alpha
    ctx.strokeStyle = tier.color
    ctx.lineWidth = tier.word === 'URGENT' ? 3 : 2
    ctx.beginPath()
    ctx.moveTo(px, top)
    ctx.lineTo(px, bottom)
    ctx.stroke()
    ctx.fillStyle = tier.color
    ctx.fillRect(px - 5, horizon - 1, 10, 2)
    ctx.beginPath()
    ctx.moveTo(px, top - 7)
    ctx.lineTo(px - 5, top + 2)
    ctx.lineTo(px + 5, top + 2)
    ctx.closePath()
    ctx.fill()
    ctx.globalAlpha = 1
  }

  private drawMirrorLink(
    ctx: CanvasRenderingContext2D,
    rect: FrameRect,
    horizon: number,
    xa: number,
    xb: number,
    tier: TierStyle,
    alpha: number,
  ): void {
    const pa = rect.left + clamp01(xa) * rect.width
    const pb = rect.left + clamp01(xb) * rect.width
    ctx.globalAlpha = alpha
    ctx.strokeStyle = tier.color
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(pa, horizon + 2)
    ctx.lineTo(pb, horizon + 2)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }

  private drawChevron(
    ctx: CanvasRenderingContext2D,
    rect: FrameRect,
    horizon: number,
    edge: 'left' | 'right',
    tier: TierStyle,
    alpha: number,
    labelled: boolean,
  ): void {
    const size = tier.word === 'URGENT' ? 18 : 13
    const x = edge === 'left' ? rect.left + 2 : rect.left + rect.width - 2
    const dir = edge === 'left' ? 1 : -1
    ctx.globalAlpha = alpha
    ctx.fillStyle = tier.color
    ctx.beginPath()
    ctx.moveTo(x, horizon)
    ctx.lineTo(x + dir * size, horizon - size * 0.8)
    ctx.lineTo(x + dir * size, horizon + size * 0.8)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = tier.color
    ctx.fillRect(x - (edge === 'left' ? 0 : 3), horizon - 1, 3, 2)
    if (labelled) {
      ctx.font = `400 9px ${MONO}`
      ctx.fillText('AMB', x + dir * (size + 3), horizon + 3)
    }
    ctx.globalAlpha = 1
  }

  private drawCaptions(
    ctx: CanvasRenderingContext2D,
    rect: FrameRect,
    vis: FrameRect,
    list: TrackedEvent[],
    pulse: number,
    avoid: Rect[] = [],
  ): void {
    const horizon = this.horizon(rect, vis)
    const placed: Rect[] = [...avoid]
    const stack = { left: horizon + 22, right: horizon + 22 }
    const bounds = { left: vis.left, right: vis.left + vis.width }
    for (const e of list) {
      const tier = TIER[e.msg.urgency]
      const alpha = e.alpha * e.fade
      const primary = projectBearing(e.bearing, this.calibration!)
      const arrow = primary.inFov ? this.arrowFor(primary.x) : primary.edge === 'left' ? '◀' : '▶'
      const text = `${arrow} ${e.caption}`
      const { w, h } = this.measureBox(ctx, text, tier)

      // Anchor at the bearing when it is on screen, else at the matching edge.
      const anchor =
        primary.inFov
          ? { x: rect.left + clamp01(primary.x) * rect.width, align: 'center' as const }
          : { x: primary.edge === 'left' ? vis.left + 22 : vis.left + vis.width - 22, align: primary.edge === 'left' ? ('left' as const) : ('right' as const) }

      // Walk captions downward until this one no longer overprints another.
      let y = primary.inFov ? horizon + 14 : stack[primary.edge]
      for (let attempt = 0; attempt < 8; attempt++) {
        const { bx } = this.placeBox(anchor.x, y, anchor.align, w, bounds)
        const collides = placed.some((r) => r.x < bx + w + 2 && bx < r.x + r.w + 2 && r.y < y + h + 2 && y < r.y + r.h + 2)
        if (!collides) break
        y += h + 3
      }
      const box = this.drawBox(ctx, text, anchor.x, y, anchor.align, tier, alpha, pulse, bounds)
      placed.push(box)
      if (!primary.inFov) stack[primary.edge] = box.y + box.h + 4
    }
  }

  private arrowFor(xFrac: number): string {
    if (xFrac < 0.485) return '◀'
    if (xFrac > 0.515) return '▶'
    return '▲'
  }

  /** Block-edged, black translucent monospace caption (Minecraft-subtitle feel). */
  private drawBox(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    align: 'left' | 'center' | 'right',
    tier: TierStyle,
    alpha: number,
    pulse: number,
    bounds: { left: number; right: number } | null = null,
  ): Rect {
    const { w, h } = this.measureBox(ctx, text, tier)
    const { bx, by } = this.placeBox(x, y, align, w, bounds)
    this.paintBox(ctx, text, bx, by, w, h, tier, alpha, pulse)
    return { x: bx, y: by, w, h }
  }

  private measureBox(ctx: CanvasRenderingContext2D, text: string, tier: TierStyle): { w: number; h: number } {
    ctx.font = `${tier.weight} ${tier.size}px ${MONO}`
    ctx.textBaseline = 'alphabetic'
    return { w: Math.ceil(ctx.measureText(text).width) + BOX_PAD_X * 2 + BOX_ACCENT, h: tier.size + BOX_PAD_Y * 2 }
  }

  private placeBox(
    x: number,
    y: number,
    align: 'left' | 'center' | 'right',
    w: number,
    bounds: { left: number; right: number } | null,
  ): { bx: number; by: number } {
    let bx = Math.round(align === 'left' ? x : align === 'center' ? x - w / 2 : x - w)
    if (bounds) bx = Math.round(Math.min(Math.max(bx, bounds.left + 4), Math.max(bounds.left + 4, bounds.right - w - 4)))
    return { bx, by: Math.round(y) }
  }

  /** Block-edged, black translucent monospace caption (Minecraft-subtitle feel). */
  private paintBox(
    ctx: CanvasRenderingContext2D,
    text: string,
    bx: number,
    by: number,
    w: number,
    h: number,
    tier: TierStyle,
    alpha: number,
    pulse: number,
  ): void {
    ctx.globalAlpha = alpha
    ctx.fillStyle = 'rgba(2,5,8,0.84)'
    ctx.fillRect(bx, by, w, h)
    ctx.strokeStyle = tier.color
    ctx.lineWidth = 1
    ctx.globalAlpha = alpha * (0.72 + 0.28 * pulse)
    ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1)
    ctx.globalAlpha = alpha
    ctx.fillStyle = tier.color
    ctx.fillRect(bx, by, BOX_ACCENT, h)
    ctx.font = `${tier.weight} ${tier.size}px ${MONO}`
    ctx.fillStyle = tier.text
    ctx.fillText(text, bx + BOX_ACCENT + BOX_PAD_X, by + BOX_PAD_Y + tier.size * 0.82)
    ctx.globalAlpha = 1
    this.captionBuf.push(text)
  }

  private drawChip(ctx: CanvasRenderingContext2D, vis: FrameRect, text: string, tier: TierStyle, pulse: number): void {
    const y = vis.top + vis.height * 0.5 + 46
    this.drawBox(ctx, text, vis.left + vis.width - 12, y, 'right', tier, 0.9, pulse, {
      left: vis.left,
      right: vis.left + vis.width,
    })
  }

  /** The urgent event owns the frame: it displaces every other caption/bubble. */
  private drawUrgentBanner(ctx: CanvasRenderingContext2D, vis: FrameRect, list: TrackedEvent[], pulse: number): void {
    const top = list.reduce((acc, e) => (e.msg.t > acc.msg.t ? e : acc), list[0])
    if (!top) return
    const proj = projectBearing(top.bearing, this.calibration!)
    const where = proj.inFov ? `${wrapDeg(top.bearing).toFixed(0)}° from nose` : `${proj.edge} edge of view`
    const maxWidth = Math.max(120, vis.width - 24)
    const title = this.fitText(ctx, top.caption, maxWidth, TIER.urgent.size + 2, '700')
    const subtitle = this.fitText(ctx, `URGENT · ${where}`, maxWidth, 11, '400')
    const height = 46
    const w = Math.ceil(Math.max(title.width, subtitle.width) + 26)
    const x = Math.round(vis.left + (vis.width - w) / 2)
    const compassTop = Math.max(vis.top, this.cssHeight - this.bottomInset - COMPASS_HEIGHT)
    const y = Math.round(Math.max(vis.top + 8, compassTop - height - 12))

    ctx.globalAlpha = 0.92
    ctx.fillStyle = 'rgba(26,2,2,0.86)'
    ctx.fillRect(x, y, w, height)
    ctx.strokeStyle = TIER.urgent.color
    ctx.lineWidth = 2
    ctx.globalAlpha = 0.6 + 0.4 * pulse
    ctx.strokeRect(x + 1, y + 1, w - 2, height - 2)
    ctx.globalAlpha = 0.95
    ctx.fillStyle = TIER.urgent.text
    ctx.font = `700 ${title.size}px ${MONO}`
    ctx.fillText(title.text, x + 13, y + 20)
    ctx.fillStyle = TIER.urgent.color
    ctx.font = `400 ${subtitle.size}px ${MONO}`
    ctx.fillText(subtitle.text, x + 13, y + 36)
    ctx.globalAlpha = 1
    this.captionBuf.push(top.caption)
    this.captionBuf.push(`URGENT · ${where}`)
  }

  /** Shrink, then truncate, so a caption always fits the width it is given. */
  private fitText(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
    baseSize: number,
    weight: string,
  ): { text: string; size: number; width: number } {
    for (let size = baseSize; size >= 10; size--) {
      ctx.font = `${weight} ${size}px ${MONO}`
      if (ctx.measureText(text).width <= maxWidth) return { text, size, width: ctx.measureText(text).width }
    }
    let truncated = text
    ctx.font = `${weight} 10px ${MONO}`
    while (truncated.length > 4 && ctx.measureText(`${truncated}…`).width > maxWidth) {
      truncated = truncated.slice(0, -1)
    }
    return { text: `${truncated}…`, size: 10, width: ctx.measureText(`${truncated}…`).width }
  }

  private drawBubbles(
    ctx: CanvasRenderingContext2D,
    rect: FrameRect,
    vis: FrameRect,
    list: TrackedSpeech[],
  ): Rect[] {
    const horizon = this.horizon(rect, vis)
    const ordered = [...list].sort((a, b) => a.msg.t - b.msg.t)
    const drawn: Rect[] = []
    let floatingSlot = horizon - 14
    for (const s of ordered) {
      const proj = projectBearing(s.bearing, this.calibration!)
      const cssX = rect.left + clamp01(proj.x) * rect.width
      const normalizedX = clamp01(proj.x)
      const anchor = this.anchorFor(normalizedX)
      const alpha = s.alpha * s.fade
      const tag =
        anchor.state === 'unavailable'
          ? 'UNANCHORED · NO TRACKING'
          : anchor.state === 'active' && anchor.face
            ? 'SPEAKER'
            : anchor.state === 'inactive'
              ? 'PLAYBACK'
              : 'PLAYBACK · NO FACE'

      if (anchor.state === 'active' && anchor.face) {
        const box = anchor.face.box
        const faceTop = rect.top + box.y * rect.height
        const faceLeft = rect.left + box.x * rect.width
        const faceW = box.w * rect.width
        const bubble = this.drawBubble(ctx, s.msg.text, s.msg.partial, tag, TIER[s.urgency], alpha, {
          x: faceLeft + faceW / 2,
          y: faceTop - 10,
          align: 'center',
          maxWidth: Math.min(vis.width * 0.62, 340),
          bounds: { left: vis.left, right: vis.left + vis.width, top: vis.top },
        })
        // Anchor line + a ring on the box, placed so the mouth stays visible.
        this.drawLeader(ctx, vis, bubble.x + bubble.w / 2, bubble.y + bubble.h, faceLeft + faceW / 2, faceTop, TIER[s.urgency], alpha)
        drawn.push(bubble)
        ctx.globalAlpha = alpha * 0.9
        ctx.strokeStyle = TIER[s.urgency].color
        ctx.lineWidth = 1
        const marker = 6
        ctx.beginPath()
        ctx.moveTo(faceLeft, faceTop)
        ctx.lineTo(faceLeft + marker, faceTop)
        ctx.moveTo(faceLeft, faceTop)
        ctx.lineTo(faceLeft, faceTop + marker)
        ctx.moveTo(faceLeft + faceW, faceTop)
        ctx.lineTo(faceLeft + faceW - marker, faceTop)
        ctx.moveTo(faceLeft + faceW, faceTop)
        ctx.lineTo(faceLeft + faceW, faceTop + marker)
        ctx.stroke()
        ctx.globalAlpha = 1
      } else {
        // Free-floating at the bearing: still shows where the sound came from.
        // Bubbles stack upward from the horizon so they never overprint.
        const bubble = this.drawBubble(ctx, s.msg.text, s.msg.partial, tag, TIER[s.urgency], alpha, {
          x: cssX,
          y: floatingSlot,
          align: proj.inFov ? 'center' : proj.edge === 'left' ? 'left' : 'right',
          maxWidth: Math.min(vis.width * 0.58, 320),
          bounds: { left: vis.left, right: vis.left + vis.width, top: vis.top },
        })
        this.drawLeader(ctx, vis, bubble.x + bubble.w / 2, bubble.y + bubble.h, cssX, horizon, TIER[s.urgency], alpha * 0.8)
        floatingSlot = bubble.y - 8
        drawn.push(bubble)
        if (!proj.inFov) this.drawChevron(ctx, vis, horizon, proj.edge, TIER[s.urgency], alpha * 0.7, false)
      }
    }
    return drawn
  }

  private anchorFor(normalizedX: number): { face: FaceObs | null; state: 'active' | 'inactive' | 'none' | 'unavailable' } {
    if (this.visionState !== 'ready') return { face: null, state: 'unavailable' }
    if (!this.faces.length) return { face: null, state: 'none' }
    let best: FaceObs | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const face of this.faces) {
      if (normalizedX < face.box.x || normalizedX > face.box.x + face.box.w) continue
      const distance = Math.abs(face.box.x + face.box.w / 2 - normalizedX)
      if (distance < bestDistance) {
        bestDistance = distance
        best = face
      }
    }
    if (!best) return { face: null, state: 'none' }
    return { face: best, state: best.mouthActive ? 'active' : 'inactive' }
  }

  private drawLeader(
    ctx: CanvasRenderingContext2D,
    rect: FrameRect,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    tier: TierStyle,
    alpha: number,
  ): void {
    ctx.globalAlpha = alpha
    ctx.strokeStyle = tier.color
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(Math.max(rect.left, Math.min(fromX, rect.left + rect.width)), fromY)
    ctx.lineTo(Math.max(rect.left, Math.min(toX, rect.left + rect.width)), toY)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  private drawBubble(
    ctx: CanvasRenderingContext2D,
    text: string,
    partial: boolean,
    tag: string,
    tier: TierStyle,
    alpha: number,
    place: {
      x: number
      y: number
      align: 'left' | 'center' | 'right'
      maxWidth: number
      bounds: { left: number; right: number; top: number }
    },
  ): { x: number; y: number; w: number; h: number } {
    const bodyFont = `400 12px ${MONO}`
    const tagFont = `700 9px ${MONO}`
    const lineHeight = 15
    const padX = 8
    const padY = 6
    const accent = 3

    ctx.font = bodyFont
    const display = partial ? `${text} ▌` : text
    const lines = this.wrap(ctx, display, Math.max(80, place.maxWidth - padX * 2 - accent))
    ctx.font = tagFont
    const tagWidth = ctx.measureText(tag).width
    ctx.font = bodyFont
    const bodyWidth = lines.reduce((acc, line) => Math.max(acc, ctx.measureText(line).width), 0)
    const w = Math.ceil(Math.max(bodyWidth, tagWidth) + padX * 2 + accent)
    const h = lines.length * lineHeight + padY * 2 + 12

    const rawX = place.align === 'left' ? place.x : place.align === 'center' ? place.x - w / 2 : place.x - w
    const bx = Math.round(Math.min(Math.max(rawX, place.bounds.left + 4), Math.max(place.bounds.left + 4, place.bounds.right - w - 4)))
    // Never let a bubble escape above the frame (it would be unreadable).
    const by = Math.round(Math.max(place.bounds.top + 4, place.y - h))

    ctx.globalAlpha = alpha
    ctx.fillStyle = 'rgba(2,5,8,0.84)'
    ctx.fillRect(bx, by, w, h)
    ctx.strokeStyle = tier.color
    ctx.lineWidth = 1
    ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1)
    ctx.fillStyle = tier.color
    ctx.fillRect(bx, by, accent, h)
    ctx.font = tagFont
    ctx.fillStyle = tier.color
    ctx.fillText(tag, bx + accent + padX, by + padY + 7)
    ctx.font = bodyFont
    ctx.fillStyle = tier.text
    lines.forEach((line, i) => {
      ctx.fillText(line, bx + accent + padX, by + padY + 20 + i * lineHeight)
    })
    ctx.globalAlpha = 1
    this.captionBuf.push(`${tag} · ${display}`)
    return { x: bx, y: by, w, h }
  }

  private wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    const words = text.split(/\s+/).filter(Boolean)
    const lines: string[] = []
    let current = ''
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      if (ctx.measureText(candidate).width > maxWidth && current) {
        lines.push(current)
        current = word
      } else {
        current = candidate
      }
    }
    if (current) lines.push(current)
    return lines.length ? lines.slice(-4) : ['']
  }

  private drawCompass(ctx: CanvasRenderingContext2D, rect: FrameRect, list: TrackedEvent[] | null): void {
    const height = COMPASS_HEIGHT
    const top = Math.max(rect.top, this.cssHeight - this.bottomInset - height)
    const left = rect.left
    const width = rect.width
    const toX = (bearingDeg: number) => left + ((wrapDeg(bearingDeg) + 180) / 360) * width

    ctx.globalAlpha = 0.72
    ctx.fillStyle = 'rgba(2,5,8,0.72)'
    ctx.fillRect(left, top, width, height)
    ctx.globalAlpha = 1
    ctx.strokeStyle = 'rgba(58,210,255,0.35)'
    ctx.lineWidth = 1
    ctx.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1)

    const mid = top + height * 0.55

    if (this.calibration) {
      // Camera field of view, in hat-frame bearings.
      const half = this.calibration.camera_fov_deg / 2
      const yaw = this.calibration.head_yaw_offset_deg
      const segments: [number, number][] = []
      if (yaw - half < -180) {
        segments.push([yaw - half + 360, 180], [-180, yaw + half])
      } else if (yaw + half > 180) {
        segments.push([-180, yaw + half - 360], [yaw - half, 180])
      } else {
        segments.push([yaw - half, yaw + half])
      }
      ctx.fillStyle = 'rgba(58,210,255,0.13)'
      for (const [a, b] of segments) {
        ctx.fillRect(toX(a), top + 2, toX(b) - toX(a), height - 4)
      }
      ctx.strokeStyle = 'rgba(58,210,255,0.5)'
      ctx.beginPath()
      ctx.moveTo(toX(yaw), top + 1)
      ctx.lineTo(toX(yaw), top + height - 1)
      ctx.stroke()
    }

    // Ticks every 15°, labels every 45°.
    ctx.font = `400 9px ${MONO}`
    ctx.textBaseline = 'alphabetic'
    for (let bearing = -180; bearing <= 180; bearing += 15) {
      const x = toX(bearing)
      const major = bearing % 45 === 0
      ctx.strokeStyle = major ? 'rgba(223,241,247,0.7)' : 'rgba(223,241,247,0.28)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(Math.round(x) + 0.5, mid - (major ? 8 : 4))
      ctx.lineTo(Math.round(x) + 0.5, mid + (major ? 2 : 0))
      ctx.stroke()
      if (major) {
        ctx.fillStyle = 'rgba(223,241,247,0.75)'
        const label = bearing === 0 ? '0°' : `${bearing > 0 ? '+' : ''}${bearing}`
        const w = ctx.measureText(label).width
        ctx.fillText(label, Math.min(Math.max(x - w / 2, left + 1), left + width - w - 1), top + height - 4)
      }
    }

    // Event ticks: primary solid, mirror dashed when the event is ambiguous.
    if (list && this.calibration) {
      for (const e of list) {
        const tier = TIER[e.msg.urgency]
        const alpha = e.alpha * e.fade
        const tall = e.msg.urgency === 'urgent' || e.msg.urgency === 'high'
        ctx.globalAlpha = alpha
        ctx.fillStyle = tier.color
        ctx.fillRect(Math.round(toX(e.bearing)) - 1, mid - height * (tall ? 0.42 : 0.3), 3, height * (tall ? 0.42 : 0.3))
        if (e.msg.ambiguous) {
          ctx.globalAlpha = alpha * 0.5
          ctx.fillRect(Math.round(toX(e.mirrorBearing)) - 1, mid - 4, 3, 6)
        }
        ctx.globalAlpha = 1
      }
    }

    ctx.fillStyle = 'rgba(223,241,247,0.55)'
    ctx.font = `400 9px ${MONO}`
    ctx.fillText('BEARING (0° = NOSE)', left + 6, top + 11)
  }

  private drawPendingCalibration(ctx: CanvasRenderingContext2D, rect: FrameRect): void {
    const text = this.statusLine || (this.backendConnected ? 'CALIBRATION PENDING · waiting for array_status' : 'NO BACKEND · nothing connected')
    ctx.font = `700 12px ${MONO}`
    const w = Math.ceil(ctx.measureText(text).width) + 26
    const h = 30
    const x = Math.round(rect.left + (rect.width - w) / 2)
    const y = Math.round(rect.top + rect.height * 0.42)
    ctx.globalAlpha = 0.95
    ctx.fillStyle = 'rgba(2,5,8,0.84)'
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = '#ffb020'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
    ctx.fillStyle = '#ffb020'
    ctx.fillText(text, x + 13, y + 20)
    ctx.globalAlpha = 1
    this.captionBuf.push(text)
  }

  // -------------------------------------------------------------------------
  // Introspection (used by web/dev evidence runs and manual debugging)
  // -------------------------------------------------------------------------
  snapshot(): HudSnapshot {
    const rect = this.frameRect()
    const calib = this.calibration
    const events: HudEventView[] = [...this.events.values()]
      .sort((a, b) => a.msg.t - b.msg.t)
      .map((e) => {
        const primary = calib ? projectBearing(e.bearing, calib) : null
        const mirror = calib ? projectBearing(e.mirrorBearing, calib) : null
        return {
          id: e.msg.id,
          class: e.msg.class,
          urgency: e.msg.urgency,
          confidence: e.msg.confidence,
          accuracy_deg: e.msg.accuracy_deg,
          ambiguous: e.msg.ambiguous,
          bearingDeg: e.bearing,
          mirrorDeg: e.mirrorBearing,
          x: primary ? primary.x : null,
          inFov: primary ? primary.inFov : false,
          edge: primary ? primary.edge : 'left',
          mirrorX: mirror ? mirror.x : null,
          mirrorInFov: mirror ? mirror.inFov : false,
          alpha: e.alpha * e.fade,
          age: e.age,
          caption: e.caption,
        }
      })
    const speeches: HudSpeechView[] = [...this.speeches.values()]
      .sort((a, b) => a.msg.t - b.msg.t)
      .map((s) => {
        const proj = calib ? projectBearing(s.bearing, calib) : null
        const x = proj ? clamp01(proj.x) : 0
        const anchor = this.anchorFor(x)
        const label =
          anchor.state === 'unavailable'
            ? 'UNANCHORED · NO TRACKING'
            : anchor.state === 'active'
              ? 'SPEAKER'
              : anchor.state === 'inactive'
                ? 'PLAYBACK'
                : 'PLAYBACK · NO FACE'
        return {
          id: s.msg.id,
          text: s.msg.text,
          partial: s.msg.partial,
          bearingDeg: s.bearing,
          x: proj ? proj.x : null,
          inFov: proj ? proj.inFov : false,
          label,
          anchored: anchor.state === 'active',
          urgency: s.urgency,
        }
      })
    const compassTop = Math.max(rect.top, this.cssHeight - this.bottomInset - COMPASS_HEIGHT)
    return {
      nowServer: this.serverNow(),
      calibration: calib,
      calibrationPending: !calib,
      mode: this.mode,
      fps: this.fps,
      visionState: this.visionState,
      faces: this.faces,
      frameRect: rect,
      compass: { left: rect.left, top: compassTop, width: rect.width, height: COMPASS_HEIGHT },
      events,
      speeches,
      captions: [...this.captionBuf],
      counts: {
        events: this.events.size,
        speeches: this.speeches.size,
        mergedTimeline: this.countMergedTimeline,
        staleTimeline: this.countStaleTimeline,
        rejected: this.countRejected,
        backendRestarts: this.countBackendRestarts,
      },
      presence: this.presence,
      backend: this.backend,
      array: this.array,
      reducedMotion: this.reducedMotion,
    }
  }
}
