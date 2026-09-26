import "./style.css";
import { HudState } from "./state";
import { WsClient, resolveWsUrl, type ConnState } from "./ws-client";
import {
  computeCoverCrop,
  DEFAULT_CALIB,
  effectiveFovDeg,
  screenXToBearingDeg,
  normalizeDeg,
  videoNormToCropNorm,
} from "./calib";
import { detectFaces, initFaceLandmarker, type DetectedFace } from "./faces";
import { drawOverlay, type FaceAnchor } from "./render";
import { MicStream } from "./mic";
import { OrientationTracker } from "./orientation";
import type { BackendMsg, Calibration, Mode } from "./types";
import { validateBackendMsg } from "./validate";

const video = document.getElementById("cam") as HTMLVideoElement;
const canvas = document.getElementById("overlay") as HTMLCanvasElement;
const banner = document.getElementById("banner") as HTMLDivElement;
const ctx = canvas.getContext("2d")!;

const state = new HudState();
let calib: Calibration = { ...DEFAULT_CALIB };
let wsState: ConnState = "connecting";
let rttMs: number | null = null;
let facesReady = false;
let latestFaces: DetectedFace[] = [];
let addedLatencyMs: number | null = null;

const bannerReasons = { camera: null as string | null, ws: null as string | null };

function renderBanner() {
  const text = bannerReasons.camera ?? bannerReasons.ws;
  if (!text) {
    banner.classList.add("hidden");
    banner.textContent = "";
  } else {
    banner.classList.remove("hidden");
    banner.textContent = text;
  }
}

function setCameraBanner(text: string | null) {
  bannerReasons.camera = text;
  renderBanner();
}

function updateBanner() {
  bannerReasons.ws =
    wsState === "open" ? null : wsState === "connecting" ? "connecting to backend..." : "no backend — retrying";
  renderBanner();
}

const ws = new WsClient({
  url: resolveWsUrl(),
  onStateChange: (s) => {
    wsState = s;
    updateBanner();
  },
  onRttSample: (ms) => {
    rttMs = ms;
  },
  onMessage: (msg: BackendMsg) => {
    const nowS = performance.now() / 1000;
    switch (msg.type) {
      case "sound_event":
        state.ingestSoundEvent(msg, nowS);
        break;
      case "speech":
        state.ingestSpeech(msg, nowS);
        break;
      case "array_status":
        state.ingestArrayStatus(msg);
        calib = { ...msg.calibration };
        // This is the last known-good head_yaw_offset_deg; the orientation
        // tracker should only contribute rotation *since* this moment, not
        // fight with whatever it accumulated before it.
        orientation.resetReference();
        break;
      case "backend_status":
        state.ingestBackendStatus(msg);
        break;
      case "timeline":
        for (const ev of msg.events) {
          // Each array element only gets the top-level `events` array itself
          // checked by validateBackendMsg, not each entry -- re-validate here
          // so one bad replay entry can't crash the render loop.
          const validated = validateBackendMsg(ev);
          if (!validated) {
            console.warn("[ws] dropped malformed timeline entry", ev);
            continue;
          }
          if (validated.msg.type === "sound_event") state.ingestSoundEvent(validated.msg, nowS);
          else if (validated.msg.type === "speech") state.ingestSpeech(validated.msg, nowS);
        }
        break;
      case "presence":
        break; // not rendered yet; reserved for a future presence indicator
    }
  },
});
ws.start();
updateBanner();

for (const btn of document.querySelectorAll<HTMLButtonElement>(".mode-btn")) {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode as Mode;
    state.setMode(mode);
    ws.send({ type: "set_mode", mode });
    document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
}

// ---------------------------------------------------------------------------
// Microphone (§4.6 `audio`) — ON by default
// ---------------------------------------------------------------------------
// The backend's default source is this page's microphone (`--profile browser_mono
// --source browser`), so a phone becomes the sensor just by opening the URL. Why:
// the laptop's DMIC pair is a poor array (no inter-channel baseline, and channel 1
// carries a DC offset and a sub-100 Hz rumble 31 dB above channel 0's), while a
// phone is not attached to the chassis — a clap reaches it as airborne sound
// instead of a structural thump.
//
// `?mic=0` turns it off. getUserMedia needs a secure context and, on iOS, a
// gesture, so the button is also the retry path.
const mic = new MicStream();
const micBtn = document.getElementById("mic-btn") as HTMLButtonElement;
const micWanted = new URLSearchParams(window.location.search).get("mic") !== "0";

