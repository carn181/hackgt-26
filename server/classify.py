"""YAMNet sound classification over the frozen interface contract (README 8.2).

Why this wrapper exists at all: the model file, the class-map row order and the
fixed 15600-sample input are the three things that go wrong silently. Load them
in one place and a bad model file raises here instead of masquerading as bad
audio in the DOA code, which is the expensive debugging path.

Input is 16 kHz mono, identical to our capture rate, so nothing resamples
anywhere in the pipeline. Callers pass whichever channel they classify (README
8.3: the mid-pair average for P0, the steered beam for P1) -- never a raw
multi-channel sum.

The TFLite interpreter behind `scores()` is NOT thread-safe. All inference for a
given YAMNet instance must run on one thread; `server/main.py` owns a single
analysis thread for exactly that reason. Do not hand an instance to a pool.
"""

from __future__ import annotations

import csv
import hashlib
import logging
import time
from pathlib import Path

import numpy as np
from ai_edge_litert.interpreter import Interpreter

log = logging.getLogger("server.classify")

SAMPLE_RATE = 16000
WINDOW = 15600  # 0.975 s at 16 kHz -- the model's fixed input length
DEFAULT_MODEL = "models/yamnet.tflite"
DEFAULT_CLASS_MAP = "models/yamnet_class_map.csv"

_SHA256_CHUNK = 1 << 20


