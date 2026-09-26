#!/usr/bin/env python3
"""Measure the backend → frontend path on a real sound (not on the mock).

Every number here is measured, and the three stages are reported separately so
nobody has to guess which one is slow:

  backend   onset → message emitted      (`t` − `t_onset`, both backend clock)
  transport emit → client receipt        (client clock, offset-corrected)
  total     onset → client receipt       the number the README's 1.5 s budget is about

Clock handling: the backend's `t` is seconds since *its* start, the client's is
`time.perf_counter()`. The offset is estimated as the minimum over all received
messages of `(recv_client − t_backend)`, i.e. the least-delayed path — the usual
NTP-style min-filter. That makes `transport` a relative figure and understates
the absolute one-way delay by at most the fastest path's latency (sub-millisecond
on loopback, which is why the loopback case is worth quoting and a Wi-Fi case is
not).

Sound injection is real: a wav is played through the machine's speakers with
`pw-play` while the backend listens on the microphone, exactly like a judge
clapping. `--inject file:/path.wav` uses a real recording if you have one.

Usage:
    tools/run_backend.sh --profile laptop_dmic            # terminal 1
    .venv/bin/python tools/latency_bench.py --shots 3     # terminal 2
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np


PERF = time.perf_counter

# Silence at the head of every generated file. `pw-play` needs ~1 s to start
# (measured 0.25-2.2 s), and without this lead-in the player's start-up eats the
# first burst — with a one-burst file that means the microphone hears *nothing*
# and the run "proves" the array is deaf. This is the fix for that whole class of
# false measurement.
LEAD_IN_S = 1.5
# Where the first burst sits inside the lead-in.
FIRST_BURST_OFFSET_S = 0.10


def _pct(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    return float(np.percentile(np.asarray(values, dtype=np.float64), q))


def _stats(values: list[float]) -> str:
    if not values:
        return "n=0"
    return (
        f"n={len(values)} p50={_pct(values, 50):.1f} p95={_pct(values, 95):.1f} "
        f"p99={_pct(values, 99):.1f} max={max(values):.1f}"
    )


# ---------------------------------------------------------------------------
# Test sounds
# ---------------------------------------------------------------------------
def make_clap(path: Path, shots: int = 1, side: str = "both", rate: int = 16000) -> None:
    """A hand-clap-like transient: the canonical test in this project (A10, C3).

    Broadband noise burst with a fast decay and two early reflections. Not a
    recording — it exists so the measurement is repeatable, and the class the
    classifier returns for it is printed rather than assumed.

    `side` writes the burst to one speaker only, which is what makes a *sign*
    test possible: the left and right speakers sit at known sides of the mic
    pair, so the measured bearing must flip with them.
    """
    import soundfile as sf
    from scipy import signal

    rng = np.random.default_rng(7)
    gap = int(0.7 * rate)
    lead = int(LEAD_IN_S * rate)
    total = lead + shots * (int(0.35 * rate) + gap)
    out = np.zeros(total, dtype=np.float32)
    nyq = rate / 2
    sos = signal.butter(4, [400 / nyq, min(6000 / nyq, 0.95)], btype="bandpass", output="sos")
    for s in range(shots):
        at = lead + s * (int(0.35 * rate) + gap) + int(FIRST_BURST_OFFSET_S * rate)
        n = int(0.25 * rate)
        burst = np.zeros(n)
        for offset, gain in ((0, 1.0), (int(0.011 * rate), 0.45), (int(0.027 * rate), 0.25)):
            body = rng.standard_normal(int(0.006 * rate)) * gain
            burst[offset : offset + len(body)] += body
        burst *= np.exp(-np.arange(n) / (0.02 * rate))
        out[at : at + n] += signal.sosfilt(sos, burst).astype(np.float32)
    out /= max(float(np.abs(out).max()), 1e-9)
    out *= 0.95
    sf.write(path, _stereo(out, side), rate, subtype="PCM_16")


def _stereo(mono: np.ndarray, side: str) -> np.ndarray:
    """Route a mono signal to both speakers, or to one (a lateralized source)."""
    gl = 0.0 if side == "right" else 1.0
    gr = 0.0 if side == "left" else 1.0
    return np.stack([mono * gl, mono * gr], axis=1)


def make_tone(path: Path, shots: int = 1, side: str = "both", freqs: tuple[float, float] = (900.0, 2600.0), rate: int = 16000) -> None:
    """Smoke-alarm-ish two-tone bursts: an `urgent` class, for the tier path."""
    import soundfile as sf

    gap = int(0.6 * rate)
    body = int(0.30 * rate)
    lead = int(LEAD_IN_S * rate)
    out = np.zeros(lead + shots * (body + gap), dtype=np.float32)
    t = np.arange(body) / rate
    env = np.minimum(1.0, np.minimum(t / 0.01, (body / rate - t) / 0.02)).clip(0)
    sig = 0.5 * (np.sin(2 * np.pi * freqs[0] * t) + np.sin(2 * np.pi * freqs[1] * t)) * env
    for s in range(shots):
        at = lead + s * (body + gap) + int(FIRST_BURST_OFFSET_S * rate)
        out[at : at + body] += sig.astype(np.float32)
    out *= 0.9
    sf.write(path, _stereo(out, side), rate, subtype="PCM_16")


def build_injects(spec: str, side: str, tmp: Path, shots: int) -> list[tuple[Path, str]]:
    """[(wav, side)] — two entries when the caller asked for a sign-flip test.

    All `shots` bursts live *inside* the file, played by one player process. The
    first version started a `pw-play` per shot and relied on the gap between
    them; measured start-up is 0.25–2.2 s, so shots overlapped, merged into one
    detected segment, and the sign-flip test compared sounds that were playing
    simultaneously.
    """
    if spec.startswith("file:"):
        return [(Path(spec.split(":", 1)[1]), side)]
    make = make_tone if spec == "tone" else make_clap
    if side == "flip":
        left, right = tmp / f"{spec}_left.wav", tmp / f"{spec}_right.wav"
        make(left, shots, "left")
        make(right, shots, "right")
        return [(left, "left"), (right, "right")]
    path = tmp / f"{spec}_{side}.wav"
    make(path, shots, side)
    return [(path, side)]


def shot_gap(spec: str) -> float:
    """Spacing between bursts inside a generated file (seconds)."""
    return 0.9 if spec == "tone" else 1.05


def resolve_sink(explicit: str | None) -> str | None:
    """The sink to play into: the caller's choice, else the current default.

    Pinned for the whole run on purpose. A default sink that moves mid-run (a
    Bluetooth headset appearing, a monitor being re-routed) silently sends the
    stimulus somewhere the microphone cannot hear, and the run then "proves" the
    array is deaf. That is a mistake this tool has already made once.
    """
    import shutil

    if explicit:
        return explicit
    if shutil.which("wpctl") is None:
        return None
    try:
        out = subprocess.run(
            ["wpctl", "inspect", "@DEFAULT_AUDIO_SINK@"],
            capture_output=True, text=True, timeout=2.0, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        if "node.name" in line:
            return line.split("=", 1)[1].strip().strip('"')
    return None


def play(path: Path, sink: str | None = None) -> subprocess.Popen | None:
    """Play a wav through `sink` (or the default). Returns the process."""
    target = ["--target", sink] if sink else []
    for argv in (
        ["pw-play", *target, str(path)],
        ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", str(path)],
    ):
        try:
            return subprocess.Popen(argv)
        except FileNotFoundError:
            continue
    return None


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------
class Bench:
    def __init__(self, url: str, ping_rate: float):
        self.url = url
        self.ping_rate = ping_rate
        self.events: list[dict] = []
        self.arrivals: list[float] = []       # perf_counter at receipt
        self.rtts: list[float] = []
        self.offsets: list[float] = []
        self.by_type: dict[str, int] = {}
        self.handshake_ms: float | None = None
        self.connect_ms: float | None = None
        self.injected: list[float] = []
        self.switches: list[tuple[float, str]] = []   # (perf, side) when the source moved
        self.errors: list[str] = []
        self.warning = ""
        self.sink: str | None = None
        self.bytes = 0
        self.first_msg_perf: float | None = None
        self.stop = asyncio.Event()

    async def reader(self, ws) -> None:
        while not self.stop.is_set():
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            except Exception as exc:  # connection closed
                if not self.stop.is_set():
                    self.errors.append(f"recv: {exc}")
                return
            now = PERF()
            self.arrivals.append(now)
            self.bytes += len(raw)
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                self.errors.append(f"unparseable: {raw[:80]!r}")
                continue
            kind = msg.get("type", "?")
            self.by_type[kind] = self.by_type.get(kind, 0) + 1
            if kind == "sound_event":
                msg["_recv"] = now
                self.events.append(msg)
                if "t" in msg:
                    self.offsets.append(now - float(msg["t"]))
            if kind == "ping" and "t" in msg:
                # Echo of our own stamp: the HUD's own latency metric (§4.6).
                self.rtts.append((now - float(msg["t"])) * 1e3)

    async def pinger(self, ws) -> None:
        while not self.stop.is_set():
            try:
                await ws.send(json.dumps({"type": "ping", "t": PERF()}))
            except Exception:
                return
            await asyncio.sleep(1.0 / self.ping_rate)

    async def injector(self, segments: list[tuple[Path, str]], gap: float) -> None:
        await asyncio.sleep(2.0)  # let the handshake and status settle
        for wav, side in segments:
            self.switches.append((PERF(), side))
            proc = play(wav, self.sink)
            self.injected.append(PERF())
            if proc is None:
                self.errors.append("no audio player found (pw-play/ffplay)")
                return
            await asyncio.sleep(self.file_seconds(wav) + 0.8)
        if self.injected:
            await asyncio.sleep(1.5)  # let the last event land

    @staticmethod
    def file_seconds(wav: Path) -> float:
        import wave

        try:
            with wave.open(str(wav), "rb") as f:
                return f.getnframes() / float(f.getframerate())
        except (OSError, wave.Error):
            return 0.0

    def side_of(self, recv: float) -> str:
        """Which speaker the sound came from, for a receipt at client time `recv`."""
        side = "?"
        for at, s in self.switches:
            if at <= recv:
                side = s
        return side

    def offset(self) -> float:
        """Min-filtered estimate of (client clock − backend clock)."""
        return min(self.offsets) if self.offsets else 0.0


def sink_volume_warning() -> str:
    """Injected sound is worthless if the sink is muted — say so, do not fix it.

    Changing the user's system volume from a benchmark is rude; reporting that
    the measurement will be meaningless is not.
    """
    import shutil

    if shutil.which("wpctl") is None:
        return ""
    try:
        out = subprocess.run(
            ["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"],
            capture_output=True, text=True, timeout=2.0, check=False,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""
    if not out:
        return ""
    if "MUTED" in out.upper() or out.endswith("0.00"):
        return f"default sink is silent ({out}) — the injected sound will not be audible; raise it with `wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.6`"
    return ""


async def run(args: argparse.Namespace) -> int:
    import websockets

    tmp = Path(tempfile.mkdtemp(prefix="bench-"))
    segments = build_injects(args.inject, args.inject_side, tmp, args.shots)
    gap = shot_gap(args.inject) if args.inject != "none" else 0.0
    bench = Bench(args.url, args.ping_rate)
    bench.sink = resolve_sink(args.sink)
    bench.warning = sink_volume_warning()
    print(f"playback sink: {bench.sink or 'default'}")
    if bench.warning:
        print(f"warning: {bench.warning}", file=sys.stderr)

    t_connect = PERF()
    try:
        async with websockets.connect(args.url, max_size=1 << 22) as ws:
            bench.connect_ms = (PERF() - t_connect) * 1e3
            reader = asyncio.create_task(bench.reader(ws))
            pinger = asyncio.create_task(bench.pinger(ws))
            inj = (
                asyncio.create_task(bench.injector(segments, gap))
                if args.inject != "none"
                else None
            )
            await asyncio.sleep(args.duration)
            bench.stop.set()
            for task in (reader, pinger, inj):
                if task is not None:
                    task.cancel()
            await asyncio.gather(*(t for t in (reader, pinger, inj) if t is not None), return_exceptions=True)
    except OSError as exc:
        print(f"could not connect to {args.url}: {exc}", file=sys.stderr)
        print("hint: start it with tools/run_backend.sh --profile laptop_dmic", file=sys.stderr)
        return 2

    return report(args, bench, segments)


def report(args: argparse.Namespace, bench: Bench, segments: list[tuple[Path, str]]) -> int:
    off = bench.offset()
    gap = shot_gap(args.inject) if args.inject != "none" else 0.0
    transport: list[float] = []
    total: list[float] = []       # onset -> client
    internal: list[float] = []    # onset -> emitted
    from_play: list[float] = []
    rows = []
    sides: dict[str, list[float]] = {}
    for msg in bench.events:
        recv = msg["_recv"]
        t_emit = float(msg.get("t", 0.0))
        t_onset = float(msg.get("t_onset", t_emit))
        tr = (recv - off - t_emit) * 1e3
        tot = (recv - off - t_onset) * 1e3
        transport.append(tr)
        total.append(tot)
        internal.append((t_emit - t_onset) * 1e3)
        side = bench.side_of(recv)
        sides.setdefault(side, []).append(float(msg.get("bearing_deg") or 0.0))
        play_t = max((p for p in bench.injected if p <= recv), default=None)
        if play_t is not None:
            # The burst sits `k` gaps into its file: count how many events of this
            # side have already been seen.
            k = sum(1 for m in bench.events if bench.side_of(m["_recv"]) == side and m["_recv"] < recv)
            from_play.append((recv - play_t - LEAD_IN_S - FIRST_BURST_OFFSET_S - k * gap) * 1e3)
        rows.append(
            (msg.get("id"), msg.get("class"), msg.get("confidence"), msg.get("bearing_deg"),
             msg.get("accuracy_deg"), msg.get("ambiguous"), msg.get("urgency"), msg.get("source"),
             side, internal[-1], tr, tot)
        )

    health: dict = {}
    try:
        with urllib.request.urlopen(args.health, timeout=2.0) as r:
            health = json.load(r)
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        health = {"error": str(exc)}

    ar = [b - a for a, b in zip(bench.arrivals, bench.arrivals[1:])]
    # Stimulus check: every event carries the segment SNR the backend measured.
    # Without this, a muted sink or a mis-routed player produces a confident
    # "the array cannot hear it" conclusion from a run where nothing was audible
    # (which is exactly how this tool's author once mis-diagnosed a working
    # microphone). Below the threshold the run is reported as inconclusive.
    snrs = [float(m["snr_db"]) for m in bench.events if isinstance(m.get("snr_db"), (int, float))]
    best_snr = max(snrs) if snrs else None
    conclusive = best_snr is not None and best_snr >= args.require_snr_db
    out = {
        "url": args.url,
        "duration_s": args.duration,
        "injected": [str(p) for p, _ in segments],
        "connect_ms": bench.connect_ms,
        "messages": bench.by_type,
        "events": len(bench.events),
        "bytes": bench.bytes,
        "stimulus": {
            "best_snr_db": best_snr,
            "require_snr_db": args.require_snr_db,
            "conclusive": conclusive,
            "sink_warning": bench.warning,
        },
        "rtt_ms": {"p50": _pct(bench.rtts, 50), "p95": _pct(bench.rtts, 95), "n": len(bench.rtts)},
        "backend_onset_to_emit_ms": {"p50": _pct(internal, 50), "p95": _pct(internal, 95)},
        "transport_emit_to_client_ms": {"p50": _pct(transport, 50), "p95": _pct(transport, 95)},
        "onset_to_client_ms": {"p50": _pct(total, 50), "p95": _pct(total, 95)},
        "from_play_command_ms": {"p50": _pct(from_play, 50), "p95": _pct(from_play, 95)},
        "arrival_gap_ms": {"p50": _pct(ar, 50), "max": max(ar) * 1e3 if ar else None},
        "bearings_by_side": {k: [round(v, 1) for v in vals] for k, vals in sides.items()},
        "health": health,
        "errors": bench.errors,
        "rows": rows,
    }
    if args.json:
        print(json.dumps(out, default=str))
        return 0

    print("\n=== backend ↔ frontend, real sound ===")
    print(f"url {args.url}   injected {[str(p) for p, _ in segments]} ({args.shots} bursts each, {gap:.2f}s apart inside the file)")
    print(f"connect {bench.connect_ms:.1f} ms   messages {bench.by_type}")
    print(f"ping echo RTT (the HUD's own metric)  {_stats(bench.rtts)}")
    print(f"backend onset→emit                    {_stats(internal)}")
    print(f"emit→client (clock-corrected)         {_stats(transport)}")
    print(f"onset→client  <-- the README's number {_stats(total)}")
    if from_play:
        print(f"play command→client (incl. player)    {_stats(from_play)}")
    print(f"arrival gap: p50 {_pct(ar, 50) * 1e3:.1f} ms max {(max(ar) * 1e3 if ar else 0):.1f} ms")
    if best_snr is None:
        print(f"stimulus: no event carried an SNR — nothing measurable arrived")
    else:
        verdict = "OK" if conclusive else "INCONCLUSIVE"
        print(f"stimulus: best event SNR {best_snr:.1f} dB (need >= {args.require_snr_db:.0f}) -> {verdict}")
        if not conclusive:
            print("          the injected sound barely rose above the room: check the sink routing/volume")
            print("          and that the backend's --device points at the microphone you think it does")
    print(f"health: {json.dumps({k: v for k, v in health.items() if k != 'source'} if health else {})}")
    if isinstance(health.get("source"), dict):
        print(f"source: {json.dumps(health['source'])}")
    if rows:
        print(f"\n{'id':<8} {'class':<22} {'conf':>5} {'bearing':>8} {'±':>5} {'amb':<5} {'urg':<7} {'source':<12} {'side':<6} {'backend':>7} {'trans':>6} {'total':>7}")
        for r in rows:
            print(f"{str(r[0]):<8} {str(r[1])[:22]:<22} {float(r[2] or 0):>5.2f} "
                  f"{float(r[3] or 0):>+8.1f} {float(r[4] or 0):>5.0f} {str(bool(r[5])):<5} {str(r[6]):<7} {str(r[7]):<12} "
                  f"{str(r[8]):<6} {r[9]:>7.0f} {r[10]:>6.1f} {r[11]:>7.0f}")
    if len(segments) == 2 and (sides.get("left") or sides.get("right")):
        # The A10 sign-flip test, on real hardware: the left speaker is physically
        # to the array's left, so a localized event must carry a negative bearing.
        # Only events that actually got a bearing count — an event with no estimate
        # (`source: none`, `accuracy_deg` 180) is not evidence of a wrong sign.
        localized = {
            side: [m["bearing_deg"] for m in bench.events if bench.side_of(m["_recv"]) == side and m.get("source") != "none"]
            for side in ("left", "right")
        }
        out["bearings_by_side_localized"] = localized
        left, right = localized["left"], localized["right"]
        if not left or not right:
            missing = "left" if not left else "right"
            print(
                f"\nsign flip: no localized event for the {missing} side "
                f"({len(sides.get('left', []))} left / {len(sides.get('right', []))} right events arrived) — "
                "the array could not measure this source, so there is nothing to compare"
            )
        else:
            ok = all(v < 0 for v in left) and all(v > 0 for v in right)
            print(
                f"\nsign flip: left {[round(v, 1) for v in left]}  right {[round(v, 1) for v in right]}  -> "
                f"{'OK' if ok else 'MISMATCH (channel order or bearing convention)'}"
            )
            out["sign_flip_ok"] = ok
    if bench.errors:
        print(f"\nproblems: {bench.errors}")
    print()
    if not bench.events:
        return 1
    return 0 if conclusive else 3


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="backend ↔ frontend latency, measured on a real sound")
    p.add_argument("--url", default="ws://127.0.0.1:8000/ws")
    p.add_argument("--health", default="http://127.0.0.1:8000/health")
    p.add_argument("--duration", type=float, default=18.0, help="seconds to listen")
    p.add_argument("--ping-rate", type=float, default=5.0, help="ping/s (the HUD uses 1)")
    p.add_argument("--inject", default="clap", help="clap | tone | file:/path.wav | none")
    p.add_argument("--sink", default=None, help="PipeWire sink to play into (default: resolved once, then pinned)")
    p.add_argument("--inject-side", default="both", choices=["both", "left", "right", "flip"],
                   help="which speaker plays it; `flip` runs left then right (the sign-flip test)")
    p.add_argument("--shots", type=int, default=3)
    p.add_argument("--require-snr-db", type=float, default=12.0,
                   help="minimum event SNR for the run to count as conclusive (exit 3 otherwise)")
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
