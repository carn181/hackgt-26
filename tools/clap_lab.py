#!/usr/bin/env python3
"""Clap lab: how does YAMNet classify *this* clap under different preprocessing?

A hand clap comes out of the backend labelled `Fart`. Three parts of the current
preprocessing are plausible culprits and none of them can be settled by reading
the code:

  * the 300-6000 Hz band-pass removes the clap's high-frequency snap,
  * `analysis_channel` averages the two DMIC channels, and channel 1 carries
    ~12 dB more low-frequency energy than channel 0,
  * the 0.975 s analysis window ends only 0.20 s after the onset, so most of
    what the classifier sees is room noise.

This tool records real claps from the microphone and classifies the *same*
captured audio under each candidate variant, so the fix is chosen from
measurements on the human's own claps instead of from guesses. Each variant is a
named function, and the closing summary counts, per variant, how many claps read
as `Clapping` and with what mean score -- that table is the answer to "which
preprocessing makes a clap read as a clap".

Usage:
    .venv/bin/python tools/clap_lab.py --shots 5
    .venv/bin/python tools/clap_lab.py --shots 3 --save-dir /tmp/claps --json
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# `tools/` is not a package and the venv has no editable install, so running this
# file directly puts `tools/` -- not the repo root -- on sys.path, and `server`
# would not import.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.beam import analysis_channel  # noqa: E402
from server.classify import YAMNet  # noqa: E402
from server.config import load_profile  # noqa: E402
from server.detect import Offset, OnsetDetector  # noqa: E402
from server.ingest import BandPass, open_source  # noqa: E402
from server.ring import RingBuffer  # noqa: E402

log = logging.getLogger("tools.clap_lab")

# Exactly what the backend does today (server/fuse.py, server/main.py).
CLASSIFY_WINDOW_S = 15600 / 16000.0   # YAMNet's fixed input, 0.975 s
CLASSIFY_TAIL_S = 0.20                # window ends this long after the onset
COND_HP_HZ = 300.0
COND_LP_HZ = 6000.0

BLOCK_MS = 20.0
CLAP_MAX_S = 0.6        # longer than this and the detector heard speech, not a clap
LONG_TAIL_END_S = 0.60  # the latest sample any variant needs after the onset
FIRST_WINDOW_START_S = CLASSIFY_TAIL_S - CLASSIFY_WINDOW_S  # -0.775 s
PRE_ROLL_S = 1.0        # extra history so a variant's IIR has settled before the window
HISTORY_S = 6.0
MAX_RECORD_S = 60.0
METER_S = 0.5
TOP_K = 3
CLAP_CLASS = "Clapping"
EPS = 1e-12


@dataclass
class Clap:
    index: int        # absolute sample index of the onset in the capture stream
    onset_s: float    # onset time since the start of capture
    duration_s: float
    peak_db: float
    snr_db: float


class ClapAudio:
    """Raw history around one clap, plus the window cutter every variant shares.

    The variants differ only in band-pass, channel choice and where the window
    sits relative to the onset, so they all cut through `window()`. The history
    is kept *raw* (not the backend's conditioned stream) because two variants
    need bands the backend never applies.
    """

    def __init__(self, raw: np.ndarray, first_index: int, onset_index: int, prof) -> None:
        self.raw = raw                  # (nch, n) float32, zero-padded at the front
        self.first_index = int(first_index)   # absolute index of raw[:, 0]
        self.onset_index = int(onset_index)
        self.prof = prof
        self.rate = int(prof.rate_hz)

    def _slice(self, x: np.ndarray, start_s: float, end_s: float) -> np.ndarray:
        start = self.onset_index + int(round(start_s * self.rate))
        end = self.onset_index + int(round(end_s * self.rate))
        seg_start = max(start, self.first_index)
        seg_end = max(seg_start, min(end, self.first_index + x.shape[1]))
        seg = x[:, seg_start - self.first_index : seg_end - self.first_index]
        pad_left, pad_right = seg_start - start, end - seg_end
        if pad_left or pad_right:
            seg = np.pad(seg, ((0, 0), (pad_left, pad_right)))
        return seg

    def window(
        self,
        *,
        start_s: float,
        end_s: float,
        hp: float | None = None,
        lp: float | None = None,
        channel: int | None = None,
    ) -> np.ndarray:
        """Band-pass the history, cut [onset+start_s, onset+end_s), pick a channel.

        `channel=None` is the backend's `analysis_channel` (mean of the widest
        mic pair); an integer selects that single channel. A fresh `BandPass`
        runs over the whole history so its state is settled by the time the
        window starts -- the same streaming filter the backend runs, just
        restarted on a variant's band.
        """
        x = self.raw if hp is None else BandPass(self.rate, self.prof.nch, hp, lp).process(self.raw)
        seg = self._slice(x, start_s, end_s)
        if channel is None:
            return analysis_channel(seg, self.prof)
        return np.ascontiguousarray(seg[channel])

    def raw_span(self, start_s: float, end_s: float) -> np.ndarray:
        """The unprocessed multichannel samples covering every variant's window."""
        return self._slice(self.raw, start_s, end_s)


