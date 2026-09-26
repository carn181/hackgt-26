"""Audio ingest: the same analysis pipeline, four different cables.

Sources (README §4.2 — the framing is frozen so transport is swappable):

  `pw`      local microphone via `pw-record` (today: this laptop's 2-ch DMIC pair)
  `udp`     ESP32 §4.2 packets on :7000
  `serial`  ESP32 §4.2 packets over USB-CDC (the Expo path: 2.4 GHz is jammed)
  `file`    a wav file, fed at real time — deterministic latency measurement
  `auto`    bind :7000; if no packet arrives within `--auto-wait` seconds, fall
            back to the local microphone. Zero-config when the hat finally boots.

Everything downstream sees `Block(t_us, seq, x)` with `x` shape (nch, nsamp)
float32 in −1..1, so the DOA/classifier/fusion code never learns which cable it
came from. Nothing is retransmitted and no gap is hidden: `seq` gaps and
overruns are counted and surfaced in the WS `array_status`.
"""

from __future__ import annotations

import contextlib
import logging
import queue
import shutil
import socket
import struct
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Protocol

import numpy as np

log = logging.getLogger("server.ingest")

# §4.2 header: magic u16, version u8, nch u8, seq u32, t_us u64, nsamp u16
PKT_HDR = struct.Struct("<HBB I Q H")
PKT_MAGIC = 0xA14D
PKT_VERSION = 1
PKT_HDR_SIZE = PKT_HDR.size  # 18

INT16 = np.dtype("<i2")
SCALE = 1.0 / 32768.0


@dataclass
class Block:
    """One analysis block, all channels, channel-major, float32 −1..1."""

    t_us: int          # capture time of sample 0 (µs, on the backend's monotonic clock)
    seq: int
    x: np.ndarray      # (nch, nsamp)


@dataclass
class SourceStats:
    kind: str = "?"
    blocks: int = 0
    samples: int = 0
    seq_gaps: int = 0
    seq_lost: int = 0
    resyncs: int = 0
    overruns: int = 0
    start_mono: float = 0.0
    last_block_mono: float = 0.0
    jitter_ms_mean: float = 0.0
    jitter_ms_max: float = 0.0
    _jit_n: int = 0
    _jit_sum: float = 0.0

    def note_jitter(self, ms: float) -> None:
        self._jit_n += 1
        self._jit_sum += ms
        self.jitter_ms_mean = self._jit_sum / self._jit_n
        if abs(ms) > abs(self.jitter_ms_max):
            self.jitter_ms_max = ms

    @property
    def rate_est_hz(self) -> float:
        el = self.last_block_mono - self.start_mono
        return self.samples / el if el > 0 else 0.0

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "blocks": self.blocks,
            "samples": self.samples,
            "seq_gaps": self.seq_gaps,
            "seq_lost": self.seq_lost,
            "resyncs": self.resyncs,
            "overruns": self.overruns,
            "rate_est_hz": round(self.rate_est_hz, 1),
            "jitter_ms_mean": round(self.jitter_ms_mean, 2),
            "jitter_ms_max": round(self.jitter_ms_max, 2),
        }


class AudioSource(Protocol):
    stats: SourceStats

    def start(self) -> None: ...
    def stop(self) -> None: ...
    def blocks(self) -> Iterator[Block]: ...


class _BaseSource:
    kind = "?"

    def __init__(self, rate: int, channels: int, nsamp: int):
        self.rate = int(rate)
        self.channels = int(channels)
        self.nsamp = int(nsamp)
        self.stats = SourceStats(kind=self.kind)
        self._stopped = threading.Event()
        self._t0_mono = time.monotonic()
        self._next_seq = None

    # capture clock: monotonic seconds → µs, same base as `SourceStats.start_mono`
    def _stamp(self, mono: float, samples_back: int = 0) -> int:
        return int(round((mono - self._t0_mono) * 1e6)) - int(round(samples_back * 1e6 / self.rate))

    def _count_seq(self, seq: int) -> None:
        if self._next_seq is not None:
            gap = (seq - self._next_seq) & 0xFFFFFFFF
            if gap:
                self.stats.seq_gaps += 1
                self.stats.seq_lost += gap - 1
                if gap > 1:
                    log.warning("seq gap: expected %d got %d (lost %d)", self._next_seq, seq, gap - 1)
        self._next_seq = (seq + 1) & 0xFFFFFFFF


