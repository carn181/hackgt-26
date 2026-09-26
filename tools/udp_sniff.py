"""§4.2 packet sniffer/verifier for the hat -> backend UDP audio link.

Why: README §0 item A5 is graded on numbers the hat cannot print itself
(`magic=0xA14D`, `nch=4`, seq gaps < 0.1 %), so somebody has to watch the bytes
on the wire. This tool binds the capture port with SO_REUSEADDR|SO_REUSEPORT so
it can sit on :7000 while `server/main.py` is also bound there.

Two caveats worth knowing before trusting a readout:

* Linux load-balances unicast datagrams between SO_REUSEPORT sockets by flow
  hash, so when the backend is up too, each socket sees only a share of the
  traffic. Run this tool alone (or before the backend starts) for the full
  picture.
* A packet is 18 + 2*nch*nsamp bytes (2578 B at 4 ch x 320 samples), above the
  1500 B Ethernet MTU: loopback and USB-CDC are clean, WiFi will fragment.

`--selftest` needs no hardware: it synthesises 3 s of well-formed packets and
runs the ordinary receive path against a loopback port, so the tool is provable
before the ESP32 exists.
"""

from __future__ import annotations

import argparse
import json
import logging
import select
import socket
import struct
import sys
import threading
import time
from dataclasses import dataclass, field

import numpy as np

log = logging.getLogger("tools.udp_sniff")

# ---------------------------------------------------------------------------
# Frozen wire contract (README §4.2) — do not change unilaterally.
# ---------------------------------------------------------------------------
PKT_HDR = struct.Struct("<HBBIQH")  # magic u16, version u8, nch u8, seq u32, t_us u64, nsamp u16
PKT_HDR_SIZE = PKT_HDR.size  # 18
PKT_MAGIC = 0xA14D
PKT_VERSION = 1
SAMPLE_DTYPE = np.dtype("<i2")

RATE_HZ = 16000
NOMINAL_NSAMP = 320  # 20 ms block
NOMINAL_PPS = 50.0
NOMINAL_INTERVAL_MS = 1000.0 / NOMINAL_PPS

# A4 expectations: silence is tens of LSB, speech hundreds-to-thousands.
SILENT_RMS_LSB = 50.0
CLIP_DC_LSB = 30000.0
CLIP_PEAK_LSB = 32767

SELFTEST_SECONDS = 3.0
SELFTEST_TONE_HZ = 1000.0
SELFTEST_TONE_LSB = 3000.0
SELFTEST_NOISE_LSB = 30.0
SELFTEST_SEED = 0xA14D
REJECT_PRINT_LIMIT = 5


class PacketError(Exception):
    """A §4.2 framing violation. `kind` is the stable key of the reject counter."""

    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail


def validate_packet(data: bytes, nch_expected: int) -> tuple[np.ndarray, int, int]:
    """Check one datagram against §4.2; return (samples (nch, nsamp) i16, seq, nsamp).

    The ESP32 clock (`t_us`) is unpacked but not tracked: this tool's timings are
    host arrival times, so nothing here depends on the hat's monotonic counter.
    """
    if len(data) < PKT_HDR_SIZE:
        raise PacketError("runt", f"len={len(data)} < header {PKT_HDR_SIZE}")
    magic, version, nch, seq, _t_us, nsamp = PKT_HDR.unpack_from(data, 0)
    if magic != PKT_MAGIC:
        raise PacketError("magic", f"magic=0x{magic:04X} != 0x{PKT_MAGIC:04X}")
    if version != PKT_VERSION:
        raise PacketError("version", f"version={version} != {PKT_VERSION}")
    if nch != nch_expected:
        raise PacketError("nch", f"nch={nch} != {nch_expected}")
    if nsamp == 0:
        raise PacketError("nsamp", "nsamp=0")
    need = PKT_HDR_SIZE + 2 * nch * nsamp
    if len(data) != need:
        raise PacketError("length", f"len={len(data)} != {need} (18 + 2*{nch}*{nsamp})")
    samples = np.frombuffer(data, dtype=SAMPLE_DTYPE, count=nch * nsamp, offset=PKT_HDR_SIZE)
    return samples.reshape(nch, nsamp), int(seq), int(nsamp)


