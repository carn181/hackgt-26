// The frozen hat-frame → camera-frame mapping (README §4.5 / §6.3). Kept pure and
// separate so it can be exercised directly:
//
//   const b = toRad(bearing_deg - calib.head_yaw_offset_deg);
//   const x = 0.5 * (1 + tan(b) / tan(toRad(calib.camera_fov_deg / 2)));
//
// `x` is a fraction of the *camera frame width* (0 = left edge, 1 = right edge).
// An out-of-FOV bearing is never clamped into a false position: `inFov` is false
// and the caller draws an edge chevron instead.

import type { Calibration } from './types'

const DEG = Math.PI / 180

/** Anything the mapping needs: live `array_status.calibration` is authoritative. */
export type CalibrationView = Pick<Calibration, 'head_yaw_offset_deg' | 'camera_fov_deg'>

export interface Projection {
  /** Camera-frame width fraction. Only meaningful when `inFov`. */
  x: number
  /** Hat-frame bearing relative to the camera axis, degrees, in (-180, 180]. */
  bearing: number
  inFov: boolean
  /** Which screen edge the chevron belongs on when `!inFov`. */
  edge: 'left' | 'right'
}

/** Wrap to (-180, 180]. */
export function wrapDeg(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180
  if (d === -180) d = 180
  return d
}

export function projectBearing(bearingDeg: number, calib: CalibrationView): Projection {
  const bearing = wrapDeg(bearingDeg - calib.head_yaw_offset_deg)
  const half = (Math.max(1, calib.camera_fov_deg) / 2) * DEG
  const b = bearing * DEG
  const inFov = Math.abs(b) <= half
  // tan(half) is finite because a sane FOV is < 180°.
  const x = 0.5 * (1 + Math.tan(b) / Math.tan(half))
  return { x, bearing, inFov, edge: bearing < 0 ? 'left' : 'right' }
}

/**
 * The mirror candidate for a 1-D array: a linear array cannot separate the two
 * half-planes, so the physical mirror of bearing θ is 180° − θ. Never pick one
 * arbitrarily (README §4.5, prompt "ambiguous: true").
 */
export function mirroredBearing(bearingDeg: number): number {
  return wrapDeg(180 - bearingDeg)
}
