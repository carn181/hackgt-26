// Main-thread host for the FaceLandmarker worker: frame pump at ≤10 analyzed
// frames/s, ImageBitmap transfer, graceful degradation when the model or worker
// cannot load (the HUD then shows unanchored captions and never claims a match).

import type { Delegate, FaceObs, VisionState, WorkerRequest, WorkerResponse } from './types'

const WASM_PATH = '/wasm'
const MODEL_PATH = '/models/face_landmarker.task'
/** Analysis cadence: 10 frames/s is plenty for a speech-present signal. */
const PUMP_INTERVAL_MS = 100
const MAX_INFLIGHT = 2
const MAX_RESIZE_WIDTH = 640
const FAILURES_BEFORE_GIVING_UP = 6

export interface VisionStatus {
  state: VisionState
  delegate: Delegate | null
  lastError: string
  analyzedFrames: number
  analyzedFps: number
  /** Mean inference time of the recent analyzed frames, ms. */
  inferenceMs: number | null
  inflight: number
}

export class VisionHost {
  status: VisionStatus = {
    state: 'off',
    delegate: null,
    lastError: '',
    analyzedFrames: 0,
    analyzedFps: 0,
    inferenceMs: null,
    inflight: 0,
  }
  /** Latest analyzed frame's faces; empty when tracking runs but sees nobody. */
  faces: FaceObs[] = []
  onStatus: (status: VisionStatus) => void = () => {}

  private worker: Worker | null = null
  private video: HTMLVideoElement | null = null
  private timer: number | null = null
  private inflight = 0
  private consecutiveFailures = 0
  private analyzedTimes: number[] = []
  private inferenceTimes: number[] = []
  private retriedOnCpu = false

  start(video: HTMLVideoElement): void {
    if (this.worker || this.status.state === 'unavailable') return
    this.video = video
    this.spawnWorker(false)
  }

  private spawnWorker(forceCpu: boolean): void {
    this.setStatus({ state: 'loading', lastError: '' })
    try {
      this.worker = new Worker(new URL('./vision.worker.ts', import.meta.url), { type: 'module' })
    } catch (err) {
      this.giveUp(`worker could not start: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    this.worker.onmessage = (event: MessageEvent) => this.handleMessage(event.data as WorkerResponse)
    this.worker.onerror = (event) => this.retryOnCpu(`worker error: ${event.message || 'unknown'}`)
    const init: WorkerRequest = { type: 'init', wasmPath: WASM_PATH, modelPath: MODEL_PATH, forceCpu }
    this.worker.postMessage(init)
    if (this.timer === null) this.timer = window.setInterval(() => void this.pump(), PUMP_INTERVAL_MS)
  }

  /**
   * MediaPipe's wasm module can only be initialized once per worker, so a failure
   * during init means restarting the worker — once, on CPU.
   */
  private retryOnCpu(message: string): void {
    if (this.retriedOnCpu) {
      this.giveUp(message)
      return
    }
    this.retriedOnCpu = true
    this.worker?.terminate()
    this.worker = null
    this.faces = []
    this.spawnWorker(true)
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    this.worker?.terminate()
    this.worker = null
    this.faces = []
    this.setStatus({ state: 'off' })
  }

  private handleMessage(msg: WorkerResponse): void {
    this.inflight = Math.max(0, this.inflight - 1)
    this.setStatus({ inflight: this.inflight })
    if (msg.type === 'ready') {
      this.setStatus({ state: 'ready', delegate: msg.delegate, lastError: '' })
      return
    }
    if (msg.type === 'faces') {
      this.faces = msg.faces
      this.analyzedTimes.push(performance.now())
      while (this.analyzedTimes.length > 40) this.analyzedTimes.shift()
      const span = (this.analyzedTimes[this.analyzedTimes.length - 1] - this.analyzedTimes[0]) / 1000
      this.inferenceTimes.push(msg.inferenceMs)
      while (this.inferenceTimes.length > 20) this.inferenceTimes.shift()
      this.setStatus({
        delegate: msg.delegate,
        analyzedFrames: this.status.analyzedFrames + 1,
        analyzedFps: span > 0 ? (this.analyzedTimes.length - 1) / span : 0,
        inferenceMs: this.inferenceTimes.reduce((a, b) => a + b, 0) / this.inferenceTimes.length,
      })
      return
    }
    this.retryOnCpu(msg.message)
  }

  private async pump(): Promise<void> {
    const video = this.video
    if (!this.worker || this.status.state !== 'ready' || !video || video.readyState < 2) return
    if (this.inflight >= MAX_INFLIGHT) return
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return
    const width = Math.min(MAX_RESIZE_WIDTH, vw)
    const height = Math.max(1, Math.round((width / vw) * vh))
    this.inflight += 1
    try {
      const bitmap = await createImageBitmap(video, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' })
      this.consecutiveFailures = 0
      const req: WorkerRequest = { type: 'frame', bitmap, tMs: Math.round(performance.now()) }
      // Transferred, then closed by the worker after inference.
      this.worker.postMessage(req, [bitmap])
      this.setStatus({ inflight: this.inflight })
    } catch (err) {
      this.inflight = Math.max(0, this.inflight - 1)
      this.consecutiveFailures += 1
      if (this.consecutiveFailures >= FAILURES_BEFORE_GIVING_UP) {
        this.giveUp(`frame capture failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private giveUp(message: string): void {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    this.worker?.terminate()
    this.worker = null
    this.faces = []
    this.setStatus({ state: 'unavailable', lastError: message, delegate: null })
  }

  private setStatus(patch: Partial<VisionStatus>): void {
    this.status = { ...this.status, ...patch }
    this.onStatus(this.status)
  }
}
