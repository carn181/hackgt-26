"""Measure the array's effective spacing with the camera as a reference.

`spacing_m` is the constant that converts a measured delay into a bearing, and
nobody has ever measured this laptop's DMIC pair. Rather than guess (or trust a
CAD drawing, README §7.2.1), the backend watches for moments where it knows the
true bearing *optically* — a face is on screen, its mouth is moving, and the
array simultaneously measures a delay — and regresses

    sin_est = slope · sin_true + intercept

over those pairs. `slope` is the ratio of true to assumed spacing, so the
measured spacing is `slope × spacing_m_assumed`, and `intercept` is real
per-channel skew (the inter-bus offset of README §7.2.2, in sin units).

The fit is deliberately conservative: it refuses to report anything until it has
enough observations spread over enough bearings, and it caps the slope to a
physically plausible window so a bad afternoon of data cannot poison the
profile. Every observation is real audio plus a real face box; nothing here is
synthetic.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

import numpy as np

log = logging.getLogger("server.calib_fit")

MIN_OBS = 24
MIN_SPREAD = 0.35          # min-max of sin_true across observations
MIN_MEAN_ABS_SIN = 0.18    # observations must leave the bore-sight (sin=0) region
SLOPE_BOUNDS = (0.25, 4.0)
MAX_INTERCEPT_SIN = 0.25   # ~14° of pure channel skew is already implausible


@dataclass
class FitResult:
    slope: float
    intercept: float
    slope_sigma: float
    rms_sin: float
    n: int
    spread: float
    spacing_m: float | None
    baseline_m: float | None
    assumed_spacing_m: float | None

    def summary(self) -> str:
        sp = "?" if self.spacing_m is None else f"{self.spacing_m * 1000:.1f} mm"
        return (
            f"n={self.n} slope={self.slope:.3f}±{self.slope_sigma:.3f} "
            f"intercept={self.intercept:+.3f} rms_sin={self.rms_sin:.3f} "
            f"spread={self.spread:.2f} -> spacing {sp}"
        )


@dataclass
class SpacingFit:
    """Accumulates (vision, acoustic) bearing pairs and fits the scale factor."""

    assumed_spacing_m: float | None = None
    assumed_baseline_m: float | None = None
    obs: list[tuple[float, float, float]] = field(default_factory=list)  # sin_true, sin_est, weight
    last_result: FitResult | None = None
    written: bool = False

    def observe(self, sin_true: float, sin_est: float, weight: float = 1.0) -> None:
        if not (math.isfinite(sin_true) and math.isfinite(sin_est)):
            return
        if abs(sin_true) < 0.05 or weight <= 0:
            return  # near bore sight the two axes are degenerate; no information
        self.obs.append((float(sin_true), float(sin_est), float(weight)))

    def fit(self) -> FitResult | None:
        """Weighted least squares; None until the data can support a claim."""
        if len(self.obs) < MIN_OBS:
            return None
        a = np.asarray(self.obs, dtype=np.float64)
        s_true, s_est, w = a[:, 0], a[:, 1], a[:, 2]
        spread = float(s_true.max() - s_true.min())
        if spread < MIN_SPREAD or float(np.mean(np.abs(s_true))) < MIN_MEAN_ABS_SIN:
            return None
        wn = w / w.sum()
        # Weighted linear fit of s_est on s_true.
        mt = float(np.sum(wn * s_true))
        me = float(np.sum(wn * s_est))
        cov = float(np.sum(wn * (s_true - mt) * (s_est - me)))
        var = float(np.sum(wn * (s_true - mt) ** 2))
        if var < 1e-9:
            return None
        slope = cov / var
        if not (SLOPE_BOUNDS[0] <= slope <= SLOPE_BOUNDS[1]):
            log.warning("spacing fit rejected: slope %.3f outside %s", slope, SLOPE_BOUNDS)
            return None
        intercept = me - slope * mt
        if abs(intercept) > MAX_INTERCEPT_SIN:
            log.warning("spacing fit rejected: |intercept| %.3f too large (channel skew?)", intercept)
            return None
        resid = s_est - (slope * s_true + intercept)
        rms = float(np.sqrt(np.sum(wn * resid**2)))
        # Slope sigma from the weighted residual scatter.
        n_eff = max(1.0, 1.0 / float(np.sum(wn**2)))
        slope_sigma = float(math.sqrt(max(rms**2 / (var * n_eff), 0.0)))
        res = FitResult(
            slope=slope,
            intercept=intercept,
            slope_sigma=slope_sigma,
            rms_sin=rms,
            n=len(self.obs),
            spread=spread,
            spacing_m=None if self.assumed_spacing_m is None else slope * self.assumed_spacing_m,
            baseline_m=None if self.assumed_baseline_m is None else slope * self.assumed_baseline_m,
            assumed_spacing_m=self.assumed_spacing_m,
        )
        self.last_result = res
        return res

    def sin_bias(self) -> float:
        """Bias to subtract from every future acoustic `sin_est` (channel skew)."""
        return 0.0 if self.last_result is None else float(self.last_result.intercept)

    def scale(self) -> float:
        """Multiplier turning the assumed geometry into the measured one."""
        return 1.0 if self.last_result is None else float(self.last_result.slope)

    def ready_to_write(self, result: FitResult | None = None) -> bool:
        res = result or self.last_result
        if res is None or self.written or res.spacing_m is None:
            return False
        # Demand a well-determined scale: the slope must be several sigma from
        # 1.0-noise and the residual small enough to be worth persisting.
        return bool(res.slope_sigma < 0.15 and res.rms_sin < 0.25 and res.n >= MIN_OBS)
