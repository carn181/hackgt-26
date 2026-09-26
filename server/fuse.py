"""Fusion: audio + camera → the WS `sound_event` / `speech` messages (README §4.5).

This is where the project's honesty rules are enforced, so they are stated here
rather than in a doc somewhere:

* **No bearing is invented.** If neither the array nor the camera can localize a
  sound, the event still goes out (the class is real and useful) with
  `accuracy_deg = 180` and `ambiguous = true`, so the HUD fades it to nothing
  instead of drawing a confident lie.
* **A 1-D array is front/back ambiguous, always.** The camera breaks the tie when
  a face is actually there (README §4.1 resolution (c)); otherwise both
  candidates are the answer.
* **The camera only speaks for the present.** A face observed three seconds ago
  says nothing about a sound now (`vision.FACE_TTL_S`).
* **Provenance is visible.** `source` is one of `array`, `array+vision`,
  `vision`, `none` — a judge can see which sensor produced each angle.

The classifier is fed a steered beam (README §8.3), never a raw multi-channel sum.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from dataclasses import dataclass, field

import numpy as np

from .beam import analysis_channel, delay_and_sum
from .calib_fit import SpacingFit
from .config import Profile
from .doa import DoaEstimate, estimate_bearing, mirror_bearing
from .urgency import urgency_for
from .vision import VisionTracker, choose_half_space

log = logging.getLogger("server.fuse")

# YAMNet's fixed window (README §8.2) — 0.975 s at 16 kHz.
CLASSIFY_WINDOW = 15600
# How much of that window we let the sound occupy before classifying. The onset
# is placed near the *centre* so a short wait already yields a window that is
# mostly signal; waiting for the full window would cost ~1 s of latency. 0.20 s
# measured out as the sweet spot: onset→event ~240 ms, and the class is unchanged
# on the synthetic end-to-end check (YAMNet is insensitive to where a transient
# sits inside its fixed window).
DEFAULT_TAIL_S = 0.20
# Short window for the bearing. It ends *after* the onset so it contains the
# transient and the beginning of the sustain — a window that stops at the onset is
# mostly silence, and PHAT on silence is noise. 256 ms at 16 kHz.
DOA_WINDOW = 4096
DOA_TAIL_S = 0.20
# Two events of the same class within this window and this angular distance are
# the same physical sound (a clap's echo, a repeated knock): update the id in
# place rather than stacking captions in the HUD.
MERGE_S = 1.2
MERGE_DEG = 12.0
# Apparent-bearing ceiling when nothing could localize the sound.
NO_BEARING_ACCURACY = 180.0
# Relative tolerance for "the camera agrees with the array" (a resolved half-space).
HALF_SPACE_TOL_DEG = 35.0
# Classes whose segment is worth sending to Whisper. YAMNet names a synthetic
# voice `Synthesizer` (espeak-ng lands here) and a real one `Speech`, so the test
# is on the class *family*, not on the literal word.
_SPEECHY = ("speech", "conversation", "narration", "child speech", "singing", "whisper", "synthesizer")
# A detector that fires on a loud room occasionally hands us something the
# classifier calls silence, and YAMNet also has "room tone" classes that describe
# a place rather than a sound. Reporting those is noise in the HUD (SoundWatch's
# overload finding) and the class itself says the event is empty — so they are
# dropped rather than forwarded.
_NON_EVENTS = (
    "silence",
    "inside, small room",
    "inside, large room or hall",
    "outside, urban or rural",
    "static",
    "noise",
    "white noise",
    "pink noise",
)
# Minimum segment SNR for an event to be worth reporting at all. The detector's
# own floor is ~-68 dB here and room bumps clear 9 dB above it, which is how the
# log filled up with "Silence" events at confidence 0.1-0.5.
MIN_EVENT_SNR_DB = 12.0
# Below this top-class score the label is a guess (a chair creak reads "Fart" or
# "Horse"), and the project's rule is that a wrong label is worse than none. Real
# speech in this room measures 0.41-0.50, a speaker-played tone 0.89-0.94, so the
# floor costs nothing that would have been displayed anyway: the HUD fades a
# marker by confidence, and `urgency_for` already downgrades below 0.35.
MIN_EVENT_CONFIDENCE = 0.30
# A transcript is only attempted when the event looks like real speech: the class
# must be in the speech family *and* the segment must be clean and confident.
MIN_SPEECH_CONFIDENCE = 0.35
MIN_SPEECH_SNR_DB = 15.0
# Longest audio handed to the transcriber. Measured: a 10 s segment cost 11.9 s of
# CPU at int8, and long segments are usually room noise rather than one utterance.
ASR_MAX_SECONDS = 6.0


@dataclass
class PendingSegment:
    """State carried from an onset to the messages it eventually produces."""

    onset_index: int
    t_onset_s: float
    event_id: str = ""
    cls: str = ""
    confidence: float = 0.0
    bearing_deg: float = 0.0
    urgency: str = "normal"
    msg: dict = field(default_factory=dict)


class FusionEngine:
    def __init__(
        self,
        prof: Profile,
        *,
        rate: int | None = None,
        ml=None,                      # server.classify.YAMNet (TFLite is not thread-safe)
        transcriber=None,             # server.asr.Transcriber
        vision: VisionTracker | None = None,
        fit: SpacingFit | None = None,
        names: tuple[str, ...] = (),
        mode: str = "all",
        classify_tail_s: float = DEFAULT_TAIL_S,
        min_confidence: float = MIN_EVENT_CONFIDENCE,
    ):
        self.prof = prof
        self.rate = int(rate or prof.rate_hz)
        self.ml = ml
        self.transcriber = transcriber
        self.vision = vision
        self.fit = fit or SpacingFit(prof.spacing_m, prof.baseline_m)
        self.names = tuple(names)
        self.mode = mode
        self.classify_tail_s = float(classify_tail_s)
        self.min_confidence = float(min_confidence)
        self._eid = 0
        self._sid = 0
        self._by_id: OrderedDict[str, dict] = OrderedDict()
        self._last_merge: dict[str, tuple[float, str]] = {}
        self.pending: dict[int, PendingSegment] = {}
        # Instrumentation surfaced by the periodic log line.
        self.latencies_ms: list[float] = []
        self.emitted = 0

    # -- naming / history -------------------------------------------------
    def _next_event_id(self) -> str:
        self._eid += 1
        return f"e{self._eid}"

    def _remember(self, msg: dict) -> dict:
        self._by_id[msg["id"]] = msg
        while len(self._by_id) > 60:
            self._by_id.popitem(last=False)
        return msg

    def timeline(self, limit: int = 40) -> list[dict]:
        """Recent sound_event/speech objects, oldest first (README §4.5)."""
        items = [m for m in self._by_id.values() if m.get("type") in ("sound_event", "speech")]
        return [dict(m) for m in items[-limit:]]

    def set_mode(self, mode: str) -> None:
        if mode not in ("all", "important", "quiet"):
            log.warning("ignoring unknown mode %r", mode)
            return
        self.mode = mode
        log.info("mode -> %s", mode)

    def should_send(self, msg: dict) -> bool:
        """Server-side volume control (§4.6). `quiet` is the overload guard."""
        if msg.get("type") != "sound_event":
            return True
        urgency = msg.get("urgency", "normal")
        if self.mode == "quiet":
            return urgency in ("high", "urgent")
        if self.mode == "important":
            return urgency != "low"
        return True

    # -- localization ------------------------------------------------------
    def localize(self, doa_win: np.ndarray, t_now: float, *, lag_correction=None, vision_bearing=None) -> tuple[float, float, bool, str, str, float]:
        """Return `(bearing_deg, accuracy_deg, ambiguous, source, method, delay_samples)`.

        Combines the acoustic estimate with the camera. Every branch below is a
        statement about *why* the angle is believed, and `source` records it.
        """
        # (1) Camera first when someone's mouth is moving: it is unambiguous and
        #     far more precise than a lid-sized array.
        face = vision_bearing
        est: DoaEstimate | None = None
        if self.prof.nch >= 2:
            try:
                est = estimate_bearing(doa_win, self.prof, self.rate, correction=lag_correction)
            except ValueError as exc:
                log.debug("doa failed: %s", exc)

        if face is not None:
            if est is not None and abs(est.bearing_deg) > 6.0 and abs(face.bearing_deg) > 6.0 and np.sign(est.bearing_deg) != np.sign(face.bearing_deg):
                log.debug(
                    "array/camera disagree on the half-space (array %.1f°, camera %.1f°) — trusting the camera",
                    est.bearing_deg, face.bearing_deg,
                )
            source = "array+vision" if est is not None else "vision"
            return face.bearing_deg, face.accuracy_deg, False, source, "vision", est.delay_samples if est else 0.0

        # (2) Array only. Resolve the half-space from any visible face; if none of
        #     the two candidates matches a face, keep both (ambiguous).
        if est is not None:
            if self.vision is not None:
                faces = self.vision.faces(t_now)
                if faces:
                    mirror = mirror_bearing(est.bearing_deg)
                    for f in faces:
                        chosen = choose_half_space(est.bearing_deg, mirror, f, HALF_SPACE_TOL_DEG)
                        if chosen is not None:
                            return chosen, max(est.accuracy_deg, f.accuracy_deg), False, "array+vision", "camera-tiebreak", est.delay_samples
            return est.bearing_deg, est.accuracy_deg, est.ambiguous, "array", est.method, est.delay_samples

        return 0.0, NO_BEARING_ACCURACY, True, "none", "none", 0.0

    # -- event construction ------------------------------------------------
    def sounding_signal(self, window: np.ndarray, bearing_deg: float | None, source: str) -> np.ndarray:
        """Channel choice for the classifier (README §8.3, never a raw sum)."""
        if bearing_deg is None or source == "none":
            return analysis_channel(window, self.prof)
        return delay_and_sum(window, self.prof, bearing_deg, self.rate)

    def build_sound_event(
        self,
        *,
        window: np.ndarray,
        doa_win: np.ndarray,
        t_now: float,
        t_onset: float,
        onset_index: int,
        peak_db: float,
        snr_db: float,
        vision_bearing=None,
        lag_correction=None,
    ) -> tuple[dict, PendingSegment]:
        """One analysed segment → one `sound_event` message."""
        bearing, accuracy, ambiguous, source, method, delay = self.localize(
            doa_win, t_now, lag_correction=lag_correction, vision_bearing=vision_bearing
        )
        sig = self.sounding_signal(window, bearing if source != "none" else None, source)
        if self.ml is not None:
            top = self.ml.top(sig, k=3)
            cls, conf = (top[0][0], float(top[0][1])) if top else ("unknown", 0.0)
            alt = [{"class": n, "confidence": round(float(s), 3)} for n, s in top[1:]]
        else:
            cls, conf, alt = "unknown", 0.0, []
        urgency = urgency_for(cls, conf)

        # Reuse the id when this is obviously the same sound continuing.
        key = f"{cls}:{round(bearing / MERGE_DEG)}"
        event_id = None
        prev = self._last_merge.get(key)
        if prev is not None and t_now - prev[0] <= MERGE_S:
            event_id = prev[1]
        if event_id is None or event_id not in self._by_id:
            event_id = self._next_event_id()
        self._last_merge[key] = (t_now, event_id)

        msg = {
            "type": "sound_event",
            "id": event_id,
            "t": round(t_now, 3),
            # Additive to §4.5 (the HUD ignores it): the physical start of the
            # sound, which is what makes "onset → client" a measurement instead of
            # an assertion. See tools/latency_bench.py.
            "t_onset": round(t_onset, 3),
            "class": cls,
            "confidence": round(conf, 3),
            "bearing_deg": round(float(bearing), 1),
            "elevation_deg": None,  # no vertical baseline exists (README §4.1)
            "accuracy_deg": round(float(accuracy), 1),
            "ambiguous": bool(ambiguous),
            "urgency": urgency,
            "source": source,
            "method": method,
            # Diagnostics, additive to §4.5 and ignored by the HUD: honestly
            # useful when someone asks "how sure is that angle?".
            "peak_db": round(float(peak_db), 1),
            "snr_db": round(float(snr_db), 1),
        }
        if delay:
            msg["delay_samples"] = round(float(delay), 3)
        if alt:
            msg["alternatives"] = alt
        seg = PendingSegment(
            onset_index=onset_index,
            t_onset_s=t_onset,
            event_id=event_id,
            cls=cls,
            confidence=conf,
            bearing_deg=float(bearing),
            urgency=urgency,
            msg=msg,
        )
        self.pending[onset_index] = seg
        self._remember(msg)
        self.emitted += 1
        # Onset → message: the number the README's 1.5 s budget is about.
        self.latencies_ms.append((t_now - t_onset) * 1e3)
        return msg, seg

    def is_reportable(self, msg: dict) -> bool:
        """False for classes that describe no sound, and for weak segments.

        The SNR and confidence gates are the ones that matter in practice: a
        detector working against a -68 dB floor fires on every room bump, and the
        classifier answers "Silence" or a guess like "Horse" at low confidence.
        That is a real measurement of nothing, not an event. Anything dropped here
        is logged as suppressed so the terminal and the wire agree.
        """
        if str(msg.get("class", "")).strip().lower() in _NON_EVENTS:
            return False
        if float(msg.get("confidence", 1.0)) < self.min_confidence:
            return False
        snr = msg.get("snr_db")
        return not (isinstance(snr, (int, float)) and snr < MIN_EVENT_SNR_DB)

    def wants_speech(self, cls: str, duration_s: float, confidence: float = 1.0, snr_db: float | None = None) -> bool:
        if duration_s < 0.30:
            return False
        if confidence < MIN_SPEECH_CONFIDENCE:
            return False
        if snr_db is not None and snr_db < MIN_SPEECH_SNR_DB:
            return False
        low = cls.lower()
        return any(s in low for s in _SPEECHY)

    def build_speech(
        self,
        *,
        seg: PendingSegment,
        samples: np.ndarray,
        t_now: float,
        bearing_deg: float | None = None,
    ) -> list[dict]:
        """Transcribe a finished speech segment → `speech` (+ parent update).

        Nothing is ever fabricated here: no transcript, no message. A wrong
        bubble is worse than a missing one.
        """
        if self.transcriber is None:
            return []
        tr = self.transcriber.transcribe(samples)
        if tr is None or not tr.text:
            log.debug("asr returned nothing for %s", seg.event_id)
            return []
        self._sid += 1
        msg = {
            "type": "speech",
            "id": f"s{self._sid}",
            "t": round(t_now, 3),
            "t_onset": round(seg.t_onset_s, 3),
            "parent_event": seg.event_id,
            "bearing_deg": round(float(seg.bearing_deg if bearing_deg is None else bearing_deg), 1),
            "text": tr.text,
            "partial": False,
            "confidence": round(float(tr.confidence), 3),
            "lang": tr.language or "en",
        }
        out = [self._remember(msg)]
        if tr.named:
            # Heard the wearer's name: that is the loudest thing a sound-awareness
            # system can learn, so the parent event is re-sent one tier louder
            # (same id — the HUD updates in place, README §4.5 `timeline`).
            parent = self._by_id.get(seg.event_id)
            if parent is not None and parent.get("urgency") in ("low", "normal"):
                parent = dict(parent)
                parent["urgency"] = "high"
                parent["name_heard"] = True
                self._by_id[seg.event_id] = parent
                out.append(parent)
                log.info("name spotted in %r — escalated %s to high", tr.text, seg.event_id)
        log.info("speech %s (%.1fs): %r", seg.event_id, len(samples) / self.rate, tr.text)
        return out

    # -- presence ----------------------------------------------------------
    def presence(self, t_now: float, prev: bool, fresh_s: float = 1.5) -> dict | None:
        """`presence` from the camera, not from a PIR we do not have.

        Emitted only on a state change, and only when the camera is actually
        feeding us — with no sensor there is no message at all.
        """
        if self.vision is None or not self.vision.available:
            return None
        human = self.vision.presence(t_now, ttl=fresh_s)
        if human == prev:
            return None
        return {"type": "presence", "t": round(t_now, 3), "human": human, "source": "camera"}

    # -- diagnostics -------------------------------------------------------
    def latency_summary(self) -> dict:
        if not self.latencies_ms:
            return {"n": 0}
        a = np.asarray(self.latencies_ms[-200:], dtype=np.float64)
        return {
            "n": int(a.size),
            "p50_ms": round(float(np.percentile(a, 50)), 1),
            "p95_ms": round(float(np.percentile(a, 95)), 1),
            "max_ms": round(float(a.max()), 1),
        }