@dataclass
class Snapshot:
    """One readout: a window, or the whole run."""

    label: str
    t_s: float
    window_s: float
    packets: int
    nbytes: int
    pps: float
    gaps: int
    lost: int
    gap_pct: float
    dups: int
    first_seq: int | None
    last_seq: int | None
    jitter_n: int
    jitter_mean_ms: float | None
    jitter_p95_ms: float | None
    jitter_max_ms: float | None
    nsamp_seen: list[int]
    rms_lsb: list[float]
    dc_lsb: list[float]
    peak_lsb: list[int]
    flags: list[list[str]]


class Stats:
    """Running counters and per-channel accumulators for one window (or a run)."""

    def __init__(self, nch: int) -> None:
        self.nch = nch
        self.packets = 0
        self.nbytes = 0
        self.gaps = 0
        self.lost = 0
        self.dups = 0
        self.first_seq: int | None = None
        self.last_seq: int | None = None
        self.nsamp_seen: set[int] = set()
        self.jitter_ms: list[float] = []
        self._last_arrival: float | None = None
        self._sum = np.zeros(nch, dtype=np.float64)
        self._sumsq = np.zeros(nch, dtype=np.float64)
        self._peak = np.zeros(nch, dtype=np.float64)
        self._nsamp = 0

    def add(self, samples: np.ndarray, seq: int, nsamp: int, arrival: float) -> None:
        self.packets += 1
        self.nbytes += PKT_HDR_SIZE + 2 * samples.size
        self.nsamp_seen.add(nsamp)
        if self._last_arrival is not None:
            delta_ms = (arrival - self._last_arrival) * 1000.0
            self.jitter_ms.append(abs(delta_ms - NOMINAL_INTERVAL_MS))
        self._last_arrival = arrival
        if self.last_seq is not None:
            step = (seq - self.last_seq) & 0xFFFFFFFF  # seq wraps
            if step == 0:
                self.dups += 1
            elif step > 1:
                self.gaps += 1
                self.lost += step - 1
        if self.first_seq is None:
            self.first_seq = seq
        self.last_seq = seq
        x = samples.astype(np.float64)
        self._sum += x.sum(axis=1)
        self._sumsq += np.einsum("ij,ij->i", x, x)
        self._peak = np.maximum(self._peak, np.abs(x).max(axis=1))
        self._nsamp += nsamp

    def snapshot(self, label: str, t_s: float, window_s: float) -> Snapshot:
        nch = self.nch
        rms = np.zeros(nch)
        dc = np.zeros(nch)
        peak = np.zeros(nch, dtype=np.int64)
        flags: list[list[str]] = [[] for _ in range(nch)]
        if self._nsamp:
            rms = np.sqrt(self._sumsq / self._nsamp)
            dc = self._sum / self._nsamp
            peak = np.rint(self._peak).astype(np.int64)
            for ch in range(nch):
                if rms[ch] < SILENT_RMS_LSB:
                    flags[ch].append("SILENT")
                if abs(dc[ch]) > CLIP_DC_LSB or peak[ch] >= CLIP_PEAK_LSB:
                    flags[ch].append("CLIPPED")
        else:
            flags = [["NO_DATA"] for _ in range(nch)]
        jitter = np.asarray(self.jitter_ms, dtype=np.float64)
        have_jitter = jitter.size > 0
        denom = self.packets + self.lost
        return Snapshot(
            label=label,
            t_s=t_s,
            window_s=window_s,
            packets=self.packets,
            nbytes=self.nbytes,
            pps=self.packets / window_s if window_s > 0 else 0.0,
            gaps=self.gaps,
            lost=self.lost,
            gap_pct=100.0 * self.lost / denom if denom else 0.0,
            dups=self.dups,
            first_seq=self.first_seq,
            last_seq=self.last_seq,
            jitter_n=int(jitter.size),
            jitter_mean_ms=float(jitter.mean()) if have_jitter else None,
            jitter_p95_ms=float(np.percentile(jitter, 95.0)) if have_jitter else None,
            jitter_max_ms=float(jitter.max()) if have_jitter else None,
            nsamp_seen=sorted(self.nsamp_seen),
            rms_lsb=[float(v) for v in rms],
            dc_lsb=[float(v) for v in dc],
            peak_lsb=[int(v) for v in peak],
            flags=flags,
        )


