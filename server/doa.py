"""Direction of arrival on a 1-D mic array: GCC-PHAT, sub-band spread, SRP-PHAT.

The hat is a straight bar (README §4.7), and a straight bar can only measure one
angle. Two consequences shape every number in this file:

1. **Front/back is genuinely unknown.** A line array is symmetric about its
   axis, so θ and 180°−θ produce identical delays. We report the half-space we
   measured and set `ambiguous=True`; `server/fuse.py` resolves it with the
   camera or the head-shadow heuristic when either is available. Guessing a
   half-space is the one thing this project cannot afford (README §4.1).
2. **A small array is a coarse instrument.** Angle resolution is set by the
   baseline, so `accuracy_deg` is derived from the measured spread of the delay
   estimate — not from how confident the code feels. An uncalibrated array gets
   a large number on purpose.

Sign convention (verified by `server/selftest.py` against synthetic sources):
hat frame is +x = wearer's right, 0° = nose, positive bearing = clockwise from
above (README §4.1). A plane wave at azimuth θ arrives at mic i at
`t_i = -(x_i sinθ)/c`, so `gcc_phat(a_i, a_j)` — which peaks at `τ = t_i − t_j`
in the SciPy `correlate` convention `R(τ) = Σ a_i(t)·a_j(t−τ)` — measures
`τ = (x_j − x_i)·sinθ/c · fs`, i.e. `sinθ = −c·τ/(fs·dx)` with `dx = x_i − x_j`.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

import numpy as np
from scipy import signal
from scipy.fft import irfft, next_fast_len, rfft

from .config import Profile

log = logging.getLogger("server.doa")

SPEED_OF_SOUND = 343.0  # m/s, 20 °C

# README §6.2: 300–6000 Hz. Below 300 Hz is room rumble and handling noise; above
# 6000 Hz the 80 mm hat spacing has already aliased (c/2d = 2.1 kHz) and a laptop
# lid pair aliases even earlier, so the top of the band is only useful for the
# sub-band spread, not for the absolute delay.
BAND_LO_HZ = 300.0
BAND_HI_HZ = 6000.0
N_SUBBANDS = 8
# Two sub-bands must be at least this far apart in frequency for the pair of
# delay estimates to carry independent information.
MIN_BAND_RATIO = 1.15

# Below this magnitude-squared coherence between a mic pair we refuse to report a
# bearing at all: two channels that are not linearly related cannot have a
# meaningful delay between them, and "no estimate" is honest while a random angle
# is not. (Peak height in the PHAT correlation is *not* a usable gate: on a
# narrow band the correlation is sinusoid-like, so its peak-to-sigma ratio is ~1.4
# even for a perfect source.)
MIN_COHERENCE = 0.35
# An uncalibrated array has an unknown delay→angle scale, so a marginal estimate
# is worthless: it can only be wrong in magnitude *and* direction. Demand real
# coherence (a genuine common source reaches 0.8+) before reporting anything.
MIN_COHERENCE_UNCALIBRATED = 0.55
# Individual (pair, sub-band) observations below this coherence are dropped
# instead of being averaged in.
MIN_OBS_COHERENCE = 0.20


@dataclass
class DoaEstimate:
    bearing_deg: float
    accuracy_deg: float
    ambiguous: bool
    confidence: float
    method: str
    delay_samples: float          # mean pairwise lag for the widest baseline
    sigma_delay_samples: float    # spread of the per-pair, per-subband lags
    coherence: float

    def as_dict(self) -> dict:
        return {
            "bearing_deg": round(self.bearing_deg, 2),
            "accuracy_deg": round(self.accuracy_deg, 1),
            "ambiguous": self.ambiguous,
            "confidence": round(self.confidence, 3),
            "method": self.method,
            "delay_samples": round(self.delay_samples, 3),
            "sigma_delay_samples": round(self.sigma_delay_samples, 3),
        }


_band_cache: dict[tuple[int, float, float], np.ndarray] = {}


def _bandpass_sos(rate: int, lo: float = BAND_LO_HZ, hi: float = BAND_HI_HZ) -> np.ndarray:
    """Cached 4th-order Butterworth band-pass (zero-phase via sosfiltfilt)."""
    key = (rate, lo, hi)
    sos = _band_cache.get(key)
    if sos is None:
        nyq = rate / 2.0
        sos = signal.butter(4, [lo / nyq, min(hi / nyq, 0.99)], btype="bandpass", output="sos")
        _band_cache[key] = sos
    return sos


def band_limit(x: np.ndarray, rate: int, lo: float = BAND_LO_HZ, hi: float = BAND_HI_HZ) -> np.ndarray:
    """Band-limit a (nch, n) window in place-safe fashion (returns a copy)."""
    if x.shape[-1] < 32:
        return x.copy()
    return signal.sosfiltfilt(_bandpass_sos(rate, lo, hi), x, axis=-1).astype(np.float32, copy=False)


def gcc_phat(a: np.ndarray, b: np.ndarray, rate: int, interp: int = 2) -> tuple[float, float]:
    """Generalised cross-correlation with phase transform, sub-sample accurate.

    Returns `(lag_samples, peak_ratio)`: the lag τ maximizing `R(τ) = Σ a(t)·b(t−τ)`
    — i.e. how much `a` leads `b` — and the correlation peak divided by the
    residual sigma, which is the coherence gate's input.

    `interp` is the zero-pad factor: the correlation runs on an FFT of
    `next_fast_len(interp·n)`, which must exceed `2n−1` so no wrap-around leaks
    into the peak. It does **not** change the lag scale — one FFT bin is one
    sample at `rate` — sub-sample resolution comes from the parabolic refinement
    of the peak, which is worth about 1/10 of a sample on a clean signal. (An
    earlier version divided the lag by `interp`, which silently scaled every
    bearing by that factor; `server/selftest.py` catches the class of bug.)
    """
    n = a.shape[-1]
    if n < 64 or a.shape != b.shape:
        raise ValueError("gcc_phat needs equal, non-trivial signals")
    nfft = next_fast_len(max(2 * n - 1, n * max(1, interp)))
    aw = a * np.hanning(n)
    bw = b * np.hanning(n)
    fa = rfft(aw, nfft)
    fb = rfft(bw, nfft)
    cross = fa * np.conj(fb)
    mag = np.abs(cross)
    # PHAT: unit magnitude, keep phase. eps guards the silent bins that would
    # otherwise amplify numerical noise into a random delay.
    cross /= np.maximum(mag, 1e-9 * mag.max() if mag.max() > 0 else 1e-12)
    cc = irfft(cross, nfft)
    # irfft output index k is lag k for k < nfft/2, and lag k-nfft beyond; fold so
    # index 0 is lag 0 and negative lags come first.
    half = nfft // 2
    cc = np.concatenate((cc[-half:], cc[: half + 1]))
    peak = int(np.argmax(np.abs(cc)))
    centre = half
    sigma = float(np.std(cc))
    peak_ratio = float(abs(cc[peak]) / sigma) if sigma > 0 else 0.0
    lag = float(peak - centre)
    # Parabolic refinement on the (real) correlation values either side.
    if 0 < peak < len(cc) - 1:
        y0, y1, y2 = float(cc[peak - 1]), float(cc[peak]), float(cc[peak + 1])
        denom = y0 - 2.0 * y1 + y2
        if abs(denom) > 1e-12:
            lag += 0.5 * (y0 - y2) / denom
    return float(lag), peak_ratio


def _alias_hi_hz(dx: float) -> float:
    """Highest frequency a baseline of `dx` metres can localize unambiguously.

    A pair spaced `dx` repeats the phase every `c/dx` in the inter-mic phase
    difference, so above `c/(2·dx)` a delay maps onto a *wrong* angle rather than
    a noisy one. The 0.45 factor buys margin against the true geometry being
    slightly different from the assumed one (README §7.2.1: never trust CAD).

    This is why every pair gets its own band instead of the array getting one:
    on the 240 mm hat bar the widest pair stops at 715 Hz while the 80 mm
    adjacent pairs are good to 2.1 kHz, and its 2.1 kHz headline figure is the
    adjacent-pair limit, not the baseline's.
    """
    return 0.45 * SPEED_OF_SOUND / (2.0 * abs(dx))


def _subband_edges(rate: int, lo: float = BAND_LO_HZ, hi: float = BAND_HI_HZ, n: int = N_SUBBANDS) -> list[tuple[float, float]]:
    """Log-spaced sub-bands inside the analysis band, capped at Nyquist.

    The band count is derived from how much room there is instead of being fixed:
    a pair whose aliasing limit leaves only 300–770 Hz can afford at most a few
    useful sub-bands, and forcing 8 of them would produce bands narrower than the
    filter can resolve (and then no estimate at all).
    """
    hi = min(hi, 0.48 * rate)
    if hi <= lo * 1.05:
        return []
    max_bands = int(np.floor(np.log(hi / lo) / np.log(MIN_BAND_RATIO)))
    n_bands = max(1, min(n, max_bands))
    edges = np.geomspace(lo, hi, n_bands + 1)
    return [(float(a), float(b)) for a, b in zip(edges[:-1], edges[1:])]


@dataclass
class _PairDelays:
    lags: list[float] = field(default_factory=list)      # one per kept (pair, subband)
    weights: list[float] = field(default_factory=list)   # |dx|² × coherence²
    dxs: list[float] = field(default_factory=list)
    cohs: list[float] = field(default_factory=list)
    best_coherence: float = 0.0


def pair_coherence(a: np.ndarray, b: np.ndarray, rate: int) -> tuple[np.ndarray, np.ndarray]:
    """Welch magnitude-squared coherence γ²(f) between two channels.

    This is the honest answer to "do these two signals share a common source in
    this band?" — the first thing anyone with a signal-processing background will
    ask about a reported angle.
    """
    n = a.shape[-1]
    nperseg = int(min(512, max(64, n // 2)))
    noverlap = nperseg // 2
    f, gamma2 = signal.coherence(a, b, fs=rate, nperseg=nperseg, noverlap=noverlap)
    return f, np.nan_to_num(gamma2, nan=0.0)


def _pair_lags(x: np.ndarray, rate: int, prof: Profile) -> _PairDelays:
    """PHAT lags for every mic pair, in every sub-band of that pair's valid band.

    Each pair is limited to the frequencies it can localize unambiguously
    (`_alias_hi_hz`) and each (pair, sub-band) observation carries its own
    coherence. The spread of the lags across sub-bands is the honest error bar:
    a reverberant room or an incoherent source makes them disagree, and that
    disagreement is exactly `sigma_delay_samples`.
    """
    out = _PairDelays()
    for i, j, dx in prof.pairs():
        hi_cap = min(BAND_HI_HZ, _alias_hi_hz(dx))
        bands = _subband_edges(rate, BAND_LO_HZ, hi_cap)
        if not bands:
            continue
        wide = band_limit(x[[i, j]], rate, BAND_LO_HZ, hi_cap)
        freqs, gamma2 = pair_coherence(wide[0], wide[1], rate)
        for lo, hi in bands:
            mask = (freqs >= lo) & (freqs <= hi)
            coh = float(np.mean(gamma2[mask])) if mask.any() else 0.0
            out.best_coherence = max(out.best_coherence, coh)
            if coh < MIN_OBS_COHERENCE:
                continue  # not a real common source in this band: do not average it in
            seg = band_limit(x[[i, j]], rate, lo, hi)
            lag, _ = gcc_phat(seg[0], seg[1], rate)
            if abs(lag) > abs(dx) / SPEED_OF_SOUND * rate * 1.05 + 2:
                continue  # impossible delay: reject, do not average into the fit
            out.lags.append(lag)
            out.weights.append(abs(dx) ** 2 * coh**2)
            out.dxs.append(dx)
            out.cohs.append(coh)
    return out


def _bearing_from_lags(lags: np.ndarray, weights: np.ndarray, dxs: np.ndarray, rate: int) -> tuple[float, float, float]:
    """Weighted least squares of `sinθ = −c·τ/(fs·dx)` over all (pair, sub-band) lags.

    Returns `(sin_theta, tau_weighted_mean, sigma_tau)`; `tau_weighted_mean` is the
    effective lag scaled to the widest baseline, which is what `accuracy_deg`
    converts into degrees.
    """
    sin_est = -(SPEED_OF_SOUND / rate) * lags / dxs
    sin_est = np.clip(sin_est, -1.0, 1.0)
    w = weights / weights.sum()
    sin_mean = float(np.sum(w * sin_est))
    # Sigma of the per-observation angle estimates, in sin units, then converted
    # to a lag sigma on the widest baseline for reporting.
    var = float(np.sum(w * (sin_est - sin_mean) ** 2))
    dx_max = float(np.max(np.abs(dxs)))
    lag_mean = -sin_mean * dx_max * rate / SPEED_OF_SOUND
    sigma_lag = math.sqrt(var) * dx_max * rate / SPEED_OF_SOUND
    return sin_mean, lag_mean, sigma_lag


def _sigma_to_degrees(sigma_lag: float, dx: float, rate: int, sin_theta: float) -> float:
    """Convert a delay spread into an azimuth 1-sigma, keeping the cos θ blowup."""
    if dx <= 0:
        return 90.0
    cos_t = math.sqrt(max(1.0 - sin_theta**2, 1e-6))
    sigma_rad = (SPEED_OF_SOUND / (rate * dx)) * sigma_lag / cos_t
    return math.degrees(sigma_rad)


def srp_phat(x: np.ndarray, rate: int, prof: Profile, grid_deg: np.ndarray | None = None) -> tuple[float, float]:
    """Steered-response PHAT over a coarse bearing grid (README §6.2).

    Used when the array has ≥3 mics: it sums every pair's PHAT correlation at the
    delay each candidate bearing predicts, which is more robust than fitting each
    pair independently. Returns `(bearing_deg, peak_to_sigma)`.
    """
    if grid_deg is None:
        grid_deg = np.arange(-90.0, 90.01, 1.0)
    xb = band_limit(x, rate)
    n = xb.shape[-1]
    nfft = next_fast_len(n)
    spec = rfft(xb * np.hanning(n), nfft, axis=-1)
    freqs = np.fft.rfftfreq(nfft, 1.0 / rate)
    pairs = prof.pairs()
    corrs = []
    for i, j, dx in pairs:
        c = spec[i] * np.conj(spec[j])
        m = np.abs(c)
        c = c / np.maximum(m, 1e-12)
        # Each pair contributes only where it can localize unambiguously, and
        # only inside the 300–6000 Hz analysis band.
        keep = (freqs >= BAND_LO_HZ) & (freqs <= min(BAND_HI_HZ, _alias_hi_hz(dx), 0.45 * rate))
        c = np.where(keep, c, 0.0)
        nfft_full = 2 * (len(freqs) - 1)
        corrs.append((dx, irfft(c, nfft_full)))
    if not corrs:
        return 0.0, 0.0
    scores = np.zeros(grid_deg.shape, dtype=np.float64)
    for k, deg in enumerate(grid_deg):
        s = 0.0
        st = math.sin(math.radians(float(deg)))
        for dx, cc in corrs:
            # τ = −dx·sinθ·fs/c, the inverse of `_bearing_from_lags`.
            lag = -dx * st * rate / SPEED_OF_SOUND  # samples, may be negative
            idx = lag % nfft_full
            i0 = int(np.floor(idx))
            frac = idx - i0
            s += (1 - frac) * cc[i0] + frac * cc[(i0 + 1) % nfft_full]
        scores[k] = s
    best = int(np.argmax(scores))
    mu, sd = float(np.mean(scores)), float(np.std(scores))
    ratio = (scores[best] - mu) / sd if sd > 0 else 0.0
    return float(grid_deg[best]), ratio


def estimate_bearing(
    x: np.ndarray,
    prof: Profile,
    rate: int | None = None,
    *,
    use_srp: bool | None = None,
    correction: tuple[float, float] | None = None,
) -> DoaEstimate | None:
    """Azimuth in the hat frame from one window, or None when it is not trustworthy.

    `x` is (nch, n) float32 for the profile's channel order. Returns None when the
    correlation peak is too weak to believe. When the profile's spacing is
    uncalibrated the bearing is reported anyway — the *sign* is still a real
    measurement — but `accuracy_deg` is inflated so the HUD fades it, and the
    cheap `spacing_m`-scaled magnitude is explicitly not a claim.

    `correction` is `(sin_bias, scale)` measured against the camera
    (`server/calib_fit.py`): the assumed geometry turns the delay into
    `sin_assumed = sin_true · (d_true/d_assumed) + skew`, so the fix is
    `sin_true = (sin_assumed − bias) / scale`. Applying it here rather than at the
    call site keeps the error bar consistent with the angle that is reported.
    """
    rate = rate or prof.rate_hz
    if x.shape[0] != prof.nch:
        raise ValueError(f"expected {prof.nch} channels, got {x.shape[0]}")
    if x.shape[1] < int(0.03 * rate):
        return None

    use_srp = (prof.nch >= 3) if use_srp is None else use_srp
    pd = _pair_lags(x, rate, prof)
    if not pd.lags:
        return None
    lags = np.asarray(pd.lags, dtype=np.float64)
    weights = np.asarray(pd.weights, dtype=np.float64)
    dxs = np.asarray(pd.dxs, dtype=np.float64)
    sin_theta, lag_mean, sigma_lag = _bearing_from_lags(lags, weights, dxs, rate)

    if correction is not None:
        bias, scale = float(correction[0]), float(correction[1])
        if scale > 1e-6 and (bias != 0.0 or scale != 1.0):
            sin_theta = float(np.clip((sin_theta - bias) / scale, -1.0, 1.0))
            lag_mean /= scale
            sigma_lag /= abs(scale)

    method = "gcc-phat-pairs"
    coherence = float(np.average(pd.cohs, weights=weights))
    if use_srp:
        deg, _ = srp_phat(x, rate, prof)
        srp_sin = math.sin(math.radians(deg))
        # Trust SRP when it agrees with the pairwise fit to within its own spread.
        if abs(srp_sin - sin_theta) <= max(3.0 * sigma_lag * SPEED_OF_SOUND / (rate * np.max(np.abs(dxs))), 0.12):
            method = "srp-phat"
        else:
            deg = math.degrees(math.asin(np.clip(sin_theta, -1.0, 1.0)))
        sin_theta = srp_sin if method == "srp-phat" else sin_theta

    bearing = math.degrees(math.asin(float(np.clip(sin_theta, -1.0, 1.0))))

    # Effective baseline for the error bar: the widest calibrated pair, else the
    # assumed geometry (flagged through `calibrated`).
    dx_eff = float(np.max(np.abs(dxs)))
    sigma_deg = _sigma_to_degrees(sigma_lag, dx_eff, rate, sin_theta)
    if not prof.calibrated:
        accuracy = max(sigma_deg, prof.uncalibrated_accuracy_deg)
    else:
        # Never claim better than the geometry can support: 1/10 of a sample of
        # delay resolution at the widest baseline, plus the sub-band spread.
        floor = _sigma_to_degrees(0.1, dx_eff, rate, sin_theta)
        accuracy = max(2.0, min(90.0, max(sigma_deg, floor)))

    min_coh = MIN_COHERENCE if prof.calibrated else MIN_COHERENCE_UNCALIBRATED
    if coherence < min_coh:
        log.debug("doa rejected: coherence=%.2f < %.2f", coherence, min_coh)
        return None

    # A 1-D layout cannot separate θ from 180°−θ. Fusion may resolve it; here it
    # is always reported as ambiguous unless the profile explicitly declares a
    # front/back cue that has been validated.
    ambiguous = not (prof.layout != "line" and prof.front_back_heuristic)

    confidence = float(np.clip((coherence - min_coh) / (1.0 - min_coh), 0.0, 1.0))
    if not prof.calibrated:
        confidence *= 0.6  # magnitude is not trustworthy until someone measures d

    return DoaEstimate(
        bearing_deg=bearing,
        accuracy_deg=accuracy,
        ambiguous=ambiguous,
        confidence=confidence,
        method=method,
        delay_samples=float(lag_mean),
        sigma_delay_samples=float(sigma_lag),
        coherence=coherence,
    )


def mirror_bearing(deg: float) -> float:
    """The front/back twin of a bearing on a line array (README §4.1)."""
    m = 180.0 - deg
    return m - 360.0 if m > 180.0 else m
