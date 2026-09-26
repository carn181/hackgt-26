"""Onset / offset detection: decide *when* something happened.

The backend must not classify 10 times a second and spam the HUD — SoundWatch's
finding (the one this project is built on) is that overload is the failure mode.
So the detector's job is to be stingy: track the room's noise floor, fire on a
genuine rise, hold while the sound lasts, and report the exact sample where it
started.

The floor is an EMA in dB with a slow time constant, and events only fire when
the level rises `rise_db` above it *and* the absolute level is above a hard gate
(the floor tracks up during applause; a refrigerator hum must never become an
"event" just because the room got quiet). All the analysis windows downstream
are cut from the sample index reported here, which is also what makes the
onset→HUD latency measurable.
"""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass

import numpy as np

log = logging.getLogger("server.detect")

EPS = 1e-12


@dataclass
class Onset:
    index: int      # absolute sample index of the first sample above threshold
    t_us: int       # capture time of that sample
    peak_db: float
    snr_db: float


@dataclass
class Offset:
    index: int      # absolute sample index where the sound ended
    t_us: int
    onset: Onset
    duration_s: float
    peak_db: float


class OnsetDetector:
    """Streaming energy detector with an adaptive floor and hysteresis.

    Parameters are in the units a human can check: dB above the floor, seconds.
    `refractory_s` collapses a clap's double transient into one event; `hang_s`
    keeps a segment open through the natural dips inside a spoken sentence.
    """

    def __init__(
        self,
        rate: int,
        *,
        hop_ms: float = 10.0,
        rise_db: float = 9.0,
        release_db: float = 5.0,
        release_below_peak_db: float = 12.0,
        floor_tau_s: float = 1.5,
        min_abs_db: float = -58.0,
        refractory_s: float = 0.25,
        hang_s: float = 0.30,
        min_duration_s: float = 0.06,
        max_duration_s: float = 8.0,
    ):
        self.rate = int(rate)
        self.hop = max(1, int(round(rate * hop_ms / 1000.0)))
        self.rise_db = float(rise_db)
        self.release_db = float(release_db)
        self.release_below_peak_db = float(release_below_peak_db)
        self.min_abs_db = float(min_abs_db)
        self.refractory = int(round(refractory_s * rate))
        self.hang = int(round(hang_s * rate))
        self.min_duration = int(round(min_duration_s * rate))
        self.max_duration = int(round(max_duration_s * rate))
        alpha = 1.0 - np.exp(-hop_ms / 1000.0 / floor_tau_s)
        self._floor_alpha = float(alpha)
        self._floor_db: float | None = None
        self.n = 0                 # absolute sample index consumed
        self._pending = np.zeros(0, dtype=np.float32)
        self._hist = deque(maxlen=4)  # last few frame levels, for the onset start
        self._active: Onset | None = None
        self._below_since: int | None = None
        self._last_event_end = -(1 << 60)
        self.peak_db = -120.0

    # -- introspection for the WS `backend_status` debug readout -----------
    @property
    def floor_db(self) -> float:
        return -90.0 if self._floor_db is None else self._floor_db

    def push(self, mono: np.ndarray, t_us_first: int) -> list[Onset | Offset]:
        """Consume mono samples; return the onsets/offsets that just resolved.

        `t_us_first` is the capture time of `mono[0]`; sample-time arithmetic is
        done in the sample domain so a late block never shifts an event.
        """
        events: list[Onset | Offset] = []
        if mono.ndim != 1:
            raise ValueError("detector wants a mono (1-D) signal")
        x = np.concatenate((self._pending, mono.astype(np.float32, copy=False)))
        n_frames = len(x) // self.hop
        for f in range(n_frames):
            frame = x[f * self.hop : (f + 1) * self.hop]
            frame_start = self.n + f * self.hop
            db = 10.0 * np.log10(float(np.mean(np.square(frame, dtype=np.float64))) + EPS)
            self.peak_db = max(self.peak_db, db)
            ev = self._frame(db, frame_start)
            if ev is not None:
                events.append(ev)
        consumed = n_frames * self.hop
        self._pending = x[consumed:].copy()
        self.n += consumed
        # t_us of the first sample of each event is reconstructed from t_us_first
        # and the absolute index difference (the offset carries its onset, which
        # downstream code needs to find the event it belongs to).
        for ev in events:
            ev.t_us = int(t_us_first + (ev.index - self.n) * 1e6 / self.rate)
            if isinstance(ev, Offset):
                ev.onset.t_us = int(t_us_first + (ev.onset.index - self.n) * 1e6 / self.rate)
        return events

    def _frame(self, db: float, frame_start: int) -> Onset | Offset | None:
        floor = self._floor_db
        if floor is None:
            self._floor_db = db
            self._hist.append(db)
            return None

        if self._active is None:
            self._hist.append(db)
            if floor + self.rise_db < db and db > self.min_abs_db and frame_start - self._last_event_end > self.refractory:
                # The rise started somewhere inside this hop; the previous frame
                # in the history is the best estimate of that sample.
                prev = self._hist[-2] if len(self._hist) >= 2 else db
                start = frame_start - self.hop
                if prev > floor + self.rise_db * 0.5:
                    start = max(0, frame_start - 2 * self.hop)
                self._active = Onset(index=start, t_us=0, peak_db=db, snr_db=db - floor)
                self._below_since = None
                log.debug("onset at sample %d (%.1f dB, floor %.1f)", start, db, floor)
                return self._active  # the onset goes out *now*; the offset follows later
            else:
                # Only the quiet frames update the floor, so a long loud passage
                # cannot drag the floor up and hide the next event.
                self._floor_db = (1 - self._floor_alpha) * floor + self._floor_alpha * db
            return None

        # Active: keep the segment open until it has been quiet for `hang`.
        #
        # The release level is measured against *both* the room floor and the
        # segment's own peak. The floor alone is not enough in a live room: a room
        # whose level wanders ±6 dB around a floor estimated from its quietest
        # frames never satisfies `db < floor + 5`, so a segment opened by a room
        # bump stayed open until `max_duration` — measured live, one segment every
        # 12 s with every real sound inside it absorbed and classified against the
        # room-bump window. That is what "the log is full of Silence and nothing
        # reaches the HUD" was.
        act = self._active
        act.peak_db = max(act.peak_db, db)
        act.snr_db = max(act.snr_db, db - self._floor_db)
        release = max(self._floor_db + self.release_db, act.peak_db - self.release_below_peak_db)
        if db < release:
            if self._below_since is None:
                self._below_since = frame_start
            elif frame_start - self._below_since >= self.hang:
                return self._close(frame_start)
        else:
            self._below_since = None
        if frame_start - act.index >= self.max_duration:
            return self._close(frame_start)
        return None

    def _close(self, frame_start: int) -> Offset | None:
        act = self._active
        assert act is not None
        self._active = None
        end = self._below_since if self._below_since is not None else frame_start
        self._last_event_end = end
        self._floor_db = (1 - self._floor_alpha) * self._floor_db + self._floor_alpha * self.peak_db_during_quiet(act)
        if end - act.index < self.min_duration:
            log.debug("dropping %d-sample blip", end - act.index)
            return None
        return Offset(index=end, t_us=0, onset=act, duration_s=(end - act.index) / self.rate, peak_db=act.peak_db)

    def peak_db_during_quiet(self, act: Onset) -> float:
        """Floor update at segment end: use the tracker's own floor, not the peak."""
        return min(act.peak_db, self._floor_db + 6.0) if self._floor_db is not None else act.peak_db
