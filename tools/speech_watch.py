#!/usr/bin/env python3
"""Watch the speech path alone: microphone -> VAD -> [YAMNet] -> Whisper.

Two modes, one question each.

  --local   capture the local microphone through the same conditioning and onset
            detector the backend uses, then (optionally) label the segment with
            YAMNet and transcribe it with Whisper. One line per detected
            segment, whether or not it produced a transcript, so a quiet room
            reads as "quiet" rather than "broken".

  --ws      attach to a running backend and print only the speech-related wire
            traffic: every `speech` message, every speech-family `sound_event`,
            a handshake line and periodic counters. It sends nothing but pings.

No HUD, no WebSocket server, no DOA, no camera. The gates mirror `server.fuse`
(segment SNR and top-class confidence), because a tool that disagrees with the
backend about what counts as an event is worse than no tool: the whole point is
to show *why* nothing was transcribed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

# Run as a script (`python tools/speech_watch.py`) and the repo root is not on
# sys.path, only tools/ is. The server package lives at the repo root.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.beam import analysis_channel
from server.config import available_profiles, load_profile
from server.detect import EPS, OnsetDetector, Offset
from server.ingest import BandPass, open_source

if TYPE_CHECKING:
    # Imported lazily at runtime: the TFLite and Whisper stacks are only needed
    # once the mode that uses them is chosen.
    from server.asr import Transcriber
    from server.classify import YAMNet
    from server.config import Profile

log = logging.getLogger("tools.speech_watch")

DEFAULT_WS = "ws://127.0.0.1:8000/ws"
BLOCK_MS = 20.0
# The detector's own maximum segment is 8 s; keep enough history to slice the
# whole thing even for a maximal segment.
RING_SECONDS = 10.0
STATUS_PERIOD_S = 5.0
WS_PING_PERIOD_S = 1.0
WS_COUNTERS_PERIOD_S = 5.0
# A little slack around the detected segment so the ASR gets the attack and the
# tail, not a clipped utterance. Same shape the backend uses.
PRE_ROLL_S = 0.15
POST_ROLL_S = 0.25


# ---------------------------------------------------------------------------
# Ring buffer of conditioned audio
# ---------------------------------------------------------------------------
@dataclass
class Ring:
    """Newest-`capacity` samples of the conditioned (nch, n) stream.

    Absolute sample index maps to a buffer column by `index % capacity`, because
    writes are contiguous from index 0. `written` is the total ever written, which
    is also the onset detector's index domain: it consumes the fed stream in
    order, so detector index == absolute index.
    """

    nch: int
    capacity: int
    buf: np.ndarray = field(init=False)
    pos: int = field(init=False, default=0)
    written: int = field(init=False, default=0)

    def __post_init__(self) -> None:
        self.buf = np.zeros((self.nch, self.capacity), dtype=np.float32)

    def write(self, x: np.ndarray) -> None:
        n = int(x.shape[1])
        if n == 0:
            return
        if n >= self.capacity:
            self.buf[:] = x[:, -self.capacity :]
            self.pos = 0
        else:
            first = min(n, self.capacity - self.pos)
            self.buf[:, self.pos : self.pos + first] = x[:, :first]
            if n > first:
                self.buf[:, : n - first] = x[:, first:]
            self.pos = (self.pos + n) % self.capacity
        self.written += n

    def slice(self, a: int, b: int) -> np.ndarray:
        """Absolute samples [a, b), clamped to what is still buffered."""
        lo = max(int(a), self.written - self.capacity, 0)
        hi = max(lo, min(int(b), self.written))
        return self.buf[:, np.arange(lo, hi) % self.capacity]


# ---------------------------------------------------------------------------
# Local mode
# ---------------------------------------------------------------------------
@dataclass
class Counters:
    segments: int = 0
    transcripts: int = 0
    asr_times: list[float] = field(default_factory=list)
    confidences: list[float] = field(default_factory=list)
    texts: list[str] = field(default_factory=list)


def _is_speech(cls: str) -> bool:
    """The same class family `server.fuse` transcribes — one definition, not two."""
    from server.fuse import _SPEECHY

    low = cls.lower()
    return any(s in low for s in _SPEECHY)


def _frame_db(frame: np.ndarray) -> float:
    if frame.size == 0:
        return -120.0
    return 10.0 * float(np.log10(float(np.mean(np.square(frame, dtype=np.float64))) + EPS))


def _classify_window(sig: np.ndarray, window: int) -> np.ndarray:
    """The segment's loudest `window` samples, for YAMNet.

    YAMNet scores exactly one 15600-sample window and ignores everything after it,
    so handing it the head of the segment labels the *room* whenever the detector's
    onset landed on a pre-bump (a click, a sink mute) with the real sound arriving
    a moment later. The loudest window answers the question this tool is asked
    ("what is this segment?") for the whole segment.
    """
    if sig.size <= window:
        return sig
    stride = max(1, window // 10)
    best_k, best_e = 0, -1.0
    for k in range(0, sig.size - window + 1, stride):
        e = float(np.mean(np.square(sig[k : k + window], dtype=np.float64)))
        if e > best_e:
            best_k, best_e = k, e
    return sig[best_k : best_k + window]


def _status_line(detector: OnsetDetector, mono: np.ndarray, hop: int, elapsed: float, stats: Counters) -> None:
    frame = mono[-hop:] if mono.size >= hop else mono
    print(
        f"[{elapsed:6.1f}s] floor {detector.floor_db:6.1f}dB frame {_frame_db(frame):6.1f}dB "
        f"segments {stats.segments} transcripts {stats.transcripts}",
        flush=True,
    )


def _report_segment(
    off: Offset,
    *,
    ring: Ring,
    prof: Profile,
    ml: YAMNet | None,
    asr: Transcriber | None,
    t0_us: int,
    args: argparse.Namespace,
    stats: Counters,
) -> None:
    """One detected segment -> one line, transcript or not."""
    rate = prof.rate_hz
    t = (off.onset.t_us - t0_us) / 1e6
    snr = float(off.onset.snr_db)
    peak = float(off.peak_db)
    stats.segments += 1

    start = max(0, off.onset.index - int(round(PRE_ROLL_S * rate)))
    end = off.index + int(round(POST_ROLL_S * rate))
    seg = ring.slice(start, end)
    sig = analysis_channel(seg, prof) if seg.shape[1] else np.zeros(0, dtype=np.float32)

    cls: str | None = None
    conf: float | None = None
    if ml is not None and sig.size:
        top = ml.top(_classify_window(sig, ml.window), k=1)
        if top:
            cls, conf = top[0][0], float(top[0][1])

    reasons: list[str] = []
    if snr < args.min_snr:
        reasons.append(f"snr {snr:.1f}dB < {args.min_snr:.1f}")
    if conf is not None and conf < args.min_confidence:
        reasons.append(f"confidence {conf:.2f} < {args.min_confidence:.2f}")

    parts = [f"[{t:7.2f}s]", f"dur {off.duration_s:.2f}s", f"snr {snr:.1f}dB", f"peak {peak:.1f}dB"]
    if cls is not None:
        parts.append(f"class {cls} {conf:.2f}")

    if reasons:
        tail = "skipped: " + "; ".join(reasons)
    elif cls is not None and not _is_speech(cls):
        tail = f"not speech ({cls})"
    elif asr is None:
        tail = "asr off"
    else:
        # Decoded inline: this watch tool is not the real-time pipeline, and the
        # ring already holds the segment, so paying the decode here costs only
        # wall time — the audio is preserved rather than dropped.
        t_asr = time.monotonic()
        tr = asr.transcribe(sig)
        dt = time.monotonic() - t_asr
        stats.asr_times.append(dt)
        if tr is None or not tr.text:
            tail = "(no transcript)"
        else:
            stats.transcripts += 1
            stats.confidences.append(float(tr.confidence))
            stats.texts.append(tr.text)
            tail = f'"{tr.text}" (asr {dt:.2f}s, conf {tr.confidence:.2f})'

    print(" ".join(parts) + " -> " + tail, flush=True)


def _summary(stats: Counters) -> None:
    print("\n=== summary ===")
    print(f"segments {stats.segments}  transcripts {stats.transcripts}")
    if stats.asr_times:
        print(
            f"mean asr {float(np.mean(stats.asr_times)):.2f}s  "
            f"mean confidence {float(np.mean(stats.confidences)):.2f}"
        )
    else:
        print("mean asr n/a  mean confidence n/a")
    if stats.texts:
        print("transcripts:")
        for text in stats.texts:
            print(f'  - "{text}"')
    else:
        print("transcripts: none — each segment line above says why")


def run_local(args: argparse.Namespace) -> int:
    prof = load_profile(args.profile)
    rate = prof.rate_hz
    nch = prof.nch
    nsamp = int(round(rate * BLOCK_MS / 1000.0))
    hop = max(1, int(round(rate * 0.010)))

    ring = Ring(nch, int(RING_SECONDS * rate))
    cond = BandPass(rate, nch, prof.highpass_hz, prof.lowpass_hz)
    detector = OnsetDetector(rate)

    ml: YAMNet | None = None
    if not args.no_classify:
        from server.classify import YAMNet

        ml = YAMNet()

    asr: Transcriber | None = None
    if not args.no_asr:
        from server.asr import Transcriber

        asr = Transcriber(model_size=args.asr_model, names=args.names)
        # Force the lazy load now, so an unavailable ASR is known before the first
        # utterance rather than at it.
        asr.transcribe(np.zeros(rate // 2, dtype=np.float32))

    device = args.device or prof.device
    print(f"speech_watch local: profile={prof.name} rate={rate} ch={nch} device={device or 'default'}")
    classify = "off" if ml is None else f"yamnet sha256={ml.sha256[:8]}"
    transcribe = "off" if asr is None else f"{args.asr_model} ({asr.reason})"
    seconds = "forever" if not args.seconds else f"{args.seconds:g}s"
    print(
        f"  classify={classify}  asr={transcribe}  "
        f"gates: snr>={args.min_snr:.1f}dB confidence>={args.min_confidence:.2f}  run={seconds}",
        flush=True,
    )
    if asr is not None and asr.reason != "ok":
        print(f"warning: speech-to-text unavailable ({asr.reason})", file=sys.stderr)

    stats = Counters()
    source = open_source("pw", rate=rate, channels=nch, nsamp=nsamp, device=device)
    source.start()
    t0_us: int | None = None
    last_status_us: int | None = None
    mono = np.zeros(0, dtype=np.float32)
    try:
        for blk in source.blocks():
            if t0_us is None:
                t0_us = blk.t_us
                last_status_us = blk.t_us
            x = cond.process(blk.x)
            ring.write(x)
            mono = analysis_channel(x, prof)
            for ev in detector.push(mono, blk.t_us):
                if isinstance(ev, Offset):
                    _report_segment(
                        ev, ring=ring, prof=prof, ml=ml, asr=asr, t0_us=t0_us, args=args, stats=stats
                    )
            elapsed = (blk.t_us - t0_us) / 1e6
            if last_status_us is not None and blk.t_us - last_status_us >= STATUS_PERIOD_S * 1e6:
                last_status_us = blk.t_us
                _status_line(detector, mono, hop, elapsed, stats)
            if args.seconds and elapsed >= args.seconds:
                break
    except KeyboardInterrupt:
        print()
    finally:
        source.stop()

    _summary(stats)
    return 0


# ---------------------------------------------------------------------------
# PipeWire device list
# ---------------------------------------------------------------------------
def _default_source() -> str | None:
    """The default source's `node.name`, or None if wpctl cannot answer."""
    try:
        out = subprocess.run(
            ["wpctl", "inspect", "@DEFAULT_AUDIO_SOURCE@"],
            capture_output=True,
            text=True,
            timeout=2.0,
            check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        if "node.name" in line:
            return line.split("=", 1)[1].strip().strip('"')
    return None


def list_devices() -> int:
    """The PipeWire source nodes, and which one `--device` should name."""
    try:
        out = subprocess.run(["pw-dump"], capture_output=True, text=True, timeout=10.0, check=False).stdout
        nodes = json.loads(out)
    except FileNotFoundError:
        print("pw-dump not found — install pipewire, or pass --device <node.name> to pw-record", file=sys.stderr)
        return 1
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        print(f"pw-dump failed: {exc}", file=sys.stderr)
        return 1

    default = _default_source()
    rows: list[tuple[str, str, str]] = []
    for node in nodes:
        if node.get("type") != "PipeWire:Interface:Node":
            continue
        props = (node.get("info") or {}).get("props") or {}
        if not str(props.get("media.class", "")).startswith("Audio/Source"):
            continue
        rows.append(
            (
                str(props.get("object.serial", "?")),
                str(props.get("node.name", "?")),
                str(props.get("node.description", "")),
            )
        )
    if not rows:
        print("no PipeWire audio sources found")
        return 1

    print(f"PipeWire audio sources ({len(rows)}) — give one to --device (pw-record --target):")
    for serial, name, desc in rows:
        mark = " (default)" if default and name == default else ""
        print(f"  [{serial}] {name}  {desc}{mark}")
    return 0


# ---------------------------------------------------------------------------
# WebSocket mode
# ---------------------------------------------------------------------------
def _latency(msg: dict) -> str:
    """`t - t_onset`: the backend's own measure of onset -> message."""
    try:
        return f"onset→msg {float(msg['t']) - float(msg['t_onset']):.2f}s"
    except (KeyError, TypeError, ValueError):
        return "onset→msg n/a"


async def run_ws(args: argparse.Namespace) -> int:
    import websockets

    url = args.ws
    t_start = time.monotonic()
    last_ping = t_start
    last_counters = t_start
    counts: dict[str, int] = {}
    status: dict = {}
    array: dict = {}
    handshake_done = False
    n_speech_events = n_speech = n_transcripts = n_ping = 0
    rtts: list[float] = []

    def counters() -> str:
        rtt = f"{float(np.mean(rtts)):.1f}ms" if rtts else "n/a"
        return (
            f"counters {time.monotonic() - t_start:5.1f}s  msgs {sum(counts.values())} "
            f"sound_event {counts.get('sound_event', 0)} speech_events {n_speech_events} "
            f"speech {n_speech} transcripts {n_transcripts} pings {n_ping} rtt {rtt}"
        )

    def handshake() -> None:
        sha = str(status.get("model_sha256", ""))
        cal = array.get("calibration") or {}
        print(
            f"handshake {url}  transport={status.get('transport', '?')} "
            f"model={status.get('model', '?')}:{sha[:8] or '-'} profile={cal.get('profile', '?')} "
            f"source={status.get('source', '?')} asr={status.get('asr', '?')} "
            f"rate={status.get('sample_rate', '?')} floor={status.get('noise_floor_db', '?')}dB",
            flush=True,
        )

    print(f"attaching to {url} (Ctrl-C to stop)", flush=True)
    try:
        async with websockets.connect(url, max_size=1 << 22) as ws:
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
                except asyncio.TimeoutError:
                    raw = None
                except Exception as exc:
                    print(f"{url}: connection closed: {exc}", file=sys.stderr)
                    break

                now = time.monotonic()
                if raw is not None:
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        counts["_bad"] = counts.get("_bad", 0) + 1
                        msg = {}
                    if isinstance(msg, dict):
                        kind = str(msg.get("type", "?"))
                        counts[kind] = counts.get(kind, 0) + 1
                        if kind == "backend_status":
                            status = msg
                        elif kind == "array_status":
                            array = msg
                        elif kind == "speech":
                            n_speech += 1
                            text = str(msg.get("text", ""))
                            if text:
                                n_transcripts += 1
                            print(
                                f"speech {msg.get('id', '?')} parent={msg.get('parent_event', '?')} "
                                f"conf {float(msg.get('confidence', 0.0)):.2f} {_latency(msg)} "
                                f'{msg.get("lang", "?")} "{text}"',
                                flush=True,
                            )
                        elif kind == "sound_event":
                            cls = str(msg.get("class", ""))
                            if _is_speech(cls):
                                n_speech_events += 1
                                print(
                                    f"event {msg.get('id', '?')} class={cls} "
                                    f"{float(msg.get('confidence', 0.0)):.2f} "
                                    f"snr {float(msg.get('snr_db', 0.0)):.1f}dB "
                                    f"urg={msg.get('urgency', '?')} {_latency(msg)}",
                                    flush=True,
                                )
                        elif kind == "ping":
                            n_ping += 1
                            if "t" in msg:
                                rtts.append((time.perf_counter() - float(msg["t"])) * 1e3)

                    if not handshake_done and status and (array or now - t_start > 1.0):
                        handshake_done = True
                        handshake()

                if now - last_ping >= WS_PING_PERIOD_S:
                    last_ping = now
                    await ws.send(json.dumps({"type": "ping", "t": time.perf_counter()}))
                if now - last_counters >= WS_COUNTERS_PERIOD_S:
                    last_counters = now
                    print(counters(), flush=True)
                if args.seconds and now - t_start >= args.seconds:
                    break
    except OSError as exc:
        print(f"could not connect to {url}: {exc}", file=sys.stderr)
        print("hint: start it with tools/run_backend.sh --profile laptop_dmic", file=sys.stderr)
        return 2

    print(counters(), flush=True)
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="tools/speech_watch.py",
        description="speech detection + transcription watch (local microphone, or a live backend)",
    )
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--local", action="store_true", help="microphone -> VAD -> [YAMNet] -> Whisper (default)")
    mode.add_argument(
        "--ws",
        nargs="?",
        const=DEFAULT_WS,
        default=None,
        metavar="URL",
        help=f"attach to a running backend and print speech traffic (default {DEFAULT_WS})",
    )
    p.add_argument("--seconds", type=float, default=60.0, help="run time in seconds; 0 = forever")
    p.add_argument("--device", default=None, help="pw-record --target (node name or serial)")
    p.add_argument("--device-list", action="store_true", help="print the PipeWire source nodes and exit")
    p.add_argument(
        "--profile",
        default="laptop_dmic",
        help=f"array geometry: one of {', '.join(available_profiles())}",
    )
    p.add_argument("--names", default="", help="comma-separated names to spot in speech")
    p.add_argument("--min-confidence", type=float, default=0.0,
                   help="top-class score gate (default 0 = transcribe anything speech-like, matching the backend)")
    p.add_argument("--min-snr", type=float, default=0.0,
                   help="segment SNR gate in dB (default 0 = off, matching the backend)")
    p.add_argument("--asr-model", default="base.en")
    p.add_argument("--no-classify", action="store_true", help="skip YAMNet: VAD + ASR only")
    p.add_argument("--no-asr", action="store_true", help="VAD + class only")
    p.add_argument("--log-level", default="WARNING")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.WARNING),
        format="%(asctime)s %(levelname)-7s %(name)-22s %(message)s",
        datefmt="%H:%M:%S",
    )
    args.names = tuple(n.strip() for n in args.names.split(",") if n.strip())

    if args.device_list:
        return list_devices()
    if args.ws is not None:
        try:
            return asyncio.run(run_ws(args))
        except KeyboardInterrupt:
            return 130
    try:
        return run_local(args)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
