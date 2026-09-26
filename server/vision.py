"""Camera-side bearing: turn the HUD's face observations into a hat-frame angle.

The acoustic array says *when* and (roughly) *which side*. The camera says
*where* — precisely, and with a mouth-open signal that separates a person from a
loudspeaker. Since there is exactly one webcam and the browser owns it, the
backend never touches /dev/video0: the HUD (which already runs MediaPipe
FaceLandmarker) forwards normalised face boxes and the backend fuses them.

Mapping is the exact inverse of the frozen projection in `web/src/projection.ts`
(README §4.5 / §6.3):

    x = 0.5 · (1 + tan(b) / tan(fov/2)),  b = bearing − head_yaw_offset_deg
=>  bearing = atan((2x − 1) · tan(fov/2)) + head_yaw_offset_deg

`x` is the *centre* of the face box as a fraction of the camera frame width, so
the message carries the centre explicitly and the convention cannot drift.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass

log = logging.getLogger("server.vision")

# A face seen more than this long ago says nothing about the sound being
# localized right now (the HUD analyzes ~10 frames/s).
FACE_TTL_S = 0.6
# Left/right belief decays at the frame edge where the pinhole model stretches:
# the same pixel error is several degrees of angle out there.
EDGE_PENALTY_DEG = 1.5


@dataclass
class Face:
    xc: float            # box centre, 0..1 of frame width
    w: float             # box width, 0..1
    mouth: float         # jawOpen 0..1
    mouth_active: bool
    t_mono: float        # backend monotonic seconds at receipt
    bearing_deg: float = 0.0
    accuracy_deg: float = 30.0


def x_to_bearing_deg(x: float, fov_deg: float, yaw_offset_deg: float) -> float:
    """Inverse of the frozen projection (clamped to the FOV, no extrapolation)."""
    half = math.radians(max(1.0, fov_deg) / 2.0)
    x = min(max(x, 0.0), 1.0)
    b = math.atan((2.0 * x - 1.0) * math.tan(half))
    return math.degrees(b) + yaw_offset_deg


def bearing_accuracy_deg(x: float, w: float, fov_deg: float) -> float:
    """1-sigma of a camera bearing from the face-box width.

    A box occupying `w` of the frame subtends about `w · fov` degrees, and the
    box centre from a landmarker is good to a fraction of that. Edge-of-frame
    boxes get a penalty: the pinhole mapping is steepest there.
    """
    half = math.radians(max(1.0, fov_deg) / 2.0)
    deg_per_unit = math.degrees(2.0 * math.tan(half))  # ≈ fov, but exact at the centre
    sigma = max(3.0, 0.25 * max(w, 1e-3) * deg_per_unit)
    sigma += EDGE_PENALTY_DEG * abs(2.0 * x - 1.0)
    return float(min(45.0, sigma))


class VisionTracker:
    """Latest face observations, aged out, with bearing attached.

    The backend treats this as a sensor with a freshness window: a stale face
    must never anchor a sound that happened two seconds later.
    """

    def __init__(self, fov_deg: float, yaw_offset_deg: float):
        self.fov_deg = float(fov_deg)
        self.yaw_offset_deg = float(yaw_offset_deg)
        self._faces: list[Face] = []
        self.last_frame_mono = 0.0
        self.frames = 0
        self.last_error = ""

    @property
    def available(self) -> bool:
        return self.frames > 0

    def observe(self, faces: list[dict], t_mono: float) -> None:
        """Ingest one HUD `vision` frame (owner C's worker output, §4.6)."""
        out: list[Face] = []
        for f in faces or ():
            try:
                xc = float(f["xc"])
                w = float(f.get("w", 0.1))
            except (KeyError, TypeError, ValueError):
                self.last_error = f"bad face entry: {f!r}"
                continue
            mouth = float(f.get("mouth", 0.0) or 0.0)
            out.append(
                Face(
                    xc=xc,
                    w=w,
                    mouth=mouth,
                    mouth_active=bool(f.get("mouthActive", mouth > 0.25)),
                    t_mono=t_mono,
                    bearing_deg=x_to_bearing_deg(xc, self.fov_deg, self.yaw_offset_deg),
                    accuracy_deg=bearing_accuracy_deg(xc, w, self.fov_deg),
                )
            )
        self._faces = out
        self.last_frame_mono = t_mono
        self.frames += 1

    def faces(self, t_mono: float, ttl: float = FACE_TTL_S) -> list[Face]:
        if t_mono - self.last_frame_mono > ttl:
            return []
        return self._faces

    def speaking_face(self, t_mono: float, ttl: float = FACE_TTL_S) -> Face | None:
        """The face whose mouth is moving right now, if any — the person talking."""
        faces = self.faces(t_mono, ttl)
        active = [f for f in faces if f.mouth_active]
        if not active:
            return None
        # Prefer the most open mouth; ties go to the larger face (nearer).
        return max(active, key=lambda f: (f.mouth, f.w))

    def face_near(self, bearing_deg: float, t_mono: float, tol_deg: float, ttl: float = FACE_TTL_S) -> Face | None:
        """Nearest visible face to a bearing, or None outside tolerance."""
        best: Face | None = None
        best_d = tol_deg
        for f in self.faces(t_mono, ttl):
            d = abs(_wrap(f.bearing_deg - bearing_deg))
            if d < best_d:
                best, best_d = f, d
        return best

    def presence(self, t_mono: float, ttl: float = 1.0) -> bool:
        return bool(self.faces(t_mono, ttl))


def _wrap(deg: float) -> float:
    d = (deg + 180.0) % 360.0 - 180.0
    return 180.0 if d == -180.0 else d


def choose_half_space(bearing_deg: float, mirror_deg: float, face: Face, tol_deg: float) -> float | None:
    """Break the front/back tie with the camera (README §4.1 resolution (c)).

    Returns the candidate the camera supports, or None when it supports neither
    (the HUD then keeps rendering both candidates).
    """
    d0 = abs(_wrap(bearing_deg - face.bearing_deg))
    d1 = abs(_wrap(mirror_deg - face.bearing_deg))
    if min(d0, d1) > tol_deg:
        return None
    return bearing_deg if d0 <= d1 else mirror_deg
