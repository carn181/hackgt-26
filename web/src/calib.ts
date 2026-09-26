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

export interface VideoRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the video is actually drawn within the canvas under
 * `object-fit: contain` (uniform scale-to-fit, centered -- never crops, so
 * the camera's full nominal FOV is always genuinely on screen; the tradeoff
 * is letterbox bars instead of a crop/zoom, which is the whole point: no
 * hidden magnification, "natural 1x"). Bearing math itself
 * (bearingToScreenX/screenXToBearingDeg) stays video-relative and needs no
 * changes for this -- only code that converts a video-normalized coordinate
 * into an actual canvas pixel (drawing a face box, a bubble anchor, or an
 * in-frame marker) needs to go through this rect instead of the raw canvas
 * size, or it'll place things inside a letterbox bar instead of on the
 * video content.
 */
export function computeContainRect(videoW: number, videoH: number, canvasW: number, canvasH: number): VideoRect {
  if (!videoW || !videoH || !canvasW || !canvasH) return { x: 0, y: 0, w: canvasW, h: canvasH };
  const scale = Math.min(canvasW / videoW, canvasH / videoH);
  const w = videoW * scale;
  const h = videoH * scale;
  return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h };
}

export function videoXToCanvasX(xNorm: number, rect: VideoRect): number {
  return rect.x + xNorm * rect.w;
}

export function videoYToCanvasY(yNorm: number, rect: VideoRect): number {
  return rect.y + yNorm * rect.h;
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