# ---------------------------------------------------------------------------
# Local microphone (PipeWire / pw-record)
# ---------------------------------------------------------------------------
class PwSource(_BaseSource):
    """Local mic array via `pw-record`, captured at 16 kHz (README §8.2: the
    whole pipeline — and YAMNet — is 16 kHz, so nothing resamples downstream).

    Timestamps are read-completion minus the block duration. PipeWire adds a
    constant buffer delay on top; that offset is measured once with an acoustic
    loopback and lands in `calib.audio_delay_ms` (README §7.2.5).
    """

    kind = "pw"

    def __init__(
        self,
        rate: int,
        channels: int,
        nsamp: int,
        device: str | None = None,
        latency: str = "10ms",
        quality: int = 4,
    ):
        super().__init__(rate, channels, nsamp)
        self.device = device
        self.latency = latency
        self.quality = int(quality)
        self._proc: subprocess.Popen | None = None
        self._expect_mono: float | None = None

    def _argv(self) -> list[str]:
        argv = [
            "pw-record",
            "--raw",
            "--rate", str(self.rate),
            "--channels", str(self.channels),
            "--format", "s16",
            "--latency", self.latency,
            "--quality", str(self.quality),
        ]
        if self.device:
            argv += ["--target", self.device]
        argv.append("-")
        return argv

    def start(self) -> None:
        if shutil.which("pw-record") is None:
            raise RuntimeError("pw-record not found — install pipewire (or use --source udp/file)")
        self._proc = subprocess.Popen(
            self._argv(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0
        )
        self.stats.start_mono = time.monotonic()
        self._expect_mono = self.stats.start_mono
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        log.info("pw-record started: %s", " ".join(self._argv()))

    def _drain_stderr(self) -> None:
        """pw-record only speaks up when something changes: surface it."""
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        for raw in proc.stderr:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            low = line.lower()
            if "xrun" in low or "underrun" in low or "overrun" in low:
                self.stats.overruns += 1
            log.debug("pw-record: %s", line)

    def blocks(self) -> Iterator[Block]:
        proc = self._proc
        if proc is None or proc.stdout is None:
            raise RuntimeError("source not started")
        frame = self.channels * self.nsamp
        nbytes = frame * 2
        buf = bytearray(nbytes)
        view = memoryview(buf)
        while not self._stopped.is_set():
            got = 0
            while got < nbytes:
                n = proc.stdout.readinto(view[got:])
                if not n:
                    if proc.poll() is not None:
                        log.error("pw-record exited with %s", proc.returncode)
                        return
                    continue
                got += n
            now = time.monotonic()
            if self._expect_mono is not None:
                self.stats.note_jitter((now - self._expect_mono) * 1e3)
            self._expect_mono = now + self.nsamp / self.rate
            x = np.frombuffer(bytes(buf), dtype=INT16).astype(np.float32)
            x *= SCALE
            x = x.reshape(self.channels, self.nsamp)
            self.stats.blocks += 1
            self.stats.samples += self.nsamp
            self.stats.last_block_mono = now
            yield Block(t_us=self._stamp(now, self.nsamp), seq=self.stats.blocks - 1, x=x)

    def stop(self) -> None:
        self._stopped.set()
        proc = self._proc
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                proc.kill()


# ---------------------------------------------------------------------------
# ESP32 packet sources (§4.2)
# ---------------------------------------------------------------------------
def parse_packet(buf: bytes, nch_expected: int, rate: int) -> Block | None:
    """Parse one §4.2 packet. Returns None when the framing is wrong.

    `t_us` is the *hat's* monotonic clock; we keep the wall clock of arrival and
    subtract the packet's own age is impossible (different epochs), so a
    per-packet `t_us` is used for relative alignment only — the pipeline clock is
    backend-monotonic, which is what every latency number is measured against.
    """
    if len(buf) < PKT_HDR_SIZE:
        return None
    magic, version, nch, seq, t_us, nsamp = PKT_HDR.unpack_from(buf, 0)
    if magic != PKT_MAGIC or version != PKT_VERSION:
        return None
    if nch != nch_expected or nsamp == 0:
        return None
    need = PKT_HDR_SIZE + 2 * nch * nsamp
    if len(buf) < need:
        return None
    x = np.frombuffer(buf, dtype=INT16, count=nch * nsamp, offset=PKT_HDR_SIZE).astype(np.float32)
    x *= SCALE
    return Block(t_us=int(t_us), seq=int(seq), x=x.reshape(nch, nsamp))


class UdpSource(_BaseSource):
    kind = "udp"

    def __init__(self, rate: int, channels: int, nsamp: int, port: int = 7000, host: str = "0.0.0.0"):
        super().__init__(rate, channels, nsamp)
        self.port = int(port)
        self.host = host
        self._sock: socket.socket | None = None

    def start(self) -> None:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            # lets tools/udp_sniff.py watch the same port while the backend runs
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)
        s.bind((self.host, self.port))
        s.settimeout(0.25)
        self._sock = s
        self.stats.start_mono = time.monotonic()
        log.info("udp source listening on %s:%d", self.host, self.port)

    def __iter__(self) -> Iterator[Block]:
        return self.blocks()

    def blocks(self) -> Iterator[Block]:
        assert self._sock is not None
        while not self._stopped.is_set():
            try:
                data, addr = self._sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                return
            blk = parse_packet(data, self.channels, self.rate)
            if blk is None:
                self.stats.resyncs += 1
                continue
            now = time.monotonic()
            self.stats.blocks += 1
            self.stats.samples += self.nsamp
            self.stats.last_block_mono = now
            self._count_seq(blk.seq)
            if self.stats.blocks == 1:
                log.info("first §4.2 packet from %s:%d", *addr)
            yield blk

    def stop(self) -> None:
        self._stopped.set()
        if self._sock is not None:
            self._sock.close()