@dataclass
class RejectTally:
    counts: dict[str, int] = field(default_factory=dict)
    total: int = 0
    printed: int = 0

    def add(self, kind: str) -> None:
        self.counts[kind] = self.counts.get(kind, 0) + 1
        self.total += 1


# ---------------------------------------------------------------------------
# Readout
# ---------------------------------------------------------------------------
def _fmt_flags(flags: list[str]) -> str:
    return ",".join(flags) if flags else "ok"


def _fmt_channel(ch: int, rms: float, dc: float, peak: int, flags: list[str]) -> str:
    if "NO_DATA" in flags:
        return f"ch{ch}=--"
    if flags:
        return f"ch{ch}={_fmt_flags(flags)},rms={rms:.1f},dc={dc:.1f},peak={peak}"
    return f"ch{ch}={rms:.1f}"


def _fmt_nsamp(seen: list[int]) -> str:
    if not seen:
        return "none"
    if seen == [NOMINAL_NSAMP]:
        return str(NOMINAL_NSAMP)
    return f"{seen} (expected {NOMINAL_NSAMP})"


def _human_window(s: Snapshot) -> str:
    chans = " ".join(
        _fmt_channel(ch, s.rms_lsb[ch], s.dc_lsb[ch], s.peak_lsb[ch], s.flags[ch])
        for ch in range(len(s.rms_lsb))
    )
    if s.jitter_mean_ms is None:
        jitter = f"jitter_ms(dev-{NOMINAL_INTERVAL_MS:g})=n/a"
    else:
        jitter = (
            f"jitter_ms(dev-{NOMINAL_INTERVAL_MS:g}) mean={s.jitter_mean_ms:.2f} "
            f"p95={s.jitter_p95_ms:.2f} max={s.jitter_max_ms:.2f}"
        )
    return (
        f"[{s.t_s:7.1f}s] pkt={s.packets:6d} pps={s.pps:6.1f}/{NOMINAL_PPS:g} "
        f"gaps={s.gaps} lost={s.lost} ({s.gap_pct:.3f}%) {jitter} | RMS_lsb {chans}"
    )


def _human_final(s: Snapshot, tally: RejectTally) -> str:
    seq_line = (
        f"seq:    first={s.first_seq if s.first_seq is not None else '-'} "
        f"last={s.last_seq if s.last_seq is not None else '-'} "
        f"gaps={s.gaps} lost={s.lost} ({s.gap_pct:.3f}%) dups={s.dups}"
    )
    if s.jitter_mean_ms is None:
        jitter_line = f"jitter: n/a (need two packets; deviation from {NOMINAL_INTERVAL_MS:g} ms)"
    else:
        jitter_line = (
            f"jitter: mean={s.jitter_mean_ms:.2f} ms p95={s.jitter_p95_ms:.2f} "
            f"max={s.jitter_max_ms:.2f} over {s.jitter_n} intervals "
            f"(|delta - {NOMINAL_INTERVAL_MS:g} ms|)"
        )
    lines = [
        f"--- final: {s.window_s:.2f} s, {s.packets} packets, {s.pps:.1f} pps "
        f"(nominal {NOMINAL_PPS:g}), {s.nbytes} B ---",
        seq_line,
        jitter_line,
        f"nsamp:  {_fmt_nsamp(s.nsamp_seen)}",
        "ch   rms_lsb    dc_lsb     peak   flags",
    ]
    for ch in range(len(s.rms_lsb)):
        lines.append(
            f"{ch:2d}{s.rms_lsb[ch]:10.1f}{s.dc_lsb[ch]:11.1f}{s.peak_lsb[ch]:9d}   "
            f"{_fmt_flags(s.flags[ch])}"
        )
    if tally.total == 0:
        lines.append("rejects: none")
    else:
        detail = " ".join(f"{k}={v}" for k, v in sorted(tally.counts.items()))
        lines.append(f"rejects: {tally.total} total ({detail})")
    return "\n".join(lines)


