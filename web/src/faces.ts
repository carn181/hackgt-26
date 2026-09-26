import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// Assets are loaded from our own origin first: `dev/sync-assets.mjs` copies the
// version-matched WASM out of node_modules into public/wasm on `npm install`, and
// public/models/face_landmarker.task is committed. That removes the runtime CDN
// dependency, which matters in a hall where 2.4 GHz is jammed (README §12). The
// CDN stays as a fallback so a checkout without node_modules still works.
const WASM_LOCAL = "/wasm";
const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_LOCAL = "/models/face_landmarker.task";
const MODEL_CDN =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const MOUTH_OPEN_THRESHOLD = 0.3;

// A held-open mouth (smiling, yawning, resting open) and an actually-talking
// mouth both cross MOUTH_OPEN_THRESHOLD; only the second one is *moving*.
// Two real speakers side by side made this visible: the bubble kept landing
// on whoever's mouth happened to be open, not whoever was talking.
//
// The first fix (rank by max-min swing within a window) was itself wrong the
// same way: a single big deliberate gape scores a *larger* range than real
// speech, which is smaller but rapid, so an exaggerated non-talking mouth
// could still outrank an actually-talking one. Talking is oscillation --
// several open/close cycles a second -- not amplitude, so count direction
// reversals (how many times the score turns from opening to closing or back)
// within the window instead of the raw high-low spread. A yawn or a single
// wide gape produces ~0-1 reversals; conversational speech produces several
// within the same window.
const MOUTH_HISTORY_MS = 700;
const MOUTH_DEADBAND = 0.04; // ignore a wobble smaller than this when detecting a direction change
const MOUTH_MIN_REVERSALS = 2; // reversals within the window to count as "talking"
const FACE_MATCH_DIST_NORM = 0.15; // max center movement (normalized) to still call it the same face

export interface DetectedFace {
  /** Normalized [0,1] bounding box, origin top-left, video-frame space. */
  bboxNorm: { x: number; y: number; w: number; h: number };
  centerXNorm: number;
  /** Instantaneous: jawOpen score is above threshold right now. */
  mouthOpen: boolean;
  mouthOpenScore: number;
  /** Temporal: the mouth has been oscillating open/closed recently -- this
   * is "talking", and what bubble-anchoring should actually key off. */
  mouthActive: boolean;
  /** Reversal count behind `mouthActive`, so callers can rank *how* actively
   * two simultaneously-active faces are talking (more reversals = more
   * speech-like), instead of only a boolean. */
  mouthActivity: number;
  /** Stable identity across frames (nearest-position matched, since
   * MediaPipe gives no persistent face id) -- lets a caller "lock onto" a
   * speaker across frames instead of re-deciding from scratch each time. */
  trackId: number;
}

interface MouthHistoryEntry {
  id: number;
  centerXNorm: number;
  centerYNorm: number;
  samples: { t: number; score: number }[];
}

let mouthHistories: MouthHistoryEntry[] = [];
let nextTrackId = 1;

/** Direction reversals (opening<->closing) in a jawOpen time series, ignoring
 * wobble smaller than MOUTH_DEADBAND so sensor noise doesn't count. */
function countReversals(samples: { t: number; score: number }[]): number {
  let reversals = 0;
  let dir = 0; // -1 closing, 0 unknown, 1 opening
  let ref = samples[0]?.score ?? 0;
  for (let i = 1; i < samples.length; i++) {
    const delta = samples[i].score - ref;
    if (Math.abs(delta) < MOUTH_DEADBAND) continue;
    const nextDir = delta > 0 ? 1 : -1;
    if (dir !== 0 && nextDir !== dir) reversals++;
    dir = nextDir;
    ref = samples[i].score;
  }
  return reversals;
}

/** Nearest-neighbor match each detected face to its history from recent
 * frames (MediaPipe gives no persistent face id), then derive `mouthActive`
 * from how many times that face's jawOpen score has actually reversed
 * direction recently -- oscillation, not amplitude. */
function withMouthActivity(
  faces: Omit<DetectedFace, "mouthActive" | "mouthActivity" | "trackId">[],
  nowMs: number
): DetectedFace[] {
  const claimed = new Set<number>();
  const nextHistories: MouthHistoryEntry[] = [];

  const result = faces.map((f) => {
    const cy = f.bboxNorm.y + f.bboxNorm.h / 2;
    let bestIdx = -1;
    let bestDist = FACE_MATCH_DIST_NORM;
    for (let i = 0; i < mouthHistories.length; i++) {
      if (claimed.has(i)) continue;
      const h = mouthHistories[i];
      const d = Math.hypot(f.centerXNorm - h.centerXNorm, cy - h.centerYNorm);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const prevSamples = bestIdx >= 0 ? mouthHistories[bestIdx].samples : [];
    const id = bestIdx >= 0 ? mouthHistories[bestIdx].id : nextTrackId++;
    if (bestIdx >= 0) claimed.add(bestIdx);

    const samples = [...prevSamples, { t: nowMs, score: f.mouthOpenScore }].filter(
      (s) => nowMs - s.t <= MOUTH_HISTORY_MS
    );
    nextHistories.push({ id, centerXNorm: f.centerXNorm, centerYNorm: cy, samples });

    const reversals = samples.length >= 3 ? countReversals(samples) : 0;

    return { ...f, mouthActive: reversals >= MOUTH_MIN_REVERSALS, mouthActivity: reversals, trackId: id };
  });

  mouthHistories = nextHistories;
  return result;
}

let landmarker: FaceLandmarker | null = null;
let initPromise: Promise<FaceLandmarker> | null = null;

export function initFaceLandmarker(): Promise<FaceLandmarker> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    for (const [wasmBase, modelUrl] of [
      [WASM_LOCAL, MODEL_LOCAL],
      [WASM_CDN, MODEL_CDN],
    ] as const) {
      try {
        const fileset = await FilesetResolver.forVisionTasks(wasmBase);
        landmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: modelUrl, delegate: "GPU" },
          runningMode: "VIDEO",
          numFaces: 4,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: false,
        });
        if (wasmBase !== WASM_LOCAL) {
          console.warn("[faces] loaded MediaPipe from the CDN; run `npm install` for offline assets");
        }
        return landmarker;
      } catch (err) {
        if (wasmBase === WASM_LOCAL) {
          console.warn("[faces] local MediaPipe assets unusable, falling back to the CDN", err);
        } else {
          throw err;
        }
      }
    }
    throw new Error("unreachable");
  })();
  return initPromise;
}

export function detectFaces(video: HTMLVideoElement, timestampMs: number): DetectedFace[] {
  if (!landmarker) return [];
  const result = landmarker.detectForVideo(video, timestampMs);
  const faces: Omit<DetectedFace, "mouthActive" | "mouthActivity" | "trackId">[] = [];

  for (let i = 0; i < result.faceLandmarks.length; i++) {
    const lm = result.faceLandmarks[i];
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const p of lm) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    let mouthOpenScore = 0;
    const blendshapes = result.faceBlendshapes?.[i]?.categories;
    if (blendshapes) {
      const jawOpen = blendshapes.find((c) => c.categoryName === "jawOpen");
      if (jawOpen) mouthOpenScore = jawOpen.score;
    }

    faces.push({
      bboxNorm: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
      centerXNorm: (minX + maxX) / 2,
      mouthOpen: mouthOpenScore > MOUTH_OPEN_THRESHOLD,
      mouthOpenScore,
    });
  }

  return withMouthActivity(faces, timestampMs);
}
