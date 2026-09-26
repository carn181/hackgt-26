"""Array geometry and calibration loading (README §4.7, §7.2).

`config/array.json` (the hat, owner A) is the single source of truth for the
deployed array. `config/calib.json` (owner D) overlays measured numbers on top
of it. `server/profiles/*.json` describes a **stand-in** array in exactly the
same shape, so ingest, DOA, fusion and the WS service stay geometry-agnostic:
today the stand-in is this laptop's 2-channel DMIC pair, and swapping in the
4-mic bar is a `--profile` flag, nothing else.

Bearing convention (frozen, README §4.1): 0° = the wearer's nose, positive =
clockwise seen from above = toward the wearer's right. Hat frame is +x right,
+y nose, +z up (README §4.7 note in `array.json`).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np

log = logging.getLogger("server.config")

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = REPO_ROOT / "config"
PROFILE_DIR = Path(__file__).resolve().parent / "profiles"

HAT_PROFILE = "hat"


@dataclass(frozen=True)
class Mic:
    """One physical microphone in the hat frame, metres."""

    id: int
    x: float
    y: float
    z: float


@dataclass(frozen=True)
class Profile:
    """A capture array: geometry, channel order, and what we actually know.

    `channels[i]` is the device channel index that carries mic `mics[i]`.
    `calibrated` is True only when the delay-to-angle scale came from a
    measurement rather than from CAD or a guess — it decides how honest
    `accuracy_deg` has to be (README §4.1: never report a 40° error as 5°).
    """

    name: str
    transport: str
    rate_hz: int
    layout: str
    mics: tuple[Mic, ...]
    channels: tuple[int, ...]
    spacing_m: float | None
    baseline_m: float | None
    head_yaw_offset_deg: float
    camera_fov_deg: float
    calibrated: bool
    uncalibrated_accuracy_deg: float
    front_back_heuristic: bool
    highpass_hz: float = 120.0
    lowpass_hz: float = 6000.0
    analysis_channels: tuple[int, ...] | None = None
    device: str | None = None
    audio_delay_ms: float | None = None
    notes: tuple[str, ...] = ()

    # -- geometry helpers -------------------------------------------------
    @property
    def nch(self) -> int:
        return len(self.channels)

    @property
    def mic_x(self) -> np.ndarray:
        return np.array([m.x for m in self.mics], dtype=np.float64)

    def pairs(self) -> list[tuple[int, int, float]]:
        """All mic pairs as (i, j, dx) with dx = x_i - x_j in metres.

        Signs follow the DOA derivation in `server/doa.py`: for a plane wave at
        azimuth θ the arrival-time difference is τ_i - τ_j = (x_j - x_i)·sinθ/c,
        so a positive dx with a positive measured lag means θ > 0 (right).
        """
        xs = self.mic_x
        return [
            (i, j, float(xs[i] - xs[j]))
            for i in range(self.nch)
            for j in range(i + 1, self.nch)
            if abs(xs[i] - xs[j]) > 1e-9
        ]

    def summary(self) -> str:
        sp = "uncalibrated" if self.spacing_m is None else f"{self.spacing_m * 1000:.1f} mm"
        base = "?" if self.baseline_m is None else f"{self.baseline_m * 1000:.0f} mm"
        return (
            f"profile={self.name} transport={self.transport} rate={self.rate_hz} "
            f"mics={self.nch} spacing={sp} baseline={base} "
            f"calibrated={self.calibrated} yaw_offset={self.head_yaw_offset_deg:.1f}° "
            f"fov={self.camera_fov_deg:.1f}°"
        )


def _num(value: object) -> float | None:
    """JSON number or None. Never coerces null/strings into a fake geometry."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    f = float(value)
    return f if np.isfinite(f) else None


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def _profile_from_hat(array_path: Path, calib_path: Path | None) -> Profile:
    arr = _read_json(array_path)
    calib: dict = {}
    if calib_path is not None and calib_path.exists():
        try:
            calib = _read_json(calib_path)
        except json.JSONDecodeError as exc:  # a half-written calib must not kill the demo
            log.warning("calib.json unreadable (%s) — continuing uncalibrated", exc)

    mics = tuple(
        Mic(id=int(m["id"]), x=float(m["x"]), y=float(m["y"]), z=float(m["z"]))
        for m in arr["mics"]
    )
    channels = tuple(range(len(mics)))  # hat packets are channel-major in mic-id order (§4.2)

    # Measured values win; CAD/JSON defaults are the fallback (README §7.2).
    spacing = _num(calib.get("spacing_m"))
    calibrated = spacing is not None
    if spacing is None:
        spacing = _num(arr.get("spacing_m"))
    baseline = _num(calib.get("baseline_m")) or _num(arr.get("baseline_m"))
    yaw = _num(calib.get("head_yaw_offset_deg"))
    if yaw is None:
        yaw = _num(arr.get("head_yaw_offset_deg")) or 0.0
    fov = _num(calib.get("camera_fov_deg")) or _num(arr.get("camera_fov_deg")) or 62.0
    delay = _num(calib.get("audio_delay_ms"))

    return Profile(
        name=HAT_PROFILE,
        transport="udp",
        rate_hz=int(arr.get("rate_hz", 16000)),
        layout=str(arr.get("layout", "line")),
        mics=mics,
        channels=channels,
        spacing_m=spacing,
        baseline_m=baseline,
        head_yaw_offset_deg=yaw,
        camera_fov_deg=fov,
        calibrated=calibrated,
        uncalibrated_accuracy_deg=18.0,
        # Head shadow only works when the head is actually between the mics and
        # the source — true on the hat, meaningless on a laptop lid.
        front_back_heuristic=True,
        # A MEMS mic's DC blocker already handles its own offset; 120 Hz keeps
        # wind and handling noise out of the detector without touching speech.
        highpass_hz=_num(arr.get("highpass_hz")) or 120.0,
        lowpass_hz=_num(arr.get("lowpass_hz")) or 6000.0,
        device=None,
        audio_delay_ms=delay,
        notes=tuple(arr.get("_notes", ())),
    )


