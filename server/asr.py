"""Speech-to-text for the `speech` WebSocket message (README §4.5).

A hat that captions ambient speech has one hard rule: **never fabricate a
transcript.** Whisper will happily invent fluent sentences for a tone, a hum or a
clap, and a confidently wrong caption is worse for the wearer than no caption at
all. So this module is deliberately timid:

* the model is built lazily on the first `transcribe()` call, and any failure to
  build it (no weights, no network, bad compute type) disables the module quietly
  — the backend then emits **no** `speech` message at all rather than a made-up
  one, and `Transcriber.reason` says why;
* anything shorter than a quarter second, digitally silent, or non-finite is not
  an utterance: such a clip returns `None` rather than the text the decoder
  invents for it (silence decodes to "You", NaN decodes to fluent nonsense);
* decoding is one-shot: English, greedy, no VAD, no cross-segment conditioning.
  A wearable backend is not a chat session, and hallucination feeds on context.

`confidence` is the mean per-segment `exp(avg_logprob)` clamped to 0..1: the
model's agreement with itself, not a probability that the caption is right.
"""

from __future__ import annotations

import glob
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np
import soundfile as sf
from scipy import signal

log = logging.getLogger("server.asr")

RATE_HZ = 16000  # Whisper's feature extractor is fixed at 16 kHz
MIN_SECONDS = 0.25
MIN_SAMPLES = int(MIN_SECONDS * RATE_HZ)

# Peak amplitude below this is a dead channel, not a quiet room: 16-bit LSB is
# 3e-5, so nothing a microphone actually heard lands here. See `transcribe`.
SILENCE_PEAK = 1e-4


@dataclass
class Transcript:
    """One decoded utterance, ready to be wrapped in a §4.5 `speech` message."""

    text: str
    language: str
    confidence: float
    named: bool


class Transcriber:
    """Lazy faster-whisper wrapper. Never raises out of `transcribe()`."""

    def __init__(
        self,
        model_size: str = "base.en",
        names: Sequence[str] = (),
        device: str = "cpu",
        compute_type: str = "int8",
        enabled: bool = True,
        cache_dir: str | None = None,
    ) -> None:
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self.cache_dir = cache_dir
        self.enabled = enabled
        # "ok" means usable; a failed lazy load replaces it with the exception text
        # so the backend can log a real reason at startup instead of a bare None.
        self.reason = "ok" if enabled else "disabled"
        self.names = tuple(n.strip() for n in names if n.strip())
        self._name_re = [
            re.compile(r"\b" + re.escape(n.lower().replace("\u2019", "'")) + r"(?:'s)?\b")
            for n in self.names
        ]
        self._model = None

    def _ensure(self) -> bool:
        """Build the model on first use; True once one is available."""
        if not self.enabled:
            return False
        if self._model is not None:
            return True
        try:
            # Imported here, not at module scope: a broken faster-whisper install
            # degrades to "no captions" instead of stopping the backend from booting.
            from faster_whisper import WhisperModel

            self._model = WhisperModel(
                self.model_size,
                device=self.device,
                compute_type=self.compute_type,
                download_root=self.cache_dir,
            )
        except Exception as exc:  # any failure here just means "no captions"
            self.enabled = False
            self.reason = str(exc)
            log.warning("speech-to-text disabled: %s", exc)
            return False
        self.reason = "ok"
        return True

    def transcribe(self, samples: np.ndarray) -> Transcript | None:
        """Decode one 16 kHz mono float32 clip; None when there is nothing to say.

        Returns None when disabled, when the clip is shorter than `MIN_SECONDS`,
        when it carries no signal a microphone could have heard (silence, NaNs),
        or when the model produced no non-empty text. Nothing is logged per call:
        this runs inside the audio loop, on every speech-classified event.
        """
        if not self.enabled or not self._ensure():
            return None

        audio = np.asarray(samples, dtype=np.float32)
        if audio.ndim == 2:
            if audio.shape[0] == 0:
                return None
            audio = audio.mean(axis=0)  # ingest blocks arrive as (nch, nsamp)
        if audio.ndim != 1 or audio.size < MIN_SAMPLES:
            return None
        if not np.isfinite(audio).all():
            # A NaN clip is a broken microphone, not speech. Whisper invents fluent
            # text for it, and a fabricated caption is the one thing we must not emit.
            return None
        if float(np.max(np.abs(audio))) < SILENCE_PEAK:
            return None  # digital silence decodes to "You": invented, not heard

        try:
            segments, info = self._model.transcribe(
                audio,
                language="en",
                beam_size=1,
                vad_filter=False,
                condition_on_previous_text=False,
            )
            texts: list[str] = []
            logprobs: list[float] = []
            for segment in segments:  # the generator is lazy: the work happens here
                texts.append(segment.text)
                if segment.avg_logprob is not None:
                    logprobs.append(float(segment.avg_logprob))
        except Exception as exc:  # a decode failure must not kill the audio loop
            log.warning("transcribe failed: %s", exc)
            return None

        text = " ".join(t.strip() for t in texts).strip()
        if not text:
            return None

        confidence = 0.0
        if logprobs:
            confidence = float(np.clip(np.mean(np.exp(logprobs)), 0.0, 1.0))

        return Transcript(
            text=text,
            language=info.language or "en",
            confidence=confidence,
            named=self._mentions_name(text),
        )

    def _mentions_name(self, text: str) -> bool:
        """Whole-word, case-insensitive name hit; "sam's" counts as "sam"."""
        lowered = text.lower().replace("\u2019", "'")
        return any(pattern.search(lowered) for pattern in self._name_re)

    def close(self) -> None:
        """Drop the model and its threads; the backend calls this on shutdown."""
        self._model = None