class SerialSource(_BaseSource):
    """§4.2 packets over USB-CDC (`pyserial`). Same bytes as UDP by design."""

    kind = "serial"

    def __init__(self, rate: int, channels: int, nsamp: int, port: str, baud: int = 2_000_000):
        super().__init__(rate, channels, nsamp)
        self.port = port
        self.baud = int(baud)
        self._ser = None
        self._buf = bytearray()

    def start(self) -> None:
        import serial  # pyserial

        self._ser = serial.Serial(self.port, self.baud, timeout=0.25)
        self.stats.start_mono = time.monotonic()
        log.info("serial source open on %s @ %d", self.port, self.baud)

    def blocks(self) -> Iterator[Block]:
        assert self._ser is not None
        pkt_len = PKT_HDR_SIZE + 2 * self.channels * self.nsamp
        while not self._stopped.is_set():
            chunk = self._ser.read(4096)
            if chunk:
                self._buf.extend(chunk)
            while True:
                idx = self._buf.find(bytes((PKT_MAGIC & 0xFF, PKT_MAGIC >> 8)))
                if idx < 0:
                    if len(self._buf) > 4 * pkt_len:  # no magic anywhere: drop noise, keep a window
                        del self._buf[:-PKT_HDR_SIZE]
                    break
                if idx > 0:
                    self.stats.resyncs += 1
                    del self._buf[:idx]
                if len(self._buf) < pkt_len:
                    break
                blk = parse_packet(bytes(self._buf[:pkt_len]), self.channels, self.rate)
                del self._buf[:pkt_len]
                if blk is None:
                    self.stats.resyncs += 1
                    continue
                now = time.monotonic()
                self.stats.blocks += 1
                self.stats.samples += self.nsamp
                self.stats.last_block_mono = now
                self._count_seq(blk.seq)
                yield blk

    def stop(self) -> None:
        self._stopped.set()
        if self._ser is not None:
            self._ser.close()