def _sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(_SHA256_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_class_map(path: str | Path) -> list[str]:
    """Display names in `class_index` order; a shuffled index column is an error."""
    names: list[str] = []
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            index = int(row["index"])
            if index != len(names):
                raise ValueError(f"{path}: index column is not row order (row {len(names)} has index {index})")
            names.append(row["display_name"])
    if not names:
        raise ValueError(f"{path}: no classes")
    return names


class YAMNet:
    """A loaded yamnet.tflite plus its 521-name class map.

    `scores` is the only entry point the rest of the server needs; `top` is the
    convenience form used for logs and the HUD.
    """

    def __init__(
        self,
        model_path: str | Path = DEFAULT_MODEL,
        class_map_path: str | Path = DEFAULT_CLASS_MAP,
    ) -> None:
        self.model_path = str(model_path)
        self.class_map_path = str(class_map_path)
        self.sha256 = _sha256(model_path)
        self.classes = _read_class_map(class_map_path)
        self.n_classes = len(self.classes)
        self.window = WINDOW

        self._interp: Interpreter | None = Interpreter(model_path=self.model_path)
        self._interp.allocate_tensors()
        in_detail = self._interp.get_input_details()[0]
        out_detail = self._interp.get_output_details()[0]
        self._in_shape = tuple(int(v) for v in in_detail["shape"])
        if int(np.prod(self._in_shape)) != self.window:
            raise ValueError(f"{self.model_path}: input shape {self._in_shape} is not {self.window} samples")
        if int(out_detail["shape"][-1]) != self.n_classes:
            raise ValueError(
                f"{self.model_path}: output {tuple(out_detail['shape'])} does not match {self.n_classes} classes"
            )
        self._in_index = int(in_detail["index"])
        self._out_index = int(out_detail["index"])
        self._in_buf = np.zeros(self.window, dtype=np.float32)

        log.info(
            "yamnet %s sha256=%s classes=%d rate=16000 window=%d",
            self.model_path,
            self.sha256,
            self.n_classes,
            self.window,
        )

    def scores(self, samples: np.ndarray) -> np.ndarray:
        """521 float32 scores for one window.

        `samples` is 1-D, nominally -1..1 at 16 kHz, of any length: it is
        zero-padded or truncated to exactly 15600 (README 8.2 -- never pass a
        different length to the tensor). Raises ValueError on empty or >1-D
        input rather than guessing which axis was meant. Not reentrant.
        """
        if self._interp is None:
            raise RuntimeError("YAMNet is closed")
        x = np.asarray(samples)
        if x.ndim != 1:
            raise ValueError(f"expected 1-D samples, got shape {x.shape}")
        if x.size == 0:
            raise ValueError("empty samples")
        if x.dtype != np.float32:
            x = x.astype(np.float32)

        buf = self._in_buf
        buf.fill(0.0)
        n = min(int(x.size), self.window)
        buf[:n] = x[:n]

        self._interp.set_tensor(self._in_index, buf.reshape(self._in_shape))
        self._interp.invoke()
        # Copy: the interpreter reuses its tensor buffer on the next invoke().
        return np.array(self._interp.get_tensor(self._out_index), dtype=np.float32, copy=True).reshape(-1)

    def top(self, samples: np.ndarray, k: int = 3) -> list[tuple[str, float]]:
        """Top-`k` (display_name, score) pairs, highest score first."""
        k = int(k)
        if k <= 0:
            return []
        s = self.scores(samples)
        k = min(k, self.n_classes)
        order = np.argsort(-s, kind="stable")[:k]  # stable: ties keep class order
        return [(self.classes[int(i)], float(s[i])) for i in order]

    def close(self) -> None:
        """Release the interpreter; later calls raise RuntimeError."""
        self._interp = None

    def __enter__(self) -> "YAMNet":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


_default: YAMNet | None = None


def load() -> YAMNet:
    """The process-wide default model, built on first call (README 8.2 API)."""
    global _default
    if _default is None:
        _default = YAMNet()
    return _default


def classify(model: YAMNet, samples: np.ndarray) -> np.ndarray:
    """README 8.2 API: the 521 scores for one window."""
    return model.scores(samples)


def classes() -> list[str]:
    """README 8.2 API: the 521 display names in class_index order."""
    return list(load().classes)


# --- selftest: reproduces the README 8.2 checks in-process -------------------

_NOISE_OK = frozenset({"Static", "Noise", "Pink noise", "White noise"})


def _signals() -> dict[str, np.ndarray]:
    """3 s @ 16 kHz test signals; no ffmpeg, no files."""
    rng = np.random.default_rng(0)
    n = 3 * SAMPLE_RATE
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    sine = (0.5 * np.sin(2.0 * np.pi * 440.0 * t)).astype(np.float32)
    white = (0.1 * rng.standard_normal(n)).astype(np.float32)

    spectrum = np.fft.rfft(rng.standard_normal(n))
    freq = np.fft.rfftfreq(n, d=1.0 / SAMPLE_RATE)
    freq[0] = freq[1]  # keep DC finite
    pink = np.fft.irfft(spectrum / np.sqrt(freq), n)  # 1/f amplitude = pink
    pink = (0.3 * pink / float(np.max(np.abs(pink)))).astype(np.float32)
    return {"sine440": sine, "white": white, "pink": pink}


def _selftest() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    failures: list[str] = []

    def check(ok: bool, label: str) -> None:
        print(f"{'PASS' if ok else 'FAIL'}  {label}")
        if not ok:
            failures.append(label)

    signals = _signals()

    with YAMNet() as model:
        print(f"model    {model.model_path}")
        print(f"sha256   {model.sha256}")
        print(f"classes  {model.n_classes}")
        print(f"window   {model.window} samples = {model.window / SAMPLE_RATE:.3f} s at {SAMPLE_RATE} Hz")
        print()

        times_ms: list[float] = []
        for _ in range(20):
            t0 = time.perf_counter()
            model.scores(signals["sine440"])
            times_ms.append((time.perf_counter() - t0) * 1e3)
        mean_ms = sum(times_ms) / len(times_ms)
        print(
            f"inference  mean {mean_ms:.2f} ms  min {min(times_ms):.2f}  max {max(times_ms):.2f}"
            f"  ({len(times_ms)} windows of {model.window} samples)"
        )
        print()

        top1: dict[str, tuple[str, float]] = {}
        for name, samples in signals.items():
            top = model.top(samples, 3)
            top1[name] = top[0]
            row = "  ".join(f"{cls} {score:.3f}" for cls, score in top)
            print(f"{name:8s} {row}")
        print()

        check(model.n_classes == 521, f"class map has 521 classes (got {model.n_classes})")
        check(model.window == 15600, f"window is 15600 samples (got {model.window})")
        s = model.scores(signals["sine440"])
        check(s.shape == (521,) and s.dtype == np.float32, f"scores shape/dtype {s.shape}/{s.dtype}")
        for label, bad in (("2-D", np.zeros((2, 15600), dtype=np.float32)), ("empty", np.zeros(0, dtype=np.float32))):
            try:
                model.scores(bad)
                check(False, f"{label} input raises ValueError")
            except ValueError:
                check(True, f"{label} input raises ValueError")

        name, score = top1["sine440"]
        check("Sine wave" in name and score >= 0.7, f"sine440 top-1 '{name}' score {score:.3f} >= 0.7")
        for key in ("white", "pink"):
            name, score = top1[key]
            check(name in _NOISE_OK and name != "Speech", f"{key} top-1 '{name}' score {score:.3f} in {sorted(_NOISE_OK)}")

    print()
    if failures:
        print(f"{len(failures)} FAILED check(s)")
        return 1
    print("all checks PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(_selftest())