# ---------------------------------------------------------------------------
# The variants. One named function each, so the printed table explains itself.
# ---------------------------------------------------------------------------
def variant_current(audio: ClapAudio) -> np.ndarray:
    """The backend today: 300-6000 Hz, pair mean, window ending 0.20 s after the onset."""
    return audio.window(start_s=FIRST_WINDOW_START_S, end_s=CLASSIFY_TAIL_S, hp=COND_HP_HZ, lp=COND_LP_HZ)


def variant_no_lowpass(audio: ClapAudio) -> np.ndarray:
    """300-8000 Hz: same window, but the clap's 6-8 kHz snap is kept."""
    return audio.window(start_s=FIRST_WINDOW_START_S, end_s=CLASSIFY_TAIL_S, hp=COND_HP_HZ, lp=8000.0)


def variant_full_band(audio: ClapAudio) -> np.ndarray:
    """No band-pass at all: the raw pair mean."""
    return audio.window(start_s=FIRST_WINDOW_START_S, end_s=CLASSIFY_TAIL_S)


def variant_ch0(audio: ClapAudio) -> np.ndarray:
    """300-6000 Hz on channel 0 alone instead of the pair mean."""
    return audio.window(start_s=FIRST_WINDOW_START_S, end_s=CLASSIFY_TAIL_S, hp=COND_HP_HZ, lp=COND_LP_HZ, channel=0)


def variant_ch1(audio: ClapAudio) -> np.ndarray:
    """300-6000 Hz on channel 1 alone (the channel with ~12 dB more LF energy)."""
    return audio.window(start_s=FIRST_WINDOW_START_S, end_s=CLASSIFY_TAIL_S, hp=COND_HP_HZ, lp=COND_LP_HZ, channel=1)


def variant_hp80(audio: ClapAudio) -> np.ndarray:
    """80-8000 Hz: less of the LF thump, all of the HF snap."""
    return audio.window(start_s=FIRST_WINDOW_START_S, end_s=CLASSIFY_TAIL_S, hp=80.0, lp=8000.0)


def variant_long_tail(audio: ClapAudio) -> np.ndarray:
    """300-6000 Hz, window ending 0.60 s after the onset (less room noise in the window)."""
    return audio.window(start_s=LONG_TAIL_END_S - CLASSIFY_WINDOW_S, end_s=LONG_TAIL_END_S, hp=COND_HP_HZ, lp=COND_LP_HZ)


def variant_centred(audio: ClapAudio) -> np.ndarray:
    """300-6000 Hz, window centred on the onset: [onset-0.45 s, onset+0.52 s]."""
    return audio.window(start_s=-0.45, end_s=0.52, hp=COND_HP_HZ, lp=COND_LP_HZ)


VARIANTS: list[tuple[str, Callable[[ClapAudio], np.ndarray]]] = [
    ("current", variant_current),
    ("no-lowpass", variant_no_lowpass),
    ("full-band", variant_full_band),
    ("ch0", variant_ch0),
    ("ch1", variant_ch1),
    ("hp80", variant_hp80),
    ("long-tail", variant_long_tail),
    ("centred", variant_centred),
]


def analyse_clap(yamnet: YAMNet, audio: ClapAudio) -> dict[str, list[tuple[str, float]]]:
    """Top-`TOP_K` classes for every variant of one clap."""
    out: dict[str, list[tuple[str, float]]] = {}
    for name, fn in VARIANTS:
        try:
            out[name] = yamnet.top(fn(audio), TOP_K)
        except Exception as exc:  # a variant that cannot run must not kill the run
            log.warning("variant %s failed: %s", name, exc)
            out[name] = []
    return out


