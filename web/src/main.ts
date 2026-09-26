import "./style.css";
import { HudState } from "./state";
import { WsClient, resolveWsUrl, type ConnState } from "./ws-client";
import { DEFAULT_CALIB, screenXToBearingDeg, normalizeDeg } from "./calib";
import { detectFaces, initFaceLandmarker, type DetectedFace } from "./faces";
import { drawOverlay, type FaceAnchor } from "./render";
import type { BackendMsg, Calibration, Mode } from "./types";

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
        break;
      case "backend_status":
        state.ingestBackendStatus(msg);
        break;
      case "timeline":
        for (const ev of msg.events) {
          if (ev.type === "sound_event") state.ingestSoundEvent(ev, nowS);
          else if (ev.type === "speech") state.ingestSpeech(ev, nowS);
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

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
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
 * FACE_MATCH_TOLERANCE_DEG of the event's bearing. Preferring mouth-active
 * faces is what separates a real speaker from a loudspeaker (README §6.3 C6):
 * a playback source has no nearby face with a moving mouth, so it falls
 * through to the "no face" / playback rendering path.
 */
const FACE_MATCH_TOLERANCE_DEG = 15;

function computeFaceAnchors(
  faces: DetectedFace[],
  calibNow: Calibration
): Map<string, FaceAnchor | null> {
  const result = new Map<string, FaceAnchor | null>();
  const faceBearings = faces.map((f) => ({ face: f, bearingDeg: screenXToBearingDeg(f.centerXNorm, calibNow) }));

  for (const [speechId, s] of state.speech) {
    const ev = state.events.get(s.parent_event);
    const targetBearing = ev ? ev.renderBearing : s.bearing_deg;
    let best: FaceAnchor | null = null;
    let bestScore = -Infinity;
    for (const fb of faceBearings) {
      const diff = Math.abs(normalizeDeg(fb.bearingDeg - targetBearing));
      if (diff > FACE_MATCH_TOLERANCE_DEG) continue;
      const score = (fb.face.mouthOpen ? 1000 : 0) - diff;
      if (score > bestScore) {
        bestScore = score;
        best = fb;
      }
    }
    result.set(speechId, best);
  }
  return result;
}

let lastFrameT = performance.now();
let fps = 0;
let faceDetectBusy = false;

async function detectFacesIfReady() {
  if (!facesReady || faceDetectBusy) return;
  faceDetectBusy = true;
  try {
    if (video.readyState >= 2) {
      latestFaces = detectFaces(video, performance.now());
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

  const renderStart = performance.now();
  const faceAnchors = computeFaceAnchors(latestFaces, calib);
  drawOverlay(ctx, canvas, {
    state,
    calib,
    faces: latestFaces,
    faceAnchors,
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
