// On-device face + mouth tracking (MediaPipe Tasks Vision FaceLandmarker).
//
// Runs in a module worker so the 60 fps Canvas render loop is never blocked by
// inference. The main thread transfers one ImageBitmap per analyzed frame (≤10/s)
// and this side closes it after detection. Nothing leaves the device: the model
// and WASM assets are served from web/public/.

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import type { Delegate, FaceObs, WorkerRequest, WorkerResponse, WorkerScope } from './types'

const scope = self as unknown as WorkerScope
const post = (msg: WorkerResponse) => scope.postMessage(msg)

const MOUTH_OPEN_THRESHOLD = 0.25
/** Frames of history for "actively speaking": mouth open on ≥2 of the last 3. */
const HISTORY = 3
/** Normalized centre distance within which a face keeps its previous track. */
const TRACK_RADIUS = 0.2

let landmarker: FaceLandmarker | null = null
let started = false
let lastTimestampMs = 0
let delegate: Delegate = 'CPU'

/**
 * A GPU delegate is the right default, but it can land on a software rasterizer
 * (headless Chromium, a device where the worker has no usable WebGL context)
 * where it is an order of magnitude slower than plain XNNPACK CPU — measured at
 * ~1.8 s/frame here against ~15 ms on CPU. Probe once, before the landmarker
 * exists: MediaPipe's wasm module can only be initialized once per worker, so a
 * failed GPU attempt cannot be retried in place.
 */
function softwareWebgl(): boolean {
  try {
    const canvas = new OffscreenCanvas(1, 1)
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (!gl) return true
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : ''
    return /swiftshader|llvmpipe|softpipe|swrast|software/i.test(renderer)
  } catch {
    return true
  }
}

interface Track {
  cx: number
  cy: number
  open: boolean[]
}

let tracks: Track[] = []

async function createLandmarker(wasmPath: string, modelPath: string, forceCpu: boolean): Promise<void> {
  // `isModule = true` selects vision_wasm_module_internal.js, the ESM variant that
  // assigns `globalThis.ModuleFactory`. Inside a module worker the classic variant
  // cannot work: `importScripts` throws, and a module-scoped `var ModuleFactory`
  // never becomes the global MediaPipe then looks for.
  const fileset = await FilesetResolver.forVisionTasks(wasmPath, true)
  const common = {
    runningMode: 'VIDEO' as const,
    numFaces: 3,
    outputFaceBlendshapes: true,
  }
  delegate = !forceCpu && !softwareWebgl() ? 'GPU' : 'CPU'
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    ...common,
    baseOptions: { modelAssetPath: modelPath, delegate },
  })
  post({ type: 'ready', delegate })
}

function jawOpenScore(shapes: { categories: { categoryName: string; score: number }[] } | undefined): number {
  if (!shapes) return 0
  const c = shapes.categories.find((cat) => cat.categoryName === 'jawOpen')
  return c ? c.score : 0
}

interface Detection {
  cx: number
  cy: number
  face: FaceObs
}

function detect(bitmap: ImageBitmap, tMs: number): FaceObs[] {
  if (!landmarker) return []
  // detectForVideo requires strictly increasing timestamps.
  lastTimestampMs = Math.max(tMs, lastTimestampMs + 1)
  const result = landmarker.detectForVideo(bitmap, lastTimestampMs)

  const detections: Detection[] = result.faceLandmarks.map((landmarks, i) => {
    let minX = 1
    let minY = 1
    let maxX = 0
    let maxY = 0
    for (const p of landmarks) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    const jawOpen = jawOpenScore(result.faceBlendshapes[i])
    return {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      face: { box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, jawOpen, mouthActive: false },
    }
  })

  // Greedy nearest-centre association so a face keeps its mouth history across
  // frames (MediaPipe face order is not guaranteed stable).
  const nextTracks: Track[] = []
  const used = new Set<number>()
  for (const det of detections) {
    let best = -1
    let bestDist = TRACK_RADIUS
    for (let t = 0; t < tracks.length; t++) {
      if (used.has(t)) continue
      const d = Math.hypot(tracks[t].cx - det.cx, tracks[t].cy - det.cy)
      if (d < bestDist) {
        bestDist = d
        best = t
      }
    }
    const open = best >= 0 ? [...tracks[best].open] : []
    if (best >= 0) used.add(best)
    open.push(det.face.jawOpen > MOUTH_OPEN_THRESHOLD)
    while (open.length > HISTORY) open.shift()
    det.face.mouthActive = open.filter(Boolean).length >= 2
    nextTracks.push({ cx: det.cx, cy: det.cy, open })
  }
  tracks = nextTracks

  return detections.map((d) => d.face)
}

scope.onmessage = async (event: MessageEvent) => {
  const req = event.data as WorkerRequest

  if (req.type === 'init') {
    if (started) return
    started = true
    createLandmarker(req.wasmPath, req.modelPath, req.forceCpu).catch((err: unknown) => {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    })
    return
  }

  if (req.type === 'frame') {
    try {
      const detectStart = performance.now()
      const faces = detect(req.bitmap, req.tMs)
      post({ type: 'faces', tMs: req.tMs, faces, inferenceMs: performance.now() - detectStart, delegate })
    } catch (err: unknown) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      req.bitmap.close()
    }
  }
}