function paintMicButton() {
  const s = mic.status;
  micBtn.classList.toggle("active", s.state === "running");
  micBtn.classList.toggle("error", s.state === "error");
  micBtn.textContent =
    s.state === "running" ? `mic ${s.seconds.toFixed(0)}s` : s.state === "starting" ? "mic..." : "mic";
  micBtn.title =
    s.state === "error" ? `microphone: ${s.lastError}` : "Stream this device's microphone to the backend (§4.6 audio)";
}

mic.onStatus = () => paintMicButton();
paintMicButton();

function startMic() {
  void mic.start((base64, seq, rate, channels) => {
    ws.send({ type: "audio", t: performance.now() / 1000, rate, channels, format: "pcm16", seq, data: base64 });
  });
}

micBtn.addEventListener("click", () => {
  if (mic.status.state === "running") {
    mic.stop();
    paintMicButton();
    return;
  }
  startMic();
});

if (micWanted) startMic();

// ---------------------------------------------------------------------------
// Phone orientation -> a live head_yaw_offset_deg correction
// ---------------------------------------------------------------------------
// Opt-in (unlike the mic): iOS requires a tap to grant sensor permission at
// all, so there's no auto-start path to mirror there, and requiring the same
// explicit tap on every platform keeps the behavior consistent. Nothing here
// touches the laptop path -- `start()` resolves to "unsupported" wherever
// there's no orientation sensor, and yawDeltaDeg() is 0 whenever the tracker
// isn't running, so calib.head_yaw_offset_deg is exactly what it always was.
const orientation = new OrientationTracker();
const orientBtn = document.getElementById("orient-btn") as HTMLButtonElement;

function paintOrientButton() {
  const s = orientation.status;
  orientBtn.classList.toggle("active", s.state === "running");
  orientBtn.classList.toggle("error", s.state === "error" || s.state === "unsupported");
  orientBtn.textContent =
    s.state === "running" ? `imu ${s.deltaDeg.toFixed(0)}°` : s.state === "starting" ? "imu..." : "imu";
  orientBtn.title =
    s.state === "error"
      ? `orientation: ${s.lastError}`
      : s.state === "unsupported"
        ? "orientation: not available on this device"
        : "Use the phone's orientation sensor to pan bearings as you turn (needs a tap to grant permission)";
}

orientation.onStatus = () => paintOrientButton();
paintOrientButton();

orientBtn.addEventListener("click", () => {
  if (orientation.status.state === "running") {
    orientation.stop();
    paintOrientButton();
    return;
  }
  void orientation.start();
});

async function startCamera() {
  try {
    // Deliberately no width/height/aspectRatio constraints: asking for a
    // specific (especially a tall-portrait) aspect ratio can push some
    // phone cameras into a hardware-level crop/zoom to manufacture that
    // ratio -- that was the actual cause of an earlier "too zoomed in, not
    // natural 1x" bug. Plain facingMode gets whatever the camera's default
    // (true 1x) mode is; object-fit: cover (style.css) then fills the
    // screen with it edge-to-edge like a normal camera viewfinder, and
    // whatever that crops is compensated for in the bearing math below
    // instead (effectiveFovDeg), not avoided.
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    // Non-fatal: keep the WS connection, debug panel and render loop alive
    // even without a camera, so the HUD is still inspectable/testable.
    setCameraBanner(`camera error: ${(err as Error).message}`);
    console.warn("camera unavailable", err);
  }
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);

/**
 * Nearest-face matching for each active speech bubble. A face "claims" a
 * speech event when its bearing (derived from screen position) is within
 * FACE_MATCH_TOLERANCE_DEG of the event's bearing -- but only when that
 * bearing is actually trustworthy (small accuracy_deg; a real camera- or
 * array-derived fix). Most segments right now come back with no usable
 * bearing at all (source: "none", accuracy_deg: 180 -- one mono mic can't
 * localize), which used to fall through to an unanchored bubble that landed
 * wherever bearing 0° maps to: dead center between two people, which read as
 * "it defaults to the center". That case now falls back to whichever face is
 * the current "locked" speaker instead (see pickCurrentSpeaker below).
 */
