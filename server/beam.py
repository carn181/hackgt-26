"""Channel choice for the classifier (README §8.3, item B12).

Never a raw sum of every microphone: uncorrelated noise from all channels adds
up and the class label flickers. Two policies, in order of what is available:

  P1 (preferred)  delay-and-sum steered to the current bearing estimate
  P0 (fallback)   mean of the two *most separated* channels

On the 4-mic hat the P0 pair is mics 0+3 (240 mm baseline) — the widest available
— which is a better beam than the mid-pair the README suggests as a
before-DOA-exists shortcut, so P0 here is a strict upgrade over "1+2" and never
degrades to the 4-channel sum. On the laptop stand-in array (2 channels) both
policies collapse to the same thing, which is correct.
"""

from __future__ import annotations

import numpy as np

from .config import Profile
from .doa import SPEED_OF_SOUND


def analysis_pair(prof: Profile) -> tuple[int, int]:
    """The two most separated microphones, as channel indices."""
    xs = prof.mic_x
    i = int(np.argmin(xs))
    j = int(np.argmax(xs))
    if i == j:  # degenerate single-mic profile
        return 0, min(1, prof.nch - 1)
    return i, j


def analysis_channel(x: np.ndarray, prof: Profile) -> np.ndarray:
    """P0: mean of the widest pair. One channel in, one channel out."""
    i, j = analysis_pair(prof)
    if i == j:
        return x[i].astype(np.float32, copy=True)
    # Mean, not sum: a sum would scale the level with the channel count and
    # shift the absolute dB thresholds in the onset detector.
    return ((x[i].astype(np.float32) + x[j].astype(np.float32)) * 0.5)


def _fractional_shift(x: np.ndarray, samples: float) -> np.ndarray:
    """Delay `x` by `samples` (may be negative) with an exact FFT phase ramp."""
    if abs(samples) < 1e-6:
        return x
    n = x.shape[-1]
    spec = np.fft.rfft(x)
    k = np.arange(spec.shape[-1])
    spec *= np.exp(-2j * np.pi * k * samples / n)
    return np.fft.irfft(spec, n).astype(np.float32, copy=False)


def delay_and_sum(x: np.ndarray, prof: Profile, bearing_deg: float, rate: int | None = None) -> np.ndarray:
    """P1: steer the array to `bearing_deg` and sum (README §8.3 "P1").

    Arrival time at mic i is `t_i = -(x_i·sinθ)/c`, so aligning the channels means
    advancing each by `t_i` — a shift of `-t_i·fs` samples in the FFT convention
    used by `_fractional_shift`. Channels are mean-summed (`1/n`) so the level
    stays comparable to a single mic and the detector's dB thresholds hold.
    """
    rate = rate or prof.rate_hz
    sin_t = float(np.sin(np.radians(bearing_deg)))
    n = x.shape[-1]
    out = np.zeros(n, dtype=np.float32)
    for ch in range(prof.nch):
        t_i = -(prof.mics[ch].x * sin_t) / SPEED_OF_SOUND
        out += _fractional_shift(x[ch].astype(np.float32), -t_i * rate)
    out /= prof.nch
    return out
