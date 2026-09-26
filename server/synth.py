"""Synthetic multichannel audio: the ground truth the DSP is checked against.

Used by `server/selftest.py` for the DOA accuracy table (README §0 B7) and by the
end-to-end pipeline check. A plane wave arriving at azimuth θ reaches mic i at
`t_i = -(x_i·sinθ)/c`, so the generator places exactly that delay per channel —
which is precisely the model `server/doa.py` inverts. If the two ever disagree,
one of them is wrong and a synthetic sweep says which.
"""

from __future__ import annotations

import numpy as np

from .config import Profile
from .doa import SPEED_OF_SOUND


def _delay(x: np.ndarray, samples: float) -> np.ndarray:
    """Delay `x` by `samples` (negative = advance), no wraparound.

    Linear interpolation, not an FFT ramp: a wrap would smear the fade-in that
    the onset detector is supposed to find.
    """
    if abs(samples) < 1e-9:
        return x.copy()
    n = x.shape[-1]
    idx = np.arange(n, dtype=np.float64) - samples
    return np.interp(idx, np.arange(n, dtype=np.float64), x, left=0.0, right=0.0)


def plane_wave(
    prof: Profile,
    bearing_deg: float,
    *,
    seconds: float = 0.25,
    kind: str = "noise",
    freq: float = 440.0,
    level: float = 0.25,
    noise_level: float = 0.002,
    rise_s: float = 0.0,
    seed: int = 0,
    rate: int | None = None,
) -> np.ndarray:
    """(nch, n) float32 plane wave at `bearing_deg` in the profile's hat frame.

    `noise_level` is independent per-channel noise: without it the PHAT
    correlation is perfect and the error table would be a fiction.
    """
    rate = int(rate or prof.rate_hz)
    n = int(round(seconds * rate))
    rng = np.random.default_rng(seed)
    t = np.arange(n) / rate
    if kind == "tone":
        base = np.sin(2 * np.pi * freq * t)
        if rise_s > 0:
            r = int(round(rise_s * rate))
            base[:r] *= 0.5 * (1.0 - np.cos(np.pi * np.arange(r) / r))
    elif kind == "noise":
        base = rng.standard_normal(n)
    elif kind == "click":
        base = np.zeros(n)
        for at in (0.02, 0.06, 0.10):
            k = int(at * rate)
            base[k : k + 8] += rng.standard_normal(8) * 4.0
    else:
        raise ValueError(f"unknown kind {kind!r}")

    base = base.astype(np.float64) * level
    sin_t = np.sin(np.radians(bearing_deg))
    out = np.empty((prof.nch, n), dtype=np.float32)
    for ch in range(prof.nch):
        tau = -(prof.mics[ch].x * sin_t) / SPEED_OF_SOUND * rate  # samples
        out[ch] = (_delay(base, tau) + rng.standard_normal(n) * noise_level).astype(np.float32)
    return out


def write_wav(path, x: np.ndarray, rate: int) -> None:
    """Channel-major (nch, n) float32 → wav for `--source file`."""
    import soundfile as sf

    sf.write(path, x.T, rate, subtype="PCM_16")


def two_burst_wav(path, prof: Profile, rate: int, angles: tuple[float, ...] = (40.0, -40.0)) -> None:
    """A wav with one tone burst per angle, in order — the sign-flip test.

    Each burst fades in so the onset detector has a real rise to find, which is
    what makes this a test of the *streaming* path and not just of `estimate_bearing`.
    """
    gap = np.zeros((prof.nch, int(0.4 * rate)), dtype=np.float32)
    parts = []
    for i, ang in enumerate(angles):
        parts.append(plane_wave(prof, ang, seconds=0.8, kind="tone", freq=440.0, rise_s=0.05, seed=i))
        parts.append(gap)
    write_wav(path, np.concatenate(parts, axis=1), rate)