# ---------------------------------------------------------------------------
# File source (reference audio at real time)
# ---------------------------------------------------------------------------
class FileSource(_BaseSource):
    """Play a wav into the pipeline at wall-clock rate.

    Used by the latency bench and by anyone reproducing a capture without a
    microphone in the room. `speed=1.0` is real time; higher values replay
    faster than reality (throughput testing, not latency number).
    """

    kind = "file"

    def __init__(self, rate: int, channels: int, nsamp: int, path: str | Path, speed: float = 1.0, loop: bool = False):
        super().__init__(rate, channels, nsamp)
        self.path = Path(path)
        self.speed = float(speed)
        self.loop = loop

    def start(self) -> None:
        self.stats.start_mono = time.monotonic()
        log.info("file source: %s at %.2f×", self.path, self.speed)

    def _load(self) -> np.ndarray:
        import soundfile as sf

        data, sr = sf.read(self.path, dtype="float32", always_2d=True)
        if sr != self.rate:
            raise RuntimeError(f"{self.path}: {sr} Hz, pipeline is {self.rate} Hz (no resampling by design)")
        if data.shape[1] < self.channels:
            raise RuntimeError(f"{self.path}: {data.shape[1]} ch, source needs {self.channels}")
        return np.ascontiguousarray(data[:, : self.channels].T)

    def blocks(self) -> Iterator[Block]:
        x = self._load()
        n = self.nsamp
        i = 0
        seq = 0
        t_start = time.monotonic()
        while not self._stopped.is_set():
            if i + n > x.shape[1]:
                if not self.loop:
                    return
                i = 0
            blk = x[:, i : i + n]
            if blk.shape[1] < n:
                return
            target = t_start + (i + n) / (self.rate * self.speed)
            delay = target - time.monotonic()
            if delay > 0:
                self._stopped.wait(delay)
            now = time.monotonic()
            self.stats.blocks += 1
            self.stats.samples += n
            self.stats.last_block_mono = now
            yield Block(t_us=self._stamp(t_start + i / (self.rate * self.speed)), seq=seq, x=blk)
            seq += 1
            i += n

    def stop(self) -> None:
        self._stopped.set()


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------
def open_source(
    spec: str,
    *,
    rate: int,
    channels: int,
    nsamp: int,
    device: str | None = None,
    port: int = 7000,
    serial_port: str | None = None,
    path: str | None = None,
    speed: float = 1.0,
    loop: bool = False,
    auto_wait_s: float = 2.0,
) -> AudioSource:
    """Build a source from `--source`. `auto` prefers real §4.2 packets."""
    spec = (spec or "auto").strip()
    if spec == "auto":
        src = _AutoSource(
            rate=rate,
            channels=channels,
            nsamp=nsamp,
            device=device,
            udp_port=port,
            wait_s=auto_wait_s,
        )
        return src
    if spec == "pw":
        return PwSource(rate, channels, nsamp, device=device)
    if spec == "browser":
        # Frames arrive over the WebSocket (§4.6 `audio`); the HUD is the sensor.
        return BrowserSource(rate, channels, nsamp)
    if spec == "udp":
        return UdpSource(rate, channels, nsamp, port=port)
    if spec == "serial":
        if not serial_port:
            raise ValueError("--serial-port is required for --source serial")
        return SerialSource(rate, channels, nsamp, serial_port)
    if spec == "file":
        if not path:
            raise ValueError("--source file requires --source-file")
        return FileSource(rate, channels, nsamp, path, speed=speed, loop=loop)
    raise ValueError(f"unknown source {spec!r} (pw|udp|serial|file|browser|auto)")


class _AutoSource(_BaseSource):
    """Bind :7000; if the hat never speaks, capture the local microphone.

    The switch is logged loudly because the whole point of the WS
    `transport` field is that a viewer can tell which one is live.
    """

    kind = "auto"

    def __init__(self, rate: int, channels: int, nsamp: int, device: str | None, udp_port: int, wait_s: float):
        super().__init__(rate, channels, nsamp)
        self._udp = UdpSource(rate, channels, nsamp, port=udp_port)
        self._pw_args = (rate, channels, nsamp, device)
        self.wait_s = float(wait_s)
        self.active: AudioSource = self._udp
        self.chosen = ""

    def start(self) -> None:
        self._udp.start()

    @property
    def stats(self) -> SourceStats:  # type: ignore[override]
        return self.active.stats

    def blocks(self) -> Iterator[Block]:
        deadline = time.monotonic() + self.wait_s
        it = self._udp.blocks()
        while time.monotonic() < deadline and not self._stopped.is_set():
            try:
                blk = next(it)
            except StopIteration:
                break
            self.active = self._udp
            self.chosen = "udp"
            log.info("auto: §4.2 packets arrived — using the hat (udp)")
            yield blk
            yield from it
            return
        self._udp.stop()
        if self._stopped.is_set():
            return
        log.warning("auto: no ESP32 packets within %.1fs — falling back to the local microphone", self.wait_s)
        pw = PwSource(*self._pw_args)
        pw.start()
        self.active = pw
        self.chosen = "pw"
        yield from pw.blocks()

    def stop(self) -> None:
        self._stopped.set()
        self._udp.stop()
        self.active.stop()


