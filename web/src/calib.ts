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

/**
 * The horizontal FOV actually visible on screen after `object-fit: cover`
 * crops the camera feed to fill a container of a different aspect ratio --
 * e.g. a landscape-ish camera stream inside a tall phone viewport gets
 * scaled up until it fills the height, cropping a chunk off the sides. If we
 * fed the raw, uncropped `camera_fov_deg` into the bearing math in that
 * case, every marker would land at the wrong screen position (the visible
 * frame covers less real-world angle than the nominal FOV claims). Returns
 * `camera_fov_deg` unchanged when there's no horizontal crop (including
 * whenever video dimensions aren't known yet).
 */
export function effectiveFovDeg(
  videoW: number,
  videoH: number,
  canvasW: number,
  canvasH: number,
  cameraFovDeg: number
): number {
  if (!videoW || !videoH || !canvasW || !canvasH) return cameraFovDeg;
  const scale = Math.max(canvasW / videoW, canvasH / videoH);
  const displayedW = videoW * scale;
  if (displayedW <= canvasW + 0.5) return cameraFovDeg; // height-constrained or exact match: no horizontal crop
  const visibleFraction = canvasW / displayedW;
  const halfFovRad = (cameraFovDeg / 2) * (Math.PI / 180);
  const effHalfFovRad = Math.atan(visibleFraction * Math.tan(halfFovRad));
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
