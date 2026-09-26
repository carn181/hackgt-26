// Wire types for the backend<->frontend WebSocket contract. Frozen in
// README §4.5-4.6. Do not change field names without a README §4 edit.

export type Urgency = "low" | "normal" | "high" | "urgent";
export type Mode = "all" | "important" | "quiet";

export interface SoundEvent {
  type: "sound_event";
  id: string;
  t: number;
  class: string;
  confidence: number;
  bearing_deg: number;
  elevation_deg: number | null;
  accuracy_deg: number;
  ambiguous: boolean;
  urgency: Urgency;
  source: string;
}

export interface SpeechMsg {
  type: "speech";
  id: string;
  t: number;
  parent_event: string;
  bearing_deg: number;
  text: string;
  partial: boolean;
  confidence: number;
  lang: string;
}

export interface PresenceMsg {
  type: "presence";
  t: number;
  human: boolean;
  source: string;
}

export interface MicStatus {
  id: number;
  ok: boolean;
}

export interface Calibration {
  baseline_m: number;
  spacing_m: number;
  head_yaw_offset_deg: number;
  camera_fov_deg: number;
  /** Only present once it has been measured (README §4.5); the backend omits it. */
  audio_delay_ms?: number;
}

export interface ArrayStatus {
  type: "array_status";
  t: number;
  mics: MicStatus[];
  calibration: Calibration;
  transport: string;
}

export interface BackendStatus {
  type: "backend_status";
  t: number;
  model: string;
  model_path: string;
  model_sha256: string;
  classes: number;
  sample_rate: number;
  transport: string;
  git_rev: string;
}

export interface TimelineMsg {
  type: "timeline";
  t: number;
  events: (SoundEvent | SpeechMsg)[];
}

export interface PongMsg {
  type: "pong";
  t: number;
  t_echo: number;
}

export type BackendMsg =
  | SoundEvent
  | SpeechMsg
  | PresenceMsg
  | ArrayStatus
  | BackendStatus
  | TimelineMsg
  | PongMsg;

export interface SetModeMsg {
  type: "set_mode";
  mode: Mode;
}

export interface PingMsg {
  type: "ping";
  t: number;
}

/**
 * §4.6 `vision` (additive): the face boxes this page already computes, so the
 * backend can turn a face into a hat-frame bearing. `xc` is the box **centre** as
 * a fraction of the camera frame width — the exact inverse of the projection in
 * calib.ts — and `mouth` is the MediaPipe jaw-open score. A face whose mouth is
 * moving is taken as the source of a speech-like sound; any visible face can
 * break a linear array's front/back tie. Frames are aged out after 0.6 s.
 */
export interface VisionFaceMsg {
  xc: number;
  w: number;
  mouth: number;
  mouthActive: boolean;
}

export interface VisionMsg {
  type: "vision";
  t: number;
  faces: VisionFaceMsg[];
}

/**
 * §4.6 `audio` (additive): the page's own microphone, one 20 ms frame of 16 kHz
 * mono PCM16 per message (base64 in JSON). The backend validates rate, channel
 * count and format against the live profile and drops mismatched frames, so this
 * cannot silently become a different array. Run the backend with
 * `--profile browser_mono --source browser` to use it.
 */
export interface AudioMsg {
  type: "audio";
  t: number;
  rate: number;
  channels: number;
  format: "pcm16";
  seq: number;
  data: string;
}

export type FrontendMsg = SetModeMsg | PingMsg | VisionMsg | AudioMsg;