const FACE_MATCH_TOLERANCE_DEG = 15;
const BEARING_TRUST_MAX_ACCURACY_DEG = 30;

// How long a face has to be the clearest talker before the lock actually
// switches to them, and how long the lock survives with nobody confirming
// it. Two real people talking back and forth showed why both matter: without
// the switch delay, one person's mouth flickering mid-sentence while the
// other listens (a reactive smile, starting to interject) could steal the
// bubble away from whoever the transcript actually belongs to; without the
// grace period, an ordinary conversational pause (a breath, "um") looked
// exactly like "nobody is the speaker anymore".
const LOCK_SWITCH_MS = 450;
const LOCK_GRACE_MS = 2500;

let lockedSpeakerTrackId: number | null = null;
let lockedSpeakerLastActiveMs = 0;
let candidateSpeakerTrackId: number | null = null;
let candidateSpeakerSinceMs = 0;

/** Debounced "who is talking right now" across frames, by stable trackId. */
function pickCurrentSpeaker(faces: DetectedFace[], nowMs: number): number | null {
  let top: DetectedFace | null = null;
  for (const f of faces) {
    if (!f.mouthActive) continue;
    if (!top || f.mouthActivity > top.mouthActivity) top = f;
  }

  if (top) {
    if (top.trackId === lockedSpeakerTrackId) {
      lockedSpeakerLastActiveMs = nowMs;
    } else {
      if (top.trackId !== candidateSpeakerTrackId) {
        candidateSpeakerTrackId = top.trackId;
        candidateSpeakerSinceMs = nowMs;
      }
      if (lockedSpeakerTrackId === null || nowMs - candidateSpeakerSinceMs >= LOCK_SWITCH_MS) {
        lockedSpeakerTrackId = top.trackId;
        lockedSpeakerLastActiveMs = nowMs;
      }
    }
  }

  if (lockedSpeakerTrackId !== null && nowMs - lockedSpeakerLastActiveMs > LOCK_GRACE_MS) {
    lockedSpeakerTrackId = null;
  }

  return lockedSpeakerTrackId;
}

function computeFaceAnchors(
  faces: DetectedFace[],
  calibNow: Calibration
): Map<string, FaceAnchor | null> {
  const result = new Map<string, FaceAnchor | null>();
  const lockedTrackId = pickCurrentSpeaker(faces, performance.now());
  const faceBearings = faces.map((f) => ({ face: f, bearingDeg: screenXToBearingDeg(f.centerXNorm, calibNow) }));

  for (const [speechId, s] of state.speech) {
    const ev = state.events.get(s.parent_event);
    let chosen: FaceAnchor | null = null;

    if (ev && ev.accuracy_deg <= BEARING_TRUST_MAX_ACCURACY_DEG) {
      let bestDiff = FACE_MATCH_TOLERANCE_DEG;
      for (const fb of faceBearings) {
        const diff = Math.abs(normalizeDeg(fb.bearingDeg - ev.renderBearing));
        if (diff < bestDiff) {
          bestDiff = diff;
          chosen = fb;
        }
      }
    }

    if (!chosen && lockedTrackId !== null) {
      chosen = faceBearings.find((fb) => fb.face.trackId === lockedTrackId) ?? null;
    }

    result.set(speechId, chosen);
  }
  return result;
}

let lastFrameT = performance.now();
let fps = 0;
let faceDetectBusy = false;
let lastVisionSentMs = 0;

