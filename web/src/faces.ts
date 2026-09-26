import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
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
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 4,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    });
    return landmarker;
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
