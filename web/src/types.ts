// Types for the frozen backend contract (README §4.5 backend → frontend, §4.6
// frontend → backend). These mirror the wire format exactly; nothing here may
// invent fields. `elevation_deg` stays `null` until the backend actually
// provides it.

export type Urgency = 'low' | 'normal' | 'high' | 'urgent'

/** Notification volume, sent to the backend as §4.6 `set_mode`. */
export type Mode = 'all' | 'important' | 'quiet'

export interface SoundEventMsg {
  type: 'sound_event'
  id: string
  t: number
  class: string
  confidence: number
  bearing_deg: number
  elevation_deg: number | null
  accuracy_deg: number
  ambiguous: boolean
  urgency: Urgency
  source?: string
}

export interface SpeechMsg {
  type: 'speech'
  id: string
  t: number
  parent_event?: string
  bearing_deg: number
  text: string
  partial: boolean
  confidence: number
  lang?: string
}

export interface PresenceMsg {
  type: 'presence'
  t: number
  human: boolean
  source?: string
}

export interface MicState {
  id: number
  ok: boolean
}

export interface Calibration {
  baseline_m: number
  spacing_m: number
  head_yaw_offset_deg: number
  camera_fov_deg: number
  /** Only present once member D has measured it (README §7.2.5). */
  audio_delay_ms?: number
}

export interface ArrayStatusMsg {
  type: 'array_status'
  t: number
  mics: MicState[]
  calibration: Calibration
  transport?: string
}

export interface BackendStatusMsg {
  type: 'backend_status'
  t: number
  model: string
  model_path?: string
  model_sha256: string
  classes?: number
  sample_rate?: number
  transport?: string
  git_rev?: string
}

export interface TimelineMsg {
  type: 'timeline'
  t: number
  events: Array<SoundEventMsg | SpeechMsg>
}

export type BackendMsg =
  | SoundEventMsg
  | SpeechMsg
  | PresenceMsg
  | ArrayStatusMsg
  | BackendStatusMsg
  | TimelineMsg

export interface SetModeMsg {
  type: 'set_mode'
  mode: Mode
}

export interface PingMsg {
  type: 'ping'
  t: number
}

/**
 * One face as the backend wants it (README §4.6, additive to the frozen
 * contract). `xc` is the box **centre** as a fraction of the camera frame width
 * — the exact inverse of `projection.ts`'s `x` — so the backend can turn a face
 * into a hat-frame bearing. `mouth` is MediaPipe `jawOpen`.
 *
 * This exists because there is exactly one webcam and this page owns it: the
 * backend cannot open `/dev/video0` while the HUD is streaming, so the HUD is
 * the camera's transport. Fields are computed locally and are never trusted for
 * anything except a bearing.
 */
export interface VisionFaceMsg {
  xc: number
  w: number
  mouth: number
  mouthActive: boolean
}

export interface VisionMsg {
  type: 'vision'
  t: number
  faces: VisionFaceMsg[]
}

/**
 * §4.6 `audio` (additive): the HUD's own microphone, so the phone can be the
 * sensor when the laptop's mics are the weak part of the demo. One frame = one
 * 20 ms chunk of 16 kHz mono PCM16, base64 in JSON; the backend validates rate,
 * channel count and format against the live profile and drops anything else.
 */
export interface AudioMsg {
  type: 'audio'
  t: number
  rate: number
  channels: number
  format: 'pcm16'
  seq: number
  data: string
}

export type ClientMsg = SetModeMsg | PingMsg | VisionMsg | AudioMsg

// ---------------------------------------------------------------------------
// Face tracking (on-device, worker-side). Local to the app: never on the wire.
// ---------------------------------------------------------------------------

/** Normalized to the camera frame, same space as the projected bearing x. */
export interface FaceBox {
  x: number
  y: number
  w: number
  h: number
}

export interface FaceObs {
  box: FaceBox
  jawOpen: number
  /** jawOpen > 0.25 on at least two of the last three analyzed frames. */
  mouthActive: boolean
}

export interface FaceFrame {
  tMs: number
  faces: FaceObs[]
}

export type VisionState = 'off' | 'loading' | 'ready' | 'unavailable'

export type WorkerRequest =
  | { type: 'init'; wasmPath: string; modelPath: string; forceCpu: boolean }
  | { type: 'frame'; bitmap: ImageBitmap; tMs: number }

export type Delegate = 'GPU' | 'CPU'

export type WorkerResponse =
  | { type: 'ready'; delegate: Delegate }
  | { type: 'faces'; tMs: number; faces: FaceObs[]; inferenceMs: number; delegate: Delegate }
  | { type: 'error'; message: string }

/**
 * The module worker's own scope surface. Declared locally so the worker file
 * type-checks under the DOM lib (a second `WebWorker` lib in the same program
 * only produces duplicate-global noise).
 */
export interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent) => void) | null
}
