"""Backend service: capture → onset → DOA + YAMNet (+ Whisper) → WebSocket.

Run it (README §8.5 notes for the NixOS loader paths are handled by
`tools/run_backend.sh`):

    tools/run_backend.sh --profile laptop_dmic          # this laptop's mic pair
    tools/run_backend.sh --source udp                   # the hat, once A lands
    tools/run_backend.sh --source file --source-file x.wav

Everything the HUD consumes is the frozen §4.5 contract; everything it sends is
§4.6 (`set_mode`, `ping`) plus `vision`, which carries the face boxes the browser
already computes (there is exactly one webcam and the browser owns it, so the
camera reaches the backend through the HUD rather than through /dev/video0).

Two additive fields appear on §4.5 messages and are ignored by the HUD:
`t_capture` (backend-clock seconds of the first analysis sample — this is what
makes onset→client latency measurable rather than asserted) and a few
diagnostics (`method`, `delay_samples`, `peak_db`, `snr_db`, `alternatives`).
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import queue
import subprocess
import threading
import time

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .beam import analysis_channel, delay_and_sum
from .calib_fit import SpacingFit
from .config import available_profiles, load_profile, write_profile_spacing
from .detect import Onset, OnsetDetector, Offset
from .fuse import (
    ASR_MAX_SECONDS,
    CLASSIFY_WINDOW,
    DEFAULT_TAIL_S,
    DOA_TAIL_S,
    DOA_WINDOW,
    MIN_EVENT_CONFIDENCE,
    FusionEngine,
)
from .ingest import BandPass, microphones_health, open_source
from .ring import RingBuffer
from .vision import FACE_TTL_S, VisionTracker

log = logging.getLogger("server.main")

RING_SECONDS = 20.0        # long enough to keep a 15 s utterance for Whisper
STATUS_PERIOD_S = 10.0     # §4.5: backend_status every 10 s
ARRAY_PERIOD_S = 2.0
LATENCY_LOG_EVERY = 20
MODE_BY_NAME = {"all": "all", "important": "important", "quiet": "quiet"}


# ---------------------------------------------------------------------------
# WebSocket fan-out
# ---------------------------------------------------------------------------
class Hub:
    """One bounded queue per client, drop-oldest on overflow.

    A stalled phone must never back-pressure the audio thread: dropping an old
    marker is the correct failure mode for a real-time HUD (the `timeline`
    message heals a client that missed something).
    """

    def __init__(self, maxsize: int = 256):
        self.maxsize = maxsize
        self.clients: dict[int, asyncio.Queue] = {}
        self._next_id = 0
        self.loop: asyncio.AbstractEventLoop | None = None
        self.dropped = 0
        self.sent = 0

    def attach(self) -> tuple[int, asyncio.Queue]:
        self._next_id += 1
        q: asyncio.Queue = asyncio.Queue(maxsize=self.maxsize)
        self.clients[self._next_id] = q
        return self._next_id, q

    def detach(self, cid: int) -> None:
        self.clients.pop(cid, None)

    def fanout(self, msg: dict) -> None:
        for q in self.clients.values():
            if q.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    q.get_nowait()
                self.dropped += 1
            q.put_nowait(msg)
            self.sent += 1

    def publish(self, msg: dict) -> None:
        """Thread-safe publish from the audio pipeline."""
        if self.loop is None:
            return
        self.loop.call_soon_threadsafe(self.fanout, msg)


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------
class Backend:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.prof = load_profile(args.profile)
        self.rate = self.prof.rate_hz
        self.nsamp = int(round(self.rate * args.block_ms / 1000.0))
        self.ring = RingBuffer(self.prof.nch, int(RING_SECONDS * self.rate))
        self.detector = OnsetDetector(self.rate)
        # The analysis band-pass: everything downstream (detector, DOA, YAMNet,
        # Whisper, mic health) sees exactly this signal and nothing raw.
        self.cond = BandPass(self.rate, self.prof.nch, self.prof.highpass_hz, self.prof.lowpass_hz)
        self.vision = VisionTracker(self.prof.camera_fov_deg, self.prof.head_yaw_offset_deg)
        self.fit = SpacingFit(self.prof.spacing_m, self.prof.baseline_m)
        self.ml = None
        self.hub = Hub()
        self.t0_mono = time.monotonic()
        self._epoch_mono: float | None = None
        self._due: list[tuple[int, str, object]] = []
        self._thread = None
        self._stop = False
        self.transport = self.prof.transport
        self.source_stats_at_connect: dict = {}
        self._git_rev = self._read_git_rev()
        self._last_status = 0.0
        self._last_array = 0.0
        self._suppressed = 0
        self._presence = False
        self.source = open_source(
            args.source,
            rate=self.rate,
            channels=self.prof.nch,
            nsamp=self.nsamp,
            device=args.device or self.prof.device,
            port=args.udp_port,
            serial_port=args.serial_port,
            path=args.source_file,
            speed=args.speed,
            loop=args.loop,
            auto_wait_s=args.auto_wait,
        )
        self.fusion = FusionEngine(
            self.prof,
            rate=self.rate,
            ml=None,  # set in start(), after YAMNet loads
            transcriber=None,
            vision=self.vision,
            fit=self.fit,
            names=tuple(args.names),
            mode=args.mode,
            classify_tail_s=args.classify_tail,
            min_confidence=args.min_confidence,
        )
        self.transcriber = None
        self._asr_q: queue.Queue = queue.Queue(maxsize=4)
        self._asr_thread: threading.Thread | None = None

    # -- setup -------------------------------------------------------------
    def load_models(self) -> None:
        from .classify import YAMNet

        self.ml = YAMNet(self.args.model, self.args.class_map)
        log.info(
            "model: %s sha256=%s classes=%d window=%d",
            self.ml.model_path, self.ml.sha256, self.ml.n_classes, self.ml.window,
        )
        self.fusion.ml = self.ml

        if self.args.asr:
            from .asr import Transcriber, default_names

            names = tuple(self.args.names) or default_names()
            self.transcriber = Transcriber(model_size=self.args.asr_model, names=names)
            self.fusion.transcriber = self.transcriber
            # Force the model load now so an unavailable ASR is known at startup,
            # not at the moment of the demo's first utterance.
            probe = np.zeros(self.rate // 2, dtype=np.float32)
            self.transcriber.transcribe(probe)
            log.info("asr: %s (model=%s names=%s)", self.transcriber.reason, self.args.asr_model, names or "none")

    @staticmethod
    def _read_git_rev() -> str:
        try:
            out = subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"],
                capture_output=True, text=True, timeout=2.0, check=False,
            )
            return out.stdout.strip() or "unknown"
        except (OSError, subprocess.SubprocessError):
            return "unknown"

    # -- clock -------------------------------------------------------------
    def _t_now(self) -> float:
        return time.monotonic() - self.t0_mono

    def _t_of_index(self, index: int) -> float:
        """Backend-clock seconds of an absolute sample index.

        The epoch is a min-filter over block arrivals (the least-delayed delivery
        wins), which is the standard way to estimate a capture epoch without a
        shared clock. Note what it therefore *excludes*: the driver's own capture
        buffer. `tools/latency_bench.py` measures that part acoustically.
        """
        epoch = self._epoch_mono if self._epoch_mono is not None else self.t0_mono
        return (epoch + index / self.rate) - self.t0_mono

    def _window(self, start_index: int, n: int) -> np.ndarray:
        """Exactly `n` samples ending at `start_index + n` (never past the cursor)."""
        cursor = self.ring.written
        end = start_index + n
        extra = max(0, cursor - end)
        snap = self.ring.snapshot(min(self.ring.capacity, n + extra))
        cols = snap.shape[1]
        keep_end = cols - extra
        keep_start = keep_end - n
        if keep_start < 0:  # not enough history: left-pad with silence
            out = np.zeros((self.prof.nch, n), dtype=np.float32)
            out[:, -cols:] = snap
            return out
        return np.ascontiguousarray(snap[:, keep_start:keep_end])

    # -- pipeline ----------------------------------------------------------
    def start(self) -> None:
        """Load models, start capture, start the analysis thread. Idempotent."""
        if self._thread is not None:
            return
        if self.ml is None and not self.args.no_model:
            self.load_models()
        self.source.start()
        self._thread = threading.Thread(target=self._run, name="pipeline", daemon=True)
        self._thread.start()
        if self.transcriber is not None:
            self._asr_thread = threading.Thread(target=self._asr_worker, name="asr", daemon=True)
            self._asr_thread.start()

    def stop(self) -> None:
        self._stop = True
        self.source.stop()
        t = self._thread
        if t is not None:
            t.join(timeout=2.0)
        if self.ml is not None:
            self.ml.close()
        if self.transcriber is not None:
            self.transcriber.close()

    def _run(self) -> None:
        try:
            for blk in self.source.blocks():
                if self._stop:
                    break
                self._consume(blk)
        except Exception:  # a dead pipeline must be loud, and must not look like silence
            log.exception("pipeline stopped")
            raise

    def _consume(self, blk) -> None:
        # One conditioned copy feeds everything: ring buffer, detector, DOA,
        # classifier, transcriber. Passing the raw block to the detector here was
        # a real bug — the DC/LF/HF junk held the noise floor ~45 dB above the
        # room and no onset ever fired.
        cond = self.cond.process(blk.x)
        self.ring.write(cond, blk.t_us)
        now_mono = time.monotonic()
        cand = now_mono - self.ring.written / self.rate
        self._epoch_mono = cand if self._epoch_mono is None else min(self._epoch_mono, cand)
        if getattr(self.source, "kind", None) == "auto":
            chosen = getattr(self.source, "chosen", "")
            if chosen and chosen != self.transport:
                self.transport = chosen
                log.info("transport -> %s", chosen)

        mono = analysis_channel(cond, self.prof)
        for ev in self.detector.push(mono, blk.t_us):
            if isinstance(ev, Onset):
                due = ev.index + int(round(self.fusion.classify_tail_s * self.rate))
                self._schedule(due, "classify", ev)
            elif isinstance(ev, Offset):
                self._schedule(ev.index + int(round(0.2 * self.rate)), "asr", ev)
        self._run_due()

    def _schedule(self, index: int, kind: str, payload) -> None:
        self._due.append((index, kind, payload))
        if len(self._due) > 4:
            self._due.sort(key=lambda x: x[0])

    def _run_due(self) -> None:
        cursor = self.ring.written
        while self._due and self._due[0][0] <= cursor:
            _, kind, payload = self._due.pop(0)
            try:
                if kind == "classify":
                    self._do_classify(payload)
                else:
                    self._do_asr(payload)
            except Exception:
                log.exception("%s task failed", kind)

    # -- analysis tasks ----------------------------------------------------
    def _do_classify(self, ons: Onset) -> None:
        rate = self.rate
        end_index = ons.index + int(round(self.fusion.classify_tail_s * rate))
        start_index = max(0, end_index - CLASSIFY_WINDOW)
        window = self._window(start_index, CLASSIFY_WINDOW)
        doa_end = ons.index + int(round(DOA_TAIL_S * rate))
        doa_win = self._window(max(0, doa_end - DOA_WINDOW), DOA_WINDOW)

        t_now = self._t_now()
        t_onset = self._t_of_index(ons.index)
        # A face whose mouth is moving now is the source of a speech-like sound;
        # a face merely present only breaks the front/back tie (fuse.localize).
        face = self.vision.speaking_face(t_now, ttl=max(FACE_TTL_S, t_now - t_onset))

        msg, seg = self.fusion.build_sound_event(
            window=window,
            doa_win=doa_win,
            t_now=t_now,
            t_onset=t_onset,
            onset_index=ons.index,
            peak_db=ons.peak_db,
            snr_db=ons.snr_db,
            vision_bearing=face,
            lag_correction=(self.fit.sin_bias(), self.fit.scale()),
        )
        self._observe_for_spacing(seg, face, msg)
        # One decision, one log line: the terminal must not show events the wire
        # never carried (that mismatch is exactly what makes "the HUD is broken"
        # look true when the events are being filtered on purpose).
        send = self.fusion.is_reportable(msg) and self.fusion.should_send(msg)
        if send:
            self.hub.publish(msg)
        else:
            self._suppressed += 1
        self._log_event(msg, t_now, t_onset, sent=send)
        self._maybe_ready(check_every=10)

    def _observe_for_spacing(self, seg, face, msg) -> None:
        """Feed the vision-referenced spacing fit (real measurements only)."""
        if self.args.fit_spacing == "off" or face is None:
            return
        delay = msg.get("delay_samples")
        if delay is None or msg.get("source") != "array+vision":
            return
        sin_assumed = float(np.sin(np.radians(msg["bearing_deg"])))
        # Reverse the current correction so observations are all in the same
        # (assumed-geometry) frame; the fit is over the raw measurement.
        scale, bias = self.fit.scale(), self.fit.sin_bias()
        sin_est = sin_assumed * scale + bias
        self.fit.observe(np.sin(np.radians(face.bearing_deg)), sin_est, weight=max(0.2, face.w * 10.0))

    def _maybe_ready(self, check_every: int = 10) -> None:
        if self.args.fit_spacing == "off" or len(self.fit.obs) % check_every:
            return
        res = self.fit.fit()
        if res is None:
            return
        log.info("spacing fit: %s", res.summary())
        if self.args.fit_spacing == "write" and self.fit.ready_to_write(res) and res.spacing_m:
            try:
                write_profile_spacing(self.prof.name, res.spacing_m, res.baseline_m)
                self.fit.written = True
                log.warning(
                    "array spacing measured from the camera: %.1f mm (was %s) — restart to apply",
                    res.spacing_m * 1000,
                    "uncalibrated" if self.prof.spacing_m is None else f"{self.prof.spacing_m * 1000:.1f} mm",
                )
            except OSError as exc:
                log.warning("could not persist spacing: %s", exc)

    def _do_asr(self, off: Offset) -> None:
        """Slice the finished segment now, transcribe on a worker thread.

        Whisper takes ~1 s per utterance on this CPU. Running it on the capture
        thread (as the first version did) starves block reads, and the whole
        pipeline drifts: measured symptom was a 20 s onset→event latency and a
        16 s read jitter, with every *later* event also late. The slice has to be
        taken here because the ring buffer keeps only the last 20 s.
        """
        seg = self.fusion.pending.pop(off.onset.index, None)
        if seg is None:
            return
        if not self.fusion.wants_speech(
            seg.cls, off.duration_s, seg.confidence, seg.msg.get("snr_db")
        ):
            return
        rate = self.rate
        start = max(0, off.onset.index - int(round(0.15 * rate)))
        end = min(self.ring.written, off.index + int(round(0.25 * rate)))
        # Bound the worker's occupancy: transcribe the head of a long segment.
        end = min(end, start + int(round(ASR_MAX_SECONDS * rate)))
        if end - start < int(0.3 * rate):
            return
        data = self._window(start, end - start)
        sig = (
            analysis_channel(data, self.prof)
            if seg.msg.get("source") == "none"
            else delay_and_sum(data, self.prof, seg.bearing_deg, rate)
        )
        item = (seg, sig, self._t_now())
        try:
            self._asr_q.put_nowait(item)
        except queue.Full:
            # A backlog of transcripts is worthless in real time: drop the oldest.
            with contextlib.suppress(queue.Empty):
                self._asr_q.get_nowait()
            with contextlib.suppress(queue.Full):
                self._asr_q.put_nowait(item)
            log.warning("asr backlog: dropped a queued segment")

    def _asr_worker(self) -> None:
        while not self._stop:
            try:
                seg, sig, t_enqueue = self._asr_q.get(timeout=0.25)
            except queue.Empty:
                continue
            try:
                t0 = time.monotonic()
                msgs = self.fusion.build_speech(seg=seg, samples=sig, t_now=self._t_now())
                for msg in msgs:
                    if self.fusion.should_send(msg):
                        self.hub.publish(msg)
                if msgs:
                    log.info(
                        "asr %.2fs audio in %.0f ms (segment ended %.1fs ago)",
                        len(sig) / self.rate, (time.monotonic() - t0) * 1e3, self._t_now() - t_enqueue,
                    )
            except Exception:
                log.exception("asr worker failed")

    def _log_event(self, msg: dict, t_now: float, t_onset: float, sent: bool = True) -> None:
        if not self.args.print_events:
            return
        note = "" if sent else "  SUPPRESSED"
        print(
            f"[{t_now:7.2f}s] {msg['class']:<22} {msg['confidence']:.2f} "
            f"{msg['bearing_deg']:+6.1f}° ±{msg['accuracy_deg']:.0f}° "
            f"{'AMBIG' if msg['ambiguous'] else '     '} {msg['urgency']:<6} {msg['source']:<12} "
            f"snr {float(msg.get('snr_db', 0)):5.1f} dB  onset→ws {(t_now - t_onset) * 1e3:5.0f} ms{note}",
            flush=True,
        )
        n = len(self.fusion.latencies_ms)
        if n % LATENCY_LOG_EVERY == 0:
            log.info(
                "onset→event latency %s (n=%d) · events sent %d, suppressed %d",
                self.fusion.latency_summary(), n, self.fusion.emitted - self._suppressed, self._suppressed,
            )

    # -- status messages ---------------------------------------------------
    def calibration(self) -> dict:
        cal = {
            "baseline_m": float(self.prof.baseline_m or 0.0),
            "spacing_m": float(self.prof.spacing_m or 0.0),
            "head_yaw_offset_deg": float(self.prof.head_yaw_offset_deg),
            "camera_fov_deg": float(self.prof.camera_fov_deg),
            # Additive diagnostics (README §4.5 edit): honest about what is measured.
            "calibrated": bool(self.prof.calibrated),
            "profile": self.prof.name,
        }
        if self.prof.audio_delay_ms is not None:
            cal["audio_delay_ms"] = float(self.prof.audio_delay_ms)
        if self.fit.last_result is not None:
            cal["fit_spacing_m"] = round(float(self.fit.last_result.spacing_m or 0.0), 5)
            cal["fit_n"] = self.fit.last_result.n
        return cal

    def array_status(self) -> dict:
        recent = self.ring.snapshot(min(self.ring.written, self.rate))
        return {
            "type": "array_status",
            "t": round(self._t_now(), 3),
            "mics": microphones_health(recent),
            "calibration": self.calibration(),
            "transport": self.transport,
        }

    def backend_status(self) -> dict:
        ml = self.ml
        return {
            "type": "backend_status",
            "t": round(self._t_now(), 3),
            "model": "yamnet" if ml is not None else "none",
            "model_path": ml.model_path if ml is not None else "",
            "model_sha256": ml.sha256 if ml is not None else "",
            "classes": ml.n_classes if ml is not None else 0,
            "sample_rate": self.rate,
            "transport": self.transport,
            "git_rev": self._git_rev,
            # Additive diagnostics: this is the "why is nothing showing up" readout.
            "source": getattr(self.source, "kind", "?"),
            "asr": (self.transcriber.reason if self.transcriber is not None else "off"),
            "vision_frames": self.vision.frames,
            "mode": self.fusion.mode,
            "noise_floor_db": round(self.detector.floor_db, 1),
            "events": self.fusion.emitted,
            "latency": self.fusion.latency_summary(),
        }

    def timeline(self) -> dict:
        return {"type": "timeline", "t": round(self._t_now(), 3), "events": self.fusion.timeline()}

    def periodic(self) -> list[dict]:
        """Status cadence, called from the pipeline thread on a wall clock."""
        out: list[dict] = []
        now = self._t_now()
        if now - self._last_array >= ARRAY_PERIOD_S:
            self._last_array = now
            out.append(self.array_status())
        if now - self._last_status >= STATUS_PERIOD_S:
            self._last_status = now
            out.append(self.backend_status())
        pres = self.fusion.presence(now, self._presence)
        if pres is not None:
            self._presence = bool(pres["human"])
            out.append(pres)
        return out

    # -- inbound -----------------------------------------------------------
    def on_vision(self, faces: list[dict]) -> None:
        self.vision.observe(faces, self._t_now())

    def on_mode(self, mode: str) -> None:
        if mode in MODE_BY_NAME:
            self.fusion.set_mode(mode)


async def periodic_loop(backend: Backend, hub: Hub, stop: asyncio.Event) -> None:
    """Emit the 2 s / 10 s status cadence and the presence edges.

    Kept on the loop rather than in the audio thread: it is pure output cadence
    and must keep working even if the capture source stalls.
    """
    while not stop.is_set():
        for msg in backend.periodic():
            hub.fanout(msg)
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=1.0)


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
def create_app(backend: Backend) -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        backend.hub.loop = asyncio.get_running_loop()
        stop = asyncio.Event()
        ticker = asyncio.create_task(periodic_loop(backend, backend.hub, stop))
        log.info("ws listening on ws://%s:%d/ws", backend.args.host, backend.args.ws_port)
        log.info("source=%s profile=%s", backend.args.source, backend.prof.name)
        try:
            yield
        finally:
            stop.set()
            ticker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await ticker

    app = FastAPI(title="hackgt-26 backend", version="0.1", docs_url=None, redoc_url=None, lifespan=lifespan)
    app.state.backend = backend

    @app.get("/health")
    async def health() -> dict:
        return {
            "ok": True,
            "transport": backend.transport,
            "events": backend.fusion.emitted,
            "clients": len(backend.hub.clients),
            "latency": backend.fusion.latency_summary(),
            "source": backend.source.stats.as_dict(),
            # The two numbers that answer "why is nothing showing up": the noise
            # floor the detector is working against, and the loudest frame seen.
            "detector": {
                "floor_db": round(backend.detector.floor_db, 1),
                "peak_db": round(backend.detector.peak_db, 1),
                "samples": backend.detector.n,
            },
        }

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        cid, q = backend.hub.attach()
        log.info("client connected (%d open)", len(backend.hub.clients))
        try:
            # §4.5: on connect, tell the client what it is talking to.
            await ws.send_json(backend.backend_status())
            await ws.send_json(backend.array_status())
            await ws.send_json(backend.timeline())

            sender = asyncio.create_task(_pump(q, ws))
            try:
                while True:
                    raw = await ws.receive_text()
                    await _handle_client_message(backend, raw, ws)
            finally:
                sender.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await sender
        except WebSocketDisconnect:
            pass
        finally:
            backend.hub.detach(cid)
            log.info("client disconnected (%d open)", len(backend.hub.clients))

    return app


async def _pump(q: asyncio.Queue, ws: WebSocket) -> None:
    try:
        while True:
            msg = await q.get()
            await ws.send_json(msg)
    except (WebSocketDisconnect, RuntimeError):
        return


async def _handle_client_message(backend: Backend, raw: str, ws: WebSocket) -> None:
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("ignored unparseable client message: %.80s", raw)
        return
    if not isinstance(msg, dict):
        return
    kind = msg.get("type")
    if kind == "ping":
        # Echo the payload verbatim, back to the sender only: the HUD measures
        # RTT from its own stamp (web/src/ws.ts:162), and the mock does the same.
        await ws.send_json(msg)
    elif kind == "set_mode":
        backend.on_mode(str(msg.get("mode", "")))
    elif kind == "vision":
        faces = msg.get("faces") or []
        if isinstance(faces, list):
            backend.on_vision(faces)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="server.main", description="hackgt-26 backend (§4.5/§4.6)")
    p.add_argument("--profile", default="laptop_dmic",
                   help=f"array geometry: one of {', '.join(available_profiles())}")
    p.add_argument("--source", default="auto", choices=["auto", "pw", "udp", "serial", "file"])
    p.add_argument("--source-file", default=None, help="wav for --source file (16 kHz, matches the profile)")
    p.add_argument("--speed", type=float, default=1.0, help="file replay speed (1.0 = real time)")
    p.add_argument("--loop", action="store_true", help="loop the file")
    p.add_argument("--device", default=None, help="pw-record --target (node name or serial)")
    p.add_argument("--udp-port", type=int, default=7000)
    p.add_argument("--serial-port", default=None, help="/dev/ttyACM0 for --source serial")
    p.add_argument("--auto-wait", type=float, default=2.0, help="seconds to wait for hat packets in --source auto")
    p.add_argument("--block-ms", type=float, default=20.0)
    p.add_argument("--classify-tail", type=float, default=DEFAULT_TAIL_S,
                   help="seconds of sound to wait for before classifying an onset")
    p.add_argument("--min-confidence", type=float, default=MIN_EVENT_CONFIDENCE,
                   help="drop events whose top class scores below this (0 = report everything)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--ws-port", type=int, default=8000)
    p.add_argument("--mode", default="all", choices=["all", "important", "quiet"])
    p.add_argument("--model", default="models/yamnet.tflite")
    p.add_argument("--class-map", default="models/yamnet_class_map.csv")
    p.add_argument("--no-model", action="store_true", help="run without YAMNet (debugging only)")
    p.add_argument("--asr", dest="asr", action="store_true", default=True)
    p.add_argument("--no-asr", dest="asr", action="store_false")
    p.add_argument("--asr-model", default="base.en")
    p.add_argument("--names", default="", help="comma-separated names to spot in speech")
    p.add_argument("--fit-spacing", choices=["off", "on", "write"], default="write",
                   help="measure the array spacing against the camera (write = persist to the profile)")
    p.add_argument("--print-events", dest="print_events", action="store_true", default=True)
    p.add_argument("--no-print-events", dest="print_events", action="store_false")
    p.add_argument("--log-level", default="INFO")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    args.names = tuple(n.strip() for n in args.names.split(",") if n.strip())
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)-16s %(message)s",
        datefmt="%H:%M:%S",
    )
    backend = Backend(args)
    if args.no_model:
        log.warning("running without a classifier: class labels will be 'unknown'")
    backend.start()
    app = create_app(backend)
    try:
        import uvicorn

        uvicorn.run(app, host=args.host, port=args.ws_port, log_level=args.log_level.lower())
    finally:
        backend.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