def _snapshot_obj(s: Snapshot, tally: RejectTally) -> dict:
    return {
        "type": s.label,
        "t": round(s.t_s, 6),
        "window_s": round(s.window_s, 6),
        "packets": s.packets,
        "pps": round(s.pps, 3),
        "expected_pps": NOMINAL_PPS,
        "bytes": s.nbytes,
        "seq": {
            "first": s.first_seq,
            "last": s.last_seq,
            "gaps": s.gaps,
            "lost": s.lost,
            "gap_pct": round(s.gap_pct, 6),
            "dups": s.dups,
        },
        "jitter_ms": {
            "nominal": NOMINAL_INTERVAL_MS,
            "n": s.jitter_n,
            "mean": None if s.jitter_mean_ms is None else round(s.jitter_mean_ms, 4),
            "p95": None if s.jitter_p95_ms is None else round(s.jitter_p95_ms, 4),
            "max": None if s.jitter_max_ms is None else round(s.jitter_max_ms, 4),
        },
        "nsamp": s.nsamp_seen,
        "expected_nsamp": NOMINAL_NSAMP,
        "channels": [
            {
                "id": ch,
                "rms_lsb": round(s.rms_lsb[ch], 3),
                "mean_lsb": round(s.dc_lsb[ch], 3),
                "peak_lsb": s.peak_lsb[ch],
                "flags": s.flags[ch],
            }
            for ch in range(len(s.rms_lsb))
        ],
        "rejects": {"total": tally.total, "by_reason": dict(sorted(tally.counts.items()))},
    }


class Output:
    """All stdout in one place: human readout by default, one JSON object per line with --json."""

    def __init__(self, json_mode: bool) -> None:
        self.json_mode = json_mode
        self.rejects = RejectTally()

    def _emit(self, obj: dict, human: str) -> None:
        print(json.dumps(obj, separators=(",", ":")) if self.json_mode else human, flush=True)

    def bind(
        self,
        *,
        host: str,
        port: int,
        nch: int,
        expected_bytes: int,
        duration: float,
        summary_every: float,
        selftest: bool,
    ) -> None:
        sockopts = "SO_REUSEADDR|SO_REUSEPORT" if hasattr(socket, "SO_REUSEPORT") else "SO_REUSEADDR"
        dur = "forever (Ctrl-C to stop)" if duration <= 0 else f"{duration:g} s"
        human = (
            f"listening on {host}:{port} ({sockopts}) | {nch} ch | expect packet {expected_bytes} B "
            f"= 18 + 2*{nch}*{NOMINAL_NSAMP} | nominal {NOMINAL_PPS:g} pps ({NOMINAL_INTERVAL_MS:g} ms) "
            f"| duration {dur} | summary every {summary_every:g} s"
            + (" | selftest" if selftest else "")
        )
        self._emit(
            {
                "type": "bind",
                "host": host,
                "port": port,
                "channels": nch,
                "expected_packet_bytes": expected_bytes,
                "expected_nsamp": NOMINAL_NSAMP,
                "nominal_pps": NOMINAL_PPS,
                "nominal_interval_ms": NOMINAL_INTERVAL_MS,
                "duration_s": duration,
                "summary_every_s": summary_every,
                "selftest": selftest,
            },
            human,
        )

    def reject(self, src: str, nbytes: int, kind: str, detail: str) -> None:
        self.rejects.add(kind)
        if self.rejects.printed >= REJECT_PRINT_LIMIT:
            return
        self.rejects.printed += 1
        self._emit(
            {
                "type": "reject",
                "reason": kind,
                "src": src,
                "len": nbytes,
                "detail": detail,
                "seen": self.rejects.total,
            },
            f"reject [{kind}] from {src} len={nbytes}: {detail}",
        )
        if self.rejects.printed == REJECT_PRINT_LIMIT:
            self._emit(
                {"type": "note", "note": "reject lines suppressed", "after": REJECT_PRINT_LIMIT},
                f"note: further reject lines suppressed, still counting (limit {REJECT_PRINT_LIMIT})",
            )

    def summary(self, s: Snapshot) -> None:
        self._emit(_snapshot_obj(s, self.rejects), _human_window(s))

    def final(self, s: Snapshot) -> None:
        self._emit(_snapshot_obj(s, self.rejects), _human_final(s, self.rejects))

    def note(self, obj: dict, human: str) -> None:
        self._emit(obj, human)


# ---------------------------------------------------------------------------
# Receive path
# ---------------------------------------------------------------------------
@dataclass
class RunResult:
    packets: int
    pps: float
    elapsed_s: float
    gaps: int
    lost: int
    gap_pct: float
    rejects: dict[str, int]
    reject_total: int
    rms_lsb: list[float]
    peak_lsb: list[int]