def _history_for(ring: RingBuffer, clap: Clap, prof) -> ClapAudio:
    rate = int(prof.rate_hz)
    first = max(0, clap.index + int(round(FIRST_WINDOW_START_S * rate)) - int(round(PRE_ROLL_S * rate)))
    raw = ring.snapshot(ring.written - first)
    return ClapAudio(raw, first, clap.index, prof)


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------
def record(args, prof) -> tuple[list[tuple[Clap, dict]], bool]:
    """Prompt for claps and capture them. Returns (captured, interrupted).

    The detector sees exactly the backend's conditioned mono stream, so the
    onset/offset and the `duration_s < 0.6` clap gate behave as they do live.
    """
    rate = int(prof.rate_hz)
    nsamp = int(round(rate * BLOCK_MS / 1000.0))
    source = open_source("pw", rate=rate, channels=prof.nch, nsamp=nsamp, device=args.device or prof.device)
    cond = BandPass(rate, prof.nch, prof.highpass_hz, prof.lowpass_hz)
    det = OnsetDetector(rate)
    ring = RingBuffer(prof.nch, int(HISTORY_S * rate))
    yamnet = YAMNet()

    captured: list[tuple[Clap, dict]] = []
    pending: deque[tuple[Clap, int]] = deque()
    interrupted = False
    meter_peak = -120.0
    shot = 0

    # With --json, stdout carries exactly one JSON object, so the prompts and the
    # level meter go to stderr where the human can still see them.
    def say(message: str = "") -> None:
        print(message, file=sys.stderr if args.json else sys.stdout, flush=True)

    say(f"profile {prof.name}  {prof.nch} ch  {rate} Hz  band {prof.highpass_hz:.0f}-{prof.lowpass_hz:.0f} Hz")
    say(f"lead-in {args.lead_in:.1f} s: stay quiet, the noise floor is settling")
    source.start()
    t0 = time.monotonic()
    lead_in_until = t0 + args.lead_in
    last_meter = t0
    prompted = False
    try:
        for blk in source.blocks():
            now = time.monotonic()
            if shot >= args.shots or now - t0 >= MAX_RECORD_S:
                break
            ring.write(blk.x, blk.t_us)
            mono = analysis_channel(cond.process(blk.x), prof)
            events = det.push(mono, blk.t_us)
            meter_peak = max(meter_peak, 10.0 * np.log10(float(np.mean(np.square(mono, dtype=np.float64))) + EPS))

            if now >= lead_in_until:
                if not prompted:
                    say(f"clap 1/{args.shots} ...")
                    prompted = True
                for ev in events:
                    if not isinstance(ev, Offset):
                        continue
                    if ev.duration_s < CLAP_MAX_S:
                        clap = Clap(
                            index=ev.onset.index,
                            onset_s=ev.onset.index / rate,
                            duration_s=ev.duration_s,
                            peak_db=ev.peak_db,
                            snr_db=ev.onset.snr_db,
                        )
                        pending.append((clap, ev.onset.index + int(round(LONG_TAIL_END_S * rate))))
                    else:
                        say(f"  ignored a {ev.duration_s:.2f} s event (too long for a clap)")

            # The longest variant needs audio up to 0.60 s after the onset, which
            # can be later than the offset that just resolved.
            while pending and ring.written >= pending[0][1]:
                clap, _ = pending.popleft()
                audio = _history_for(ring, clap, prof)
                variants = analyse_clap(yamnet, audio)
                captured.append((clap, variants))
                shot += 1
                if not args.json:
                    _print_clap(shot, args.shots, clap, variants)
                if args.save_dir:
                    _save_clap(args.save_dir, shot, audio, say)
                if shot < args.shots:
                    say(f"clap {shot + 1}/{args.shots} ...")

            if now - last_meter >= METER_S:
                last_meter = now
                label = "lead-in" if now < lead_in_until else f"clap {shot + 1}/{args.shots}"
                say(
                    f"  {label:<9} floor {det.floor_db:6.1f} dB  peak {meter_peak:6.1f} dB"
                    f"  snr {meter_peak - det.floor_db:5.1f} dB"
                )
                meter_peak = -120.0
    except KeyboardInterrupt:
        interrupted = True
    finally:
        source.stop()
    return captured, interrupted