class BandPass:
    """Stateful per-channel band-pass: the analysis path's conditioning.

    This is not optional hygiene on the laptop stand-in, it is what makes it
    usable at all. Measured on this ThinkPad's DMIC pair: a large DC offset
    (channel 1 at +5160 LSB), a spectral rise below 250 Hz, and a *second* rise
    above 6 kHz reaching +68 dB at Nyquist — a clap played from the speakers sits
    5.6 dB above that mess unfiltered and 26 dB above it once the junk is gone,
    so an RMS-based onset detector simply never fires without this.

    The band is the same 300–6000 Hz the DOA uses, which keeps one honest
    definition of "the signal" for the detector, the classifier and the
    transcriber (Whisper is a telephone-band task anyway).

    A streaming IIR (`sosfilt` with carried state) rather than a windowed
    zero-phase filter: the pipeline is continuous, and a per-block `filtfilt`
    would put a transient at every block boundary.
    """

    def __init__(self, rate: int, nch: int, highpass_hz: float, lowpass_hz: float):
        from scipy import signal

        self.rate = int(rate)
        self.nch = int(nch)
        self.highpass_hz = float(highpass_hz)
        self.lowpass_hz = float(lowpass_hz)
        nyq = rate / 2.0
        lo = max(20.0, self.highpass_hz) / nyq
        hi = min(self.lowpass_hz, 0.98 * nyq) / nyq
        self.sos = signal.butter(2, [lo, hi], btype="bandpass", output="sos")
        # scipy's sosfilt with axis=-1 wants (n_sections, nch, 2) state.
        self.zi = np.zeros((self.sos.shape[0], self.nch, 2), dtype=np.float64)

    def process(self, x: np.ndarray) -> np.ndarray:
        """Filter (nch, n) in place-safe fashion; returns float32 of the same shape."""
        from scipy import signal

        if x.shape[0] != self.nch:
            raise ValueError(f"expected {self.nch} channels, got {x.shape}")
        y, self.zi = signal.sosfilt(self.sos, x.astype(np.float64, copy=False), axis=-1, zi=self.zi)
        return y.astype(np.float32, copy=False)

    def reset(self) -> None:
        self.zi[:] = 0.0