def default_names() -> tuple[str, ...]:
    """Wearer names from `HACKGT_NAMES` (comma-separated), `()` when unset.

    Convenience for the pseudo-terminal demo, which has no `--names` flag to pass;
    the backend normally supplies the list explicitly.
    """
    return tuple(n.strip() for n in os.environ.get("HACKGT_NAMES", "").split(",") if n.strip())


# --------------------------------------------------------------------------- #
# `python -m server.asr`: prove a real transcript against real speech
# --------------------------------------------------------------------------- #

SPEECH_TEXT = "the quick brown fox jumps over the lazy dog"


def _run(cmd: list[str]) -> bool:
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode == 0:
        return True
    print(f"  failed ({proc.returncode}): {' '.join(cmd)}")
    tail = (proc.stderr or proc.stdout).strip().splitlines()
    if tail:
        print(f"    {tail[-1]}")
    return False


def _find_espeak() -> str | None:
    """`espeak-ng`/`espeak` from PATH, else from the Nix store (this laptop is NixOS)."""
    for exe in ("espeak-ng", "espeak"):
        found = shutil.which(exe)
        if found:
            return found
    for pattern in ("/nix/store/*/bin/espeak-ng", "/nix/store/*/bin/espeak"):
        hits = sorted(glob.glob(pattern))
        if hits:
            return hits[-1]
    return None


def _read_wav_16k(path: Path) -> np.ndarray:
    audio, rate = sf.read(str(path), dtype="float32", always_2d=False)
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    if rate != RATE_HZ:
        audio = signal.resample_poly(audio, RATE_HZ, int(rate))
    return np.ascontiguousarray(audio, dtype=np.float32)


def _speech_clip(tmp: Path) -> np.ndarray | None:
    """Real speech with no microphone: synthesize `SPEECH_TEXT` with a local TTS."""
    flite = tmp / "flite.wav"
    if _run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"flite=text='{SPEECH_TEXT}':voice=slt",
            "-ar", str(RATE_HZ), "-ac", "1", str(flite),
        ]
    ):
        return _read_wav_16k(flite)

    exe = _find_espeak()
    if exe is None:
        print("  failed: no espeak-ng/espeak on PATH or in /nix/store")
        return None
    espeak = tmp / "espeak.wav"
    if _run([exe, "-w", str(espeak), SPEECH_TEXT]):
        return _read_wav_16k(espeak)
    return None


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def _main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    transcriber = Transcriber(names=default_names())
    print(
        f"faster-whisper model={transcriber.model_size} device={transcriber.device} "
        f"compute={transcriber.compute_type} names={transcriber.names or '()'}"
    )

    t0 = time.perf_counter()
    if not transcriber._ensure():
        print(f"FAIL: speech-to-text unavailable: {transcriber.reason}")
        return 2
    print(f"model load: {time.perf_counter() - t0:.1f} s (reason={transcriber.reason})")

    # (a) A pure tone is not speech. Any text here was invented by the decoder.
    sine = (0.2 * np.sin(2.0 * np.pi * 440.0 * np.arange(RATE_HZ) / RATE_HZ)).astype(np.float32)
    t0 = time.perf_counter()
    sine_transcript = transcriber.transcribe(sine)
    print(f"sine 440 Hz, 1.00 s -> {sine_transcript!r} ({time.perf_counter() - t0:.2f} s)")

    # (b) A real utterance, synthesized locally so no recording is needed.
    with tempfile.TemporaryDirectory() as tmpdir:
        audio = _speech_clip(Path(tmpdir))
    if audio is None:
        print("FAIL: no local speech source (failed commands above)")
        return 3
    print(f"speech clip: {audio.size / RATE_HZ:.2f} s, synthesized {SPEECH_TEXT!r}")

    t0 = time.perf_counter()
    speech = transcriber.transcribe(audio)
    elapsed = time.perf_counter() - t0
    print(f"transcribe speech: {elapsed:.2f} s wall -> {speech!r}")

    ok = True
    if sine_transcript is not None and sine_transcript.text.strip():
        print(f"FAIL: sine produced text {sine_transcript.text!r}")
        ok = False
    if speech is None:
        print("FAIL: no transcript for the synthesized speech")
        return 3
    print(f"  expected words: {_words(SPEECH_TEXT)}")
    print(f"  decoded words:  {_words(speech.text)}")
    if _words(speech.text) != _words(SPEECH_TEXT):
        print("FAIL: transcript differs from the synthesized phrase at word level")
        ok = False
    print(
        f"  language={speech.language} confidence={speech.confidence:.3f} named={speech.named}"
    )
    transcriber.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(_main())