def bind_socket(host: str, port: int) -> socket.socket:
    """Bound, non-blocking datagram socket that tolerates a second listener."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if hasattr(socket, "SO_REUSEPORT"):
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    else:  # pragma: no cover - Linux has it; other platforms may not
        log.warning("SO_REUSEPORT unavailable: a second listener on :%d would fail", port)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
    sock.bind((host, port))
    sock.setblocking(False)
    return sock


def run(
    host: str,
    port: int,
    nch: int,
    duration: float,
    summary_every: float,
    out: Output,
    *,
    selftest: bool = False,
    on_ready=None,
) -> RunResult:
    """Receive and validate until the duration expires (0 = forever or Ctrl-C)."""
    expected_bytes = PKT_HDR_SIZE + 2 * nch * NOMINAL_NSAMP
    sock = bind_socket(host, port)
    out.bind(
        host=host,
        port=port,
        nch=nch,
        expected_bytes=expected_bytes,
        duration=duration,
        summary_every=summary_every,
        selftest=selftest,
    )
    if on_ready is not None:
        on_ready()

    window = Stats(nch)
    total = Stats(nch)
    t_start = time.perf_counter()
    window_start = t_start
    next_summary = t_start + summary_every
    deadline = None if duration <= 0 else t_start + duration
    try:
        while True:
            now = time.perf_counter()
            if now >= next_summary:
                out.summary(window.snapshot("summary", t_s=now - t_start, window_s=now - window_start))
                window = Stats(nch)
                window_start = now
                while next_summary <= now:
                    next_summary += summary_every
            if deadline is not None and now >= deadline:
                break
            timeout = next_summary - now
            if deadline is not None:
                timeout = min(timeout, deadline - now)
            ready, _, _ = select.select([sock], [], [], max(timeout, 0.0))
            if not ready:
                continue
            while True:
                try:
                    data, addr = sock.recvfrom(65535)
                except (BlockingIOError, InterruptedError):
                    break
                except OSError as exc:  # e.g. ICMP errors surfaced on the socket
                    log.debug("recvfrom: %s", exc)
                    break
                arrival = time.perf_counter()
                src = f"{addr[0]}:{addr[1]}"
                try:
                    samples, seq, nsamp = validate_packet(data, nch)
                except PacketError as exc:
                    out.reject(src, len(data), exc.kind, exc.detail)
                    continue
                window.add(samples, seq, nsamp, arrival)
                total.add(samples, seq, nsamp, arrival)
                if arrival - now > 0.1:
                    break  # a burst must not starve the summary clock
    except KeyboardInterrupt:
        out.note({"type": "note", "note": "interrupted"}, "interrupted (Ctrl-C); printing final summary")
    finally:
        sock.close()

    end = time.perf_counter()
    final = total.snapshot("final", t_s=end - t_start, window_s=end - t_start)
    out.final(final)
    return RunResult(
        packets=final.packets,
        pps=final.pps,
        elapsed_s=final.window_s,
        gaps=final.gaps,
        lost=final.lost,
        gap_pct=final.gap_pct,
        rejects=dict(out.rejects.counts),
        reject_total=out.rejects.total,
        rms_lsb=final.rms_lsb,
        peak_lsb=final.peak_lsb,
    )


# ---------------------------------------------------------------------------
# Selftest: no hardware required
# ---------------------------------------------------------------------------
def _selftest_sender(port: int, nch: int, stop: threading.Event, ready: threading.Event) -> None:
    """Synthesise §4.2 packets and send them to loopback at the nominal rate.

    Deterministic: fixed RNG seed and a continuous 1 kHz tone phase, so two runs
    produce byte-identical payloads.
    """
    if not ready.wait(timeout=5.0):
        log.error("selftest: receiver never signalled ready")
        return
    nsamp = NOMINAL_NSAMP
    rng = np.random.default_rng(SELFTEST_SEED)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    addr = ("127.0.0.1", port)
    npackets = int(round(SELFTEST_SECONDS * NOMINAL_PPS))
    phase = 2.0 * np.pi * SELFTEST_TONE_HZ * (np.arange(nsamp) / RATE_HZ)
    # Slight per-channel phase offset so a transposed reshape would show up as
    # identical channels in the readout.
    offsets = np.arange(nch, dtype=np.float64)[:, None] * 0.4
    start = time.perf_counter()
    try:
        for seq in range(npackets):
            delay = start + seq / NOMINAL_PPS - time.perf_counter()
            if delay > 0 and stop.wait(delay):
                break
            x = SELFTEST_TONE_LSB * np.sin(phase[None, :] + offsets)
            x += rng.normal(0.0, SELFTEST_NOISE_LSB, size=(nch, nsamp))
            samples = np.clip(x, -32768.0, 32767.0).astype(SAMPLE_DTYPE)
            t_us = int(seq * nsamp / RATE_HZ * 1e6)
            hdr = PKT_HDR.pack(PKT_MAGIC, PKT_VERSION, nch, seq & 0xFFFFFFFF, t_us, nsamp)
            sock.sendto(hdr + samples.tobytes(), addr)
    except OSError as exc:
        log.error("selftest sender failed: %s", exc)
    finally:
        sock.close()


def selftest(out: Output, nch: int, port: int, summary_every: float) -> int:
    """Send-to-self on <port+1> and report OK only for a clean, non-empty stream."""
    if port >= 65535:
        raise SystemExit("selftest needs --port <= 65534 (it listens on port+1)")
    loop_port = port + 1
    stop = threading.Event()
    ready = threading.Event()
    sender = threading.Thread(
        target=_selftest_sender,
        args=(loop_port, nch, stop, ready),
        name="selftest-tx",
        daemon=True,
    )
    sender.start()
    result = run(
        "127.0.0.1",
        loop_port,
        nch,
        SELFTEST_SECONDS,
        summary_every,
        out,
        selftest=True,
        on_ready=ready.set,
    )
    stop.set()
    sender.join(timeout=2.0)

    expected = int(round(SELFTEST_SECONDS * NOMINAL_PPS))
    ok = result.reject_total == 0 and result.packets > 0
    rms = " ".join(f"ch{i}={v:.1f}" for i, v in enumerate(result.rms_lsb))
    out.note(
        {
            "type": "selftest",
            "ok": ok,
            "packets": result.packets,
            "expected_packets": expected,
            "pps": round(result.pps, 2),
            "gaps": result.gaps,
            "reject_total": result.reject_total,
            "rms_lsb": [round(v, 3) for v in result.rms_lsb],
        },
        f"selftest: {'PASS' if ok else 'FAIL'} - {result.packets}/{expected} packets, "
        f"{result.pps:.1f} pps, gaps={result.gaps} lost={result.lost}, "
        f"rejects={result.reject_total} | RMS_lsb {rms}",
    )
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="udp_sniff.py",
        description="Verify ESP32 -> backend audio packets against the frozen README §4.2 framing.",
        epilog=(
            "examples:\n"
            "  .venv/bin/python tools/udp_sniff.py --selftest\n"
            "  .venv/bin/python tools/udp_sniff.py --port 7000 --duration 30\n"
            "  .venv/bin/python tools/udp_sniff.py --duration 0 --json | tee sniff.jsonl"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--port", type=int, default=7000, help="UDP port to listen on (default 7000)")
    parser.add_argument("--host", default="0.0.0.0", help="bind address (default 0.0.0.0)")
    parser.add_argument("--channels", type=int, default=4, help="expected nch (default 4)")
    parser.add_argument(
        "--duration", type=float, default=10.0, help="seconds to listen; 0 = forever (default 10)"
    )
    parser.add_argument(
        "--json", action="store_true", help="emit one JSON object per line instead of the human readout"
    )
    parser.add_argument(
        "--summary-every", type=float, default=2.0, help="seconds between running summaries (default 2)"
    )
    parser.add_argument(
        "--selftest", action="store_true", help="synthesise packets locally on port+1 and verify the receive path"
    )
    args = parser.parse_args(argv)
    if args.channels < 1:
        parser.error("--channels must be >= 1")
    if args.summary_every <= 0:
        parser.error("--summary-every must be > 0")
    if not 0 < args.port <= 65535:
        parser.error("--port must be in 1..65535")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    out = Output(args.json)
    if args.selftest:
        return selftest(out, args.channels, args.port, args.summary_every)
    # A live capture always exits 0: the readout is the product, not the verdict.
    run(args.host, args.port, args.channels, args.duration, args.summary_every, out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
