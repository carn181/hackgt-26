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

export interface DetectedFace {
  /** Normalized [0,1] bounding box, origin top-left, video-frame space. */
  bboxNorm: { x: number; y: number; w: number; h: number };
  centerXNorm: number;
  mouthOpen: boolean;
  mouthOpenScore: number;
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
  const faces: DetectedFace[] = [];

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

  return faces;
}