class BrowserSource(_BaseSource):
    """Audio captured by the HUD's browser (phone or laptop) and streamed over WS.

    Why this exists: the stand-in array's problem is its microphones, and the
    phone in the human's pocket is a better sensor than this laptop's DMIC pair —
    and it is nowhere near the chassis, so a clap arrives as *airborne* sound
    instead of a structural thump (which is what makes a clap read as a low
    frequency event). It is also the only way to get a second physical device
    into the array without hardware.

    What it cannot do is localize: one microphone is one microphone, so the
    profile is `browser_mono`, `pairs()` is empty, DOA refuses, and the bearing
    keeps coming from the camera (`vision`).

    Frames arrive on the asyncio loop and are handed to the pipeline thread
    through a bounded queue: a slow consumer drops the oldest frame rather than
    back-pressuring the socket.
    """

    kind = "browser"

    def __init__(self, rate: int, channels: int, nsamp: int, queue_frames: int = 96):
        super().__init__(rate, channels, nsamp)
        self._q: queue.Queue[Block] = queue.Queue(maxsize=int(queue_frames))
        self.frames = 0
        self.dropped = 0
        self.last_frame_mono = 0.0
        self.last_client_t: float | None = None
        self.silence_samples = 0
        self._owner: int | None = None
        self.rejected_other_client = 0
        self._expected_mono: float | None = None
        self._next_warn = 0.0
        self._bad: dict[str, int] = {}

    def start(self) -> None:
        self.stats.start_mono = time.monotonic()
        log.info(
            "browser source: waiting for §4.6 `audio` frames (%d Hz, %d ch, pcm16)",
            self.rate, self.channels,
        )

    def reject(self, reason: str) -> None:
        """Count and rate-limit a malformed frame complaint (called from the loop)."""
        self._bad[reason] = self._bad.get(reason, 0) + 1
        now = time.monotonic()
        if now > self._next_warn:
            self._next_warn = now + 5.0
            log.warning("browser source: rejected frame (%s), %d so far", reason, self._bad[reason])

    def push(
        self,
        samples: np.ndarray,
        seq: int | None = None,
        t_client: float | None = None,
        client_id: int | None = None,
    ) -> None:
        """Queue one frame of (nch, n) float32 −1..1. Called from the WS handler.

        **One client is the microphone at a time.** Two pages streaming at once
        interleave their rooms into one stream — the classifier then hears a
        mixture of two places, and the sequence counters fight each other (observed
        live as a flood of `seq gap` warnings in both directions). The first client
        to send a frame owns the source until it disconnects.
        """
        n = samples.shape[1]
        if n == 0:
            return
        if self._owner is None:
            self._owner = client_id
            log.info("browser source: client %s is now the microphone", client_id)
        elif client_id != self._owner:
            self.rejected_other_client += 1
            now = time.monotonic()
            if now > self._next_warn:
                self._next_warn = now + 10.0
                log.warning(
                    "browser source: client %s is already the microphone — ignoring frames from %s "
                    "(%d ignored so far). Run the backend with --source pw for two independent inputs.",
                    self._owner, client_id, self.rejected_other_client,
                )
            return
        now = time.monotonic()
        blk = Block(t_us=self._stamp(now, n), seq=int(seq) if seq is not None else self.frames, x=samples)
        try:
            self._q.put_nowait(blk)
        except queue.Full:
            with contextlib.suppress(queue.Empty):
                self._q.get_nowait()
            self.dropped += 1
            with contextlib.suppress(queue.Full):
                self._q.put_nowait(blk)
        if seq is not None:
            # A page restarts `seq` at 0 for every connection; without this a
            # reconnect is counted as a 4-billion-frame gap.
            if int(seq) == 0:
                self._next_seq = None
            self._count_seq(int(seq))
        if self.frames == 0:
            # Rate is measured over the *active* window: the page may take a minute
            # to open, and counting that idle time made /health report ~10 kHz for
            # a stream that is exactly 16 kHz.
            self.stats.start_mono = now
        self.last_frame_mono = now
        self.last_client_t = t_client

    def release(self, client_id: int | None) -> None:
        """The owning client disconnected: let the next one become the microphone."""
        if client_id is not None and client_id == self._owner:
            log.info("browser source: client %s released the microphone", client_id)
            self._owner = None
            self._next_seq = None

    def blocks(self) -> Iterator[Block]:
        """Yield frames, inserting silence for any gap.

        The clock downstream is `sample_index / rate`, which is only meaningful if
        the stream is continuous. When the browser pauses (a phone screen locks, a
        tab is backgrounded, nobody has opened the HUD yet) the audio simply stops
        arriving, and without this the index falls behind wall time for ever —
        measured as a *constant 60 s* onset→event latency on a stream that had a
        one-minute gap in it. Filling the gap keeps time honest and gives the
        detector real silence to track its floor against.
        """
        while not self._stopped.is_set():
            try:
                blk = self._q.get(timeout=0.25)
            except queue.Empty:
                now = time.monotonic()
                gap = now - self._expected_mono if self._expected_mono else 0.0
                if gap > 0.03:
                    n = int(min(gap, 0.5) * self.rate)
                    if n >= 64:
                        self.silence_samples += n
                        self._expected_mono = now
                        yield Block(
                            t_us=self._stamp(now, n),
                            seq=self.frames,
                            x=np.zeros((self.channels, n), dtype=np.float32),
                        )
                if now > self._next_warn:
                    self._next_warn = now + 5.0
                    log.warning("browser source: no audio frames yet — open the HUD with ?mic=1")
                continue
            self.frames += 1
            self.stats.blocks += 1
            self.stats.samples += blk.x.shape[1]
            now = time.monotonic()
            self.stats.last_block_mono = now
            self._expected_mono = now + blk.x.shape[1] / self.rate
            yield blk

    def stop(self) -> None:
        self._stopped.set()

    def stats_dict(self) -> dict:
        return {
            **self.stats.as_dict(),
            "frames": self.frames,
            "queue_dropped": self.dropped,
            "silence_filled_s": round(self.silence_samples / self.rate, 2),
            "owner": self._owner,
            "rejected_other_client": self.rejected_other_client,
        }


def microphones_health(ring_x: np.ndarray, floor_db: float = -75.0, clip_db: float = -1.0) -> list[dict]:
    """Per-channel health from the recent window: alive, not clipping.

    `ring_x` is (nch, n) float32. An empty window (a source that has not produced
    audio yet — the browser source before the first frame) reports `ok: false`
    rather than a numpy warning about a mean of nothing.
    """
    out = []
    for ch in range(ring_x.shape[0]):
        if ring_x.shape[1] == 0:
            out.append({"id": ch, "ok": False})
            continue
        rms = float(np.sqrt(np.mean(np.square(ring_x[ch], dtype=np.float64)) + 1e-20))
        db = 20.0 * np.log10(rms)
        out.append({"id": ch, "ok": bool(db > floor_db and db < clip_db)})
    return out