def _profile_from_file(path: Path, calib_path: Path | None = None) -> Profile:
    """Load a stand-in array profile from `server/profiles/`."""
    prof = _read_json(path)
    mics = tuple(
        Mic(id=int(m["id"]), x=float(m["x"]), y=float(m["y"]), z=float(m["z"]))
        for m in prof["mics"]
    )
    channels = tuple(int(c) for c in prof["channels"])
    if len(channels) != len(mics):
        raise ValueError(f"{path}: channels ({len(channels)}) must match mics ({len(mics)})")

    spacing = _num(prof.get("spacing_m"))
    calibrated = bool(prof.get("calibrated", spacing is not None)) and spacing is not None

    # A vision-fit measurement is written back into the profile by
    # `server/calib_fit.py`; a measured `calib.json` still wins for the hat.
    yaw = _num(prof.get("head_yaw_offset_deg"))
    if calib_path is not None and calib_path.exists():
        calib = _read_json(calib_path)
        yaw = _num(calib.get("head_yaw_offset_deg")) or yaw

    return Profile(
        name=str(prof.get("name", path.stem)),
        transport=str(prof.get("transport", "pw")),
        rate_hz=int(prof.get("rate_hz", 16000)),
        layout=str(prof.get("layout", "line")),
        mics=mics,
        channels=channels,
        spacing_m=spacing,
        baseline_m=_num(prof.get("baseline_m")),
        head_yaw_offset_deg=yaw or 0.0,
        camera_fov_deg=_num(prof.get("camera_fov_deg")) or 62.0,
        calibrated=calibrated,
        uncalibrated_accuracy_deg=_num(prof.get("uncalibrated_accuracy_deg")) or 45.0,
        front_back_heuristic=bool(prof.get("front_back_heuristic", False)),
        highpass_hz=_num(prof.get("highpass_hz")) or 120.0,
        lowpass_hz=_num(prof.get("lowpass_hz")) or 6000.0,
        analysis_channels=(
            tuple(int(m) for m in prof["analysis_channels"]) if prof.get("analysis_channels") else None
        ),
        device=prof.get("device"),
        audio_delay_ms=_num(prof.get("audio_delay_ms")),
        notes=tuple(prof.get("_notes", ())),
    )


def load_profile(name: str | None = None) -> Profile:
    """Load the hat geometry (default) or a named stand-in profile.

    `name=None` / `"hat"` → `config/array.json` overlaid with `config/calib.json`.
    Anything else → `server/profiles/<name>.json`.
    """
    if name in (None, "", HAT_PROFILE):
        prof = _profile_from_hat(CONFIG_DIR / "array.json", CONFIG_DIR / "calib.json")
    else:
        path = PROFILE_DIR / f"{name}.json"
        if not path.exists():
            known = sorted(p.stem for p in PROFILE_DIR.glob("*.json"))
            raise FileNotFoundError(f"unknown profile {name!r}; have {known}")
        prof = _profile_from_file(path, CONFIG_DIR / "calib.json")
    log.info("%s", prof.summary())
    return prof


def available_profiles() -> list[str]:
    return [HAT_PROFILE] + sorted(p.stem for p in PROFILE_DIR.glob("*.json"))


def write_profile_spacing(name: str, spacing_m: float, baseline_m: float | None = None) -> Path:
    """Persist a measured effective spacing into a stand-in profile.

    Only ever touches `server/profiles/**` (owner B's tree); `config/calib.json`
    belongs to member D and is never written from here.
    """
    path = PROFILE_DIR / f"{name}.json"
    prof = _read_json(path)
    prof["spacing_m"] = round(float(spacing_m), 6)
    if baseline_m is not None:
        prof["baseline_m"] = round(float(baseline_m), 6)
    prof["calibrated"] = True
    path.write_text(json.dumps(prof, indent=2) + "\n")
    log.info("wrote measured spacing %.4f m into %s", spacing_m, path)
    return path