async function detectFacesIfReady() {
  if (!facesReady || faceDetectBusy) return;
  faceDetectBusy = true;
  try {
    if (video.readyState >= 2) {
      latestFaces = detectFaces(video, performance.now());
      // §4.6 `vision`: hand the backend the boxes this page already computed, so
      // it can produce a camera-backed bearing (there is one webcam and this page
      // owns it). Throttled to 10 Hz — the backend ages frames out after 0.6 s,
      // so faster would only be traffic.
      //
      // `xc`/`w` must be in on-screen (crop-normalized) space, not raw video
      // space: the backend's inverse projection (README §4.6) assumes `xc` is
      // the face's fraction of the *visible* camera frame, matching what a
      // person looking at the HUD actually sees. object-fit: cover crops the
      // raw video before it reaches the screen, so the two disagree whenever
      // there's real cropping (common on a phone) -- sending the raw
      // coordinate here was silently feeding the backend a wrong bearing
      // whenever that happened, independent of the client's own rendering
      // (which already goes through this same correction, see frame() below).
      const nowMs = performance.now();
      if (nowMs - lastVisionSentMs >= 100) {
        lastVisionSentMs = nowMs;
        const crop = computeCoverCrop(video.videoWidth, video.videoHeight, canvas.clientWidth, canvas.clientHeight);
        ws.send({
          type: "vision",
          t: nowMs / 1000,
          faces: latestFaces.map((f) => ({
            xc: videoNormToCropNorm(f.centerXNorm, crop.x, crop.w),
            w: f.bboxNorm.w / crop.w,
            mouth: f.mouthOpenScore,
            mouthActive: f.mouthActive,
          })),
        });
      }
    }
  } finally {
    faceDetectBusy = false;
  }
}

function frame() {
  const now = performance.now();
  const dtS = (now - lastFrameT) / 1000;
  lastFrameT = now;
  fps = fps === 0 ? 1 / dtS : fps * 0.9 + 0.1 * (1 / dtS);

  state.tick(now / 1000, dtS);
  void detectFacesIfReady();

  // Recomputed every frame: depends on the video's decoded size (only known
  // once metadata loads) and the canvas's current CSS size (changes on
  // resize/orientation change). object-fit: cover crops the video to fill
  // the canvas, so two separate corrections are needed, both derived from
  // the same crop window to stay consistent with each other:
  const crop = computeCoverCrop(video.videoWidth, video.videoHeight, canvas.clientWidth, canvas.clientHeight);
  // 1. Bearing math needs the narrower, actually-visible FOV, or markers
  //    land at the wrong screen position.
  // 2. The phone's own rotation since the last calibration moment, if the
  //    orientation tracker is running -- 0 otherwise, so this is a no-op
  //    everywhere it isn't explicitly turned on.
  const renderCalib: Calibration = {
    ...calib,
    camera_fov_deg: effectiveFovDeg(crop.w, calib.camera_fov_deg),
    head_yaw_offset_deg: calib.head_yaw_offset_deg + orientation.yawDeltaDeg(),
  };
  // 3. Raw face-detection coordinates are normalized to the *full* video
  //    frame, not the cropped, on-screen portion of it -- remap once here
  //    so drawing code and the face->bearing match below can both just
  //    treat them as plain canvas-normalized coordinates, same as before.
  const facesOnScreen = latestFaces.map((f) => ({
    ...f,
    bboxNorm: {
      x: videoNormToCropNorm(f.bboxNorm.x, crop.x, crop.w),
      y: videoNormToCropNorm(f.bboxNorm.y, crop.y, crop.h),
      w: f.bboxNorm.w / crop.w,
      h: f.bboxNorm.h / crop.h,
    },
    centerXNorm: videoNormToCropNorm(f.centerXNorm, crop.x, crop.w),
  }));

  const renderStart = performance.now();
  const faceAnchors = computeFaceAnchors(facesOnScreen, renderCalib);
  drawOverlay(ctx, canvas, {
    state,
    calib: renderCalib,
    faces: facesOnScreen,
    faceAnchors,
    lockedSpeakerTrackId,
    orientationStatus: orientation.status,
    wsState,
    rttMs,
    fps,
    addedLatencyMs,
  });
  addedLatencyMs = performance.now() - renderStart;

  requestAnimationFrame(frame);
}

(async () => {
  resizeCanvas();
  await startCamera();
  try {
    await initFaceLandmarker();
    facesReady = true;
  } catch (err) {
    console.warn("face landmarker failed to load; bubbles will render without face anchoring", err);
  }
  requestAnimationFrame(frame);
})();

// Read-only introspection, used by docs/backend-evidence.md runs and by the
// camera-FOV calibration measurement (`window.__hud.faces()`).
Object.defineProperty(window, "__hud", {
  value: {
    ws: () => ({ state: wsState, rttMs }),
    mic: () => mic.status,
    orientation: () => orientation.status,
    faces: () => latestFaces,
    calib: () => calib,
    fps: () => fps,
  },
});
