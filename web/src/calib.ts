import type { Calibration } from "./types";

// Defaults mirror config/array.json (owned by member A) so the HUD renders
// sanely before the first array_status arrives. Real values come over the
// wire and overwrite this at runtime -- never edit config/array.json here.
export const DEFAULT_CALIB: Calibration = {
  baseline_m: 0.24,
  spacing_m: 0.08,
  head_yaw_offset_deg: 0.0,
  camera_fov_deg: 62.0,
  audio_delay_ms: 18.0,
};

/**
 * Hat-frame bearing -> normalized screen x in [0, 1], per README §4.5/§6.3.
 * Returns null when the bearing falls outside the camera's field of view --
 * callers must draw an edge chevron in that case, never clamp into a wrong
 * on-screen position.
 */
export function bearingToScreenX(bearingDeg: number, calib: Calibration): number | null {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const b = toRad(bearingDeg - calib.head_yaw_offset_deg);
  const halfFov = toRad(calib.camera_fov_deg / 2);
  if (Math.abs(normalizeDeg(bearingDeg - calib.head_yaw_offset_deg)) > calib.camera_fov_deg / 2) {
    return null;
  }
  const x = 0.5 * (1 + Math.tan(b) / Math.tan(halfFov));
  return x;
}

/** Inverse of bearingToScreenX: normalized screen x -> hat-frame bearing_deg. */
export function screenXToBearingDeg(xNorm: number, calib: Calibration): number {
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const halfFov = (calib.camera_fov_deg / 2) * (Math.PI / 180);
  const t = (2 * xNorm - 1) * Math.tan(halfFov);
  const b = Math.atan(t);
  return normalizeDeg(toDeg(b) + calib.head_yaw_offset_deg);
}

export function normalizeDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export interface CoverCrop {
  /** Normalized [0,1] video-space window that's actually visible on screen
   * under `object-fit: cover` -- everything outside this box is cropped off
   * entirely (unlike `contain`, nothing is ever hidden in a letterbox bar;
   * it just never reaches the canvas). w/h == 1 means no crop. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * `cover` scales the video up until it fills the canvas in both dimensions,
 * then centers and clips whatever overflows. This computes that visible
 * window in the video's own normalized coordinate space, so a raw
 * face-detection coordinate (already normalized to the full video frame)
 * can be converted into canvas-space via `videoNormToCropNorm` below before
 * it's multiplied by canvas width/height.
 */
export function computeCoverCrop(videoW: number, videoH: number, canvasW: number, canvasH: number): CoverCrop {
  if (!videoW || !videoH || !canvasW || !canvasH) return { x: 0, y: 0, w: 1, h: 1 };
  const scale = Math.max(canvasW / videoW, canvasH / videoH);
  const visibleW = canvasW / scale; // in video px
  const visibleH = canvasH / scale;
  return {
    x: (videoW - visibleW) / 2 / videoW,
    y: (videoH - visibleH) / 2 / videoH,
    w: visibleW / videoW,
    h: visibleH / videoH,
  };
}

/**
 * Full-video-normalized coordinate -> crop-normalized coordinate (the space
 * `bearingToScreenX`'s output already lives in once given the FOV-corrected
 * calibration from `effectiveFovDeg` below -- multiplying this by the
 * canvas width/height lands exactly on screen, since the crop window fills
 * the entire canvas by definition of `cover`).
 */
export function videoNormToCropNorm(vNorm: number, cropStart: number, cropSpan: number): number {
  return (vNorm - cropStart) / cropSpan;
}

/**
 * The horizontal FOV actually visible on screen once `object-fit: cover`
 * has cropped the camera feed to fill a differently-shaped container. Feed
 * the raw, uncropped `camera_fov_deg` into the bearing math and every
 * marker lands at the wrong screen position -- the visible frame covers
 * less real-world angle than the nominal FOV claims. `cropW` is a
 * `CoverCrop`'s `w` (both describe the same crop, so they must be derived
 * together -- see `computeCoverCrop`).
 */
export function effectiveFovDeg(cropW: number, cameraFovDeg: number): number {
  if (cropW >= 1) return cameraFovDeg; // no horizontal crop
  const halfFovRad = (cameraFovDeg / 2) * (Math.PI / 180);
  const effHalfFovRad = Math.atan(cropW * Math.tan(halfFovRad));
  return (effHalfFovRad * 2 * 180) / Math.PI;
}

/**
 * Front/back mirror candidate for `ambiguous:true` events. A straight linear
 * array only measures the interaural (left-right) delay, so a source at
 * bearing theta from the nose is indistinguishable from one at (180 - theta)
 * on the same left/right side. This mirror formula is our interpretation --
 * README §4 does not spell it out -- flagged as an open question in
 * web/dev/evidence.md for D/A to confirm.
 */
export function mirrorBearing(bearingDeg: number): number {
  const sign = bearingDeg >= 0 ? 1 : -1;
  return normalizeDeg(sign * 180 - bearingDeg);
}