def _save_clap(save_dir: Path, n: int, audio: ClapAudio, say) -> None:
    import soundfile as sf

    save_dir.mkdir(parents=True, exist_ok=True)
    path = save_dir / f"clap_{n:02d}.wav"
    data = audio.raw_span(FIRST_WINDOW_START_S, LONG_TAIL_END_S)
    sf.write(str(path), data.T, audio.rate, subtype="PCM_16")
    say(f"  saved {path}")


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------
def _print_clap(n: int, total: int, clap: Clap, variants: dict[str, list[tuple[str, float]]]) -> None:
    print(
        f"\nclap {n}/{total}  onset {clap.onset_s:.3f} s  duration {clap.duration_s:.3f} s"
        f"  peak {clap.peak_db:.1f} dB  snr {clap.snr_db:.1f} dB"
    )
    width = max(len(name) for name in variants)
    for name, top in variants.items():
        body = "  ".join(f"{cls} {score:.3f}" for cls, score in top) or "(no result)"
        print(f"  {name:<{width}}  {body}")


def summarise(captured: list[tuple[Clap, dict]]) -> dict[str, dict]:
    """Per variant: how many claps read `Clapping`, and its mean score when present."""
    out: dict[str, dict] = {}
    for name, _ in VARIANTS:
        hits, scores = 0, []
        for _, variants in captured:
            for cls, score in variants.get(name, []):
                if cls == CLAP_CLASS:
                    hits += 1
                    scores.append(score)
        out[name] = {
            "hits": hits,
            "claps": len(captured),
            "mean_clapping_score": (sum(scores) / len(scores)) if scores else 0.0,
        }
    return out


def _print_summary(captured: list[tuple[Clap, dict]], summary: dict[str, dict]) -> None:
    print(f"\nsummary: {len(captured)} clap(s) -- how often each variant reads as {CLAP_CLASS!r}")
    width = max(len(name) for name in summary)
    print(f"  {'variant':<{width}}  hits   mean({CLAP_CLASS})")
    for name, s in summary.items():
        print(f"  {name:<{width}}  {s['hits']}/{s['claps']}   {s['mean_clapping_score']:.3f}")
    print(f"  (mean is over the claps where {CLAP_CLASS!r} is in the top {TOP_K}; 0.000 means it never was)")
    if captured:
        best = max(summary.items(), key=lambda kv: (kv[1]["hits"], kv[1]["mean_clapping_score"]))
        print(f"\n  best variant by hits, then mean score: {best[0]}")


def _json_report(args, prof, captured, summary, interrupted: bool) -> dict:
    return {
        "profile": prof.name,
        "rate_hz": int(prof.rate_hz),
        "shots_requested": int(args.shots),
        "shots_captured": len(captured),
        "interrupted": interrupted,
        "claps": [
            {
                "n": i,
                "onset_s": clap.onset_s,
                "duration_s": clap.duration_s,
                "peak_db": clap.peak_db,
                "snr_db": clap.snr_db,
                "variants": {name: [list(item) for item in top] for name, top in variants.items()},
            }
            for i, (clap, variants) in enumerate(captured, start=1)
        ],
        "summary": summary,
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="record real claps and classify the same audio under several preprocessing variants"
    )
    p.add_argument("--shots", type=int, default=5, help="how many claps to record (default 5)")
    p.add_argument("--device", default=None, help="pw-record target (default: the profile's device)")
    p.add_argument("--profile", default="laptop_dmic", help="capture profile (default laptop_dmic)")
    p.add_argument("--lead-in", type=float, default=3.0, help="seconds of quiet recording before the first prompt")
    p.add_argument("--json", action="store_true", help="print one JSON object instead of the table")
    p.add_argument("--save-dir", default=None, type=Path, help="write each captured clap as a wav here")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    prof = load_profile(args.profile)

    captured, interrupted = record(args, prof)
    summary = summarise(captured)

    if args.json:
        print(json.dumps(_json_report(args, prof, captured, summary, interrupted), indent=2))
    else:
        if interrupted:
            print("\ninterrupted -- reporting what was captured")
        if not captured:
            print("\nno claps captured")
        _print_summary(captured, summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
