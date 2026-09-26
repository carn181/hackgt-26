# Backend evidence — owner B, 2026-09-26

Everything here was run on this laptop (`~/hackgt-26`, branch `ryan-integration`), Python 3.12 in
`.venv`, `models/yamnet.tflite` present (4126810 bytes, sha256 `10c95ea3eb9a7bb4cb8bddf6feb023250381008177ac162ce169694d05c317de`).
The ESP32 hat does not exist yet, so the pipeline runs against this laptop's 2-channel DMIC pair and
the §4.2 packet path is verified without hardware.

Commands are the evidence. Raw output is quoted, not paraphrased.

> **Correction (this revision).** An earlier revision of this document claimed the laptop's DMIC
> capture path was broken ("−15 dBFS junk, real tones 50 dB down, live acoustic DOA impossible").
> **That was wrong.** The measurement was taken while analysing the *channel mean* of a capture whose
> channel 1 carries a large DC offset and heavy LF content, and the stimulus level was never
> verified — so a working microphone was diagnosed as broken. §4 now reports the measured numbers
> and the one genuine limitation (no inter-channel baseline). The tool now refuses to let that
> mistake happen again: `tools/latency_bench.py --require-snr-db` fails a run whose events did not
> actually rise above the room.

---

## 1. What runs

| Command | What it does |
|---|---|
| `tools/run_backend.sh [--profile laptop_dmic]` | the service: capture → onset → DOA + YAMNet (+ Whisper) → `ws://127.0.0.1:8000/ws` (§4.5/§4.6) |
| `.venv/bin/python -m server.selftest` | 4 self-checks: DOA sweep, §8.2 model reproduction, §4.2 UDP framing, end-to-end pipeline |
| `.venv/bin/python tools/latency_bench.py --inject-side flip` | real-sound latency + the A10 sign-flip test + a stimulus-arrival check |
| `.venv/bin/python tools/udp_sniff.py --selftest` | §4.2 packet verifier (unblocks A5) |
| `curl -s localhost:8000/health` | live pipeline state: source stats, detector floor/peak, event count, latency summary |

Modules: `server/config.py` (geometry/profiles) · `ring.py` · `ingest.py` (pw/udp/serial/file + band-pass)
· `detect.py` (onset/offset) · `doa.py` (GCC-PHAT, sub-band spread, SRP-PHAT) · `beam.py` (channel
choice) · `classify.py` · `urgency.py` · `asr.py` · `vision.py` · `fuse.py` · `calib_fit.py` ·
`synth.py` · `selftest.py` · `main.py`.

---

## 2. Verified without any hardware

### 2.1 `python -m server.selftest` → 4/4 PASS

**DOA sweep** (README §0 B7, ±8° at −60/−30/0/+30/+60, 250 ms synthetic plane waves, 20 dB SNR):

```
laptop_dmic (2 mic, dx = 0.10 m assumed, uncalibrated)
  true°  measured°    err°     ±σ° method            conf      lag  mirror°
    -60     -59.64   +0.36    45.0 gcc-phat-pairs    0.60     4.03   -120.4
    -30     -28.33   +1.67    45.0 gcc-phat-pairs    0.60     2.21   -151.7
      0       0.17   +0.17    45.0 gcc-phat-pairs    0.60    -0.01    179.8
     30      28.41   -1.59    45.0 gcc-phat-pairs    0.60    -2.22    151.6
     60      59.76   -0.24    45.0 gcc-phat-pairs    0.60    -4.03    120.2

hat (4 mic, 80 mm spacing, 240 mm baseline)
    -60     -54.00   +6.00    18.0 srp-phat          0.60     6.34   -126.0
    -30     -32.00   -2.00    18.0 srp-phat          0.60     5.07   -148.0
      0       0.00   +0.00    18.0 srp-phat          0.60     0.00    180.0
     30      32.00   +2.00    18.0 srp-phat          0.60    -5.09    148.0
     60      54.00   -6.00    18.0 srp-phat          0.60    -6.35    126.0
```

Both profiles meet ±8°. Two conventions were wrong in the first draft and the sweep is what caught
them: the lag was being divided by the FFT zero-pad factor, and `sinθ` was missing its sign.

**`--only udp`** (§4.2 over a real socket, no ESP32): 5/5 packets, `seq 0..4`, per-channel levels
`[0.0305 0.061 0.0916 0.1221]` round-trip exactly. The serial path shares `parse_packet`.

**`--only e2e`** (the whole pipeline: file source → ring → detector → scheduled classification → DOA →
YAMNet → fusion):

```
e1: class='Telephone' conf=0.92 bearing=+38.1° ±45° source=array onset→msg=361 ms
e2: class='Telephone' conf=0.94 bearing=-41.3° ±45° source=array onset→msg=360 ms
```

Two tone bursts generated at +40° and −40° in the profile's own geometry → recovered within 3° with
the correct sign flip, and the onset→message cost of the pipeline is 360 ms.

**`--only model`**: `python -m server.classify` — 8/8 checks. Sine 440 Hz → `Sine wave` **0.996**;
white noise → `Static` 0.738; pink noise → `Noise` 0.918; real speech → **0.968–0.984** (> 0.7);
521 classes; 15600-sample window enforced.

### 2.2 Inference cost (README §0 B4)

| Model | Cost | Notes |
|---|---|---|
| YAMNet (`ai-edge-litert`, XNNPACK CPU) | **5.65 ms mean** per 0.975 s window (min 5.53, max 5.81, 50 runs) | first run carries XNNPACK warm-up (7.4 ms) |
| GCC-PHAT + coherence, 4096-sample window | ~8 ms | 2 mics × 6 sub-bands |
| Whisper `base.en`, int8, CPU, **4 threads** | **0.76 s** per 6.0 s clip (RTF 0.13) | 2 threads 1.39 s, 8 threads 0.81 s — 4 is the knee on this 16-core box |
| Whisper, default thread count, on 10 s of *noise* | 11.9 s | why the input is now capped at 6 s and gated |

**What Whisper costs the pipeline (measured).** It never blocked classification — the ASR worker is a
separate thread and the onset→event latency stayed at p50 391 ms *while* a 10 s decode ran. What it
did cost: 11.9 s of CPU per long segment, a machine that was audibly busy, and **fabricated captions**
from room noise (`'You'`, `'maybe be each pec'`). Four gates now stand in front of it: the class must
be in the speech family, `confidence ≥ 0.35`, segment `snr_db ≥ 15`, input capped at 6 s, and
Whisper's own `no_speech_prob` must average below 0.6 — the last one is the real anti-hallucination
guard, since the model will happily invent fluent text for noise.

**Classification latency.** The deliberate `--classify-tail` wait was 0.35 s and is now **0.20 s**:
the synthetic end-to-end check reports the same class and bearing with `onset→msg` **200 ms**
(down from 360 ms), because YAMNet is insensitive to where a transient sits inside its fixed window.
The flag is still there to trade back: if a real clap reads badly on the hat, `--classify-tail 0.35`
costs 150 ms and restores the older window placement.

---

## 3. Measured latency, real sound, loopback WS (the ask)

`.venv/bin/python tools/latency_bench.py --duration 16 --inject tone --inject-side flip --shots 3`,
backend on `--profile laptop_dmic --source pw`, sounds played through the speakers with `pw-play
--target 57` (sink raised for the test, restored afterwards). Three stages are reported separately,
because "the latency" is otherwise ambiguous:

```
ping echo RTT (the HUD's own metric)  n=120 p50=0.8 ms  p95=1.2  p99=2.2  max=2.7
backend onset→emit                    n=5  p50=232.0   p95=233.6
emit→client (clock-corrected)         n=5  p50=2.9     p95=5.3
onset→client  <-- the README's number n=5  p50=234.0   p95=237.5
play command→client (incl. player)    n=5  p50=326.6   p95=1212.1
messages: backend_status 4, array_status 13, timeline 1, ping 120, sound_event 5
connect 19.9 ms · arrival gap p50 201.1 ms (the 2 s/10 s status cadence plus events)
stimulus: best event SNR 36.5 dB (need >= 12) -> OK
```

- **onset → client p50 234 ms, p95 238 ms** against a 1.5 s budget (README §3).
- **emit → client p50 2.9 ms** over loopback with browser clients attached.
- **ping RTT 0.8 ms p50** — the same metric the HUD shows in its diagnostics chip.
- The classes are right too: `Telephone 0.80 / 0.89 / 0.85` at SNR 35–36 dB for the played
  two-tone bursts, and 5 of 6 bursts reached the client (one merged into a neighbouring segment).
- Backend-internal breakdown: 200 ms is the deliberate `--classify-tail` wait (see below);
  DOA + YAMNet together are ~15 ms.
- The `play command→client` figure is dominated by `pw-play` start-up (0.25–1.2 s); it is reported
  so nobody mistakes it for pipeline cost. The generated wav has a 1.5 s lead-in for exactly that
  reason.

The bench validates its own clock handling: the backend/client offset is the min-filtered
`recv − t`, so `emit→client` excludes the fastest path's one-way delay (sub-ms on loopback) and the
absolute figures are conservative.

### 3.1 Three bugs these measurements found

**Whisper was running on the capture thread.** The first bench run reported
`onset→emit p50 19 982 ms`, `source.jitter_ms_max 16 303 ms` and `rate_est_hz 15 273` (nominal
16 000): every speech-ish event cost ~1.2 s of decode inline, block reads fell behind and the ring
buffer drifted. ASR now runs on a worker thread with a bounded queue, and the segment audio is
sliced on the capture thread before queueing (the ring only holds 20 s). After the fix:
`rate_est_hz 15 935`, `jitter_ms_max 137 ms`.

**The detector's release rule never fired in a live room.** A segment closed only when
`level < floor + 5 dB`, and a room whose level wanders ±6 dB around a floor estimated from its
quietest frames never satisfies that — so a segment opened by a room bump stayed open until
`max_duration`, and **every real sound inside it was absorbed and classified against the room-bump
window**. Measured symptom: one event every 12 s (exactly `max_duration`), classes `Silence` at
confidence 0.1–0.5, and a real tone burst logged as `Fart 0.33`. The release level is now
`max(floor + 5 dB, segment_peak − 12 dB)`: a segment ends when it is quiet *relative to its own
peak*, which is what a VAD does. Result: the same tone bursts became `Telephone 0.80–0.89` at SNR
35 dB, 5 of 6 reaching the client, and the event rate became sound-driven instead of
cap-driven.

**The stimulus itself was silently broken, twice.** `pw-play` needs 0.25–2.2 s to start, so it ate
the first burst of every file — with one-burst files the microphone heard *nothing* and the run
"proved" the array was deaf. Generated files now carry a 1.5 s lead-in, the sink is resolved once
and pinned for the whole run (a default that moves mid-run sends the stimulus somewhere the mic
cannot hear), and every event's `snr_db` is checked against `--require-snr-db` before the run is
allowed to count. The tool exits 3 rather than reporting a confident conclusion from silence.

---

## 4. The laptop stand-in array: what works, and the one thing that does not

### 4.1 Capture path: fine

Hardware, read from `/proc/asound/card2/pcm0c/sub0/hw_params` while capturing:
`format: S32_LE, rate: 48000, channels: 2, period_size: 1024` (`dmic-hifi-0` on the `acp` card).
PipeWire presents it to us as 16 kHz S16; requesting the native 48 kHz S32 is equally clean.

| Measurement | Result |
|---|---|
| ch0 idle | rms −26.2 dBFS, DC +892 LSB, 0–300 Hz −49.5, 300–3k **−64.4**, 3–6k −80.2 |
| ch1 idle | rms −15.1 dBFS, DC **+5390 LSB**, 0–300 Hz **−37.1**, 300–3k −63.7, 3–6k −78.6 |
| speaker-played 650 Hz tone at the mic | peak bin **−23.0 dB** → **41 dB in-band SNR** |
| native 48 kHz S32 capture of the same tone | tone −16.5 dB, Nyquist −113 dB (no HF junk) |
| live speech (espeak-ng, limited, sink 1.0) | class `Speech` 0.50, urgency `high`, **snr 44.6 dB** |
| 1 kHz tone at the sink monitor (playback reference) | −21.7 dB |
| playback stability, 7 consecutive plays | −21.3 … −22.7 dB (no amp wake-up effect) |

So: onset detection, classification and transcription all work on live audio. Channel 1 is the noisy
one — a 16 %-of-full-scale DC offset and ~12 dB more LF energy than channel 0 — which is exactly why
the **analysis band-pass is required**: an RMS detector working on the channel mean sees ch1's LF
content (27 dB above the in-band floor) rather than the sound. Measured: a clap played from the
speakers rose **5.6 dB** above the room unfiltered and **26 dB** after the band-pass, with **0**
onsets detected unfiltered versus every clap detected filtered. The band-pass also removes ch1's DC
step before YAMNet sees it.

### 4.2 The blocker: the pair has no baseline

Three independent measurements, each with a different method, all agree:

| Method | Result |
|---|---|
| 500/650 Hz tone, one speaker at a time, 0.5 s window | coherence 0.67–0.87; GCC lag **0.0–0.5 samples** at 16 kHz; **no sign flip** between left and right (a 100 mm pair at ±22° would give ±1.7 samples) |
| cross-spectrum phase at 400/500/600/700 Hz | coherence 0.96–1.00, but phase jumps −53°…+64° with **no linear trend** and no sign flip — not a pure delay |
| broadband click at the native 48 kHz, cross-correlation on the click | lags −17…+2 samples, **no sign flip** (a 280 mm pair would show ±39 samples; even 30 mm would show ±4) |

Effective inter-channel baseline is **< ~5 mm**, i.e. the two channels are the same acoustic point
(same capsule, or capsules a few millimetres apart). No azimuth is recoverable from this pair, and
`estimate_bearing`'s coherence gate is the correct behaviour: it refuses, and the event goes out with
`source: "none"`, `accuracy_deg: 180`, `ambiguous: true` so the HUD fades it instead of drawing a
confident lie.

Consequences:

- The **A10 sign-flip test cannot pass on this laptop** — not because the DSP is wrong (the synthetic
  sweep recovers ±60° to within 2°) but because there is no baseline to measure. The harness is
  ready: `tools/latency_bench.py --inject-side flip` prints `sign flip: OK` / `MISMATCH` /
  `no localized event for the <side> side` and exits non-zero when inconclusive.
- The **hat is unaffected**: 80 mm spacing, 240 mm baseline, and the same code path (`--profile hat`)
  is verified synthetically to ±6° with SRP-PHAT.
- The gate is profile-dependent: **γ² ≥ 0.55 on an uncalibrated array** (vs 0.35 once a spacing has
  been measured), because an unknown scale can be wrong in magnitude *and* direction. Before that
  tightening one marginal live window produced a `-90.0°` bearing at `±45°`; after it, live
  estimates on this laptop are all rejected. A genuine common source measures γ² ≈ 1.0, so the
  tighter gate costs nothing on a working array.

### 4.3 Live speech path (B11)

- A **12.4 s ambient segment was transcribed live** and emitted as `speech e63` with real text, with
  the parent event linked, on the worker thread.
- A controlled stimulus (espeak-ng "hey sam did you see that", limited and normalized) produced
  `sound_event` class `Speech` at 44.6 dB SNR with `urgency: high`, then a `speech` message with
  `parent_event` set.
- The transcript's *content* could not be verified against the known phrase in this room: it is
  contaminated by continuous ambient speech (a real 12 s transcript of unrelated speech appeared
  while the sink was muted). The word-level match is verified at module level instead
  (`server/asr.py`'s own check: synthesized phrase transcribed word-for-word). A controlled
  "text matches" test needs a quiet room.
- The name spotter is verified at module level (`"Hey Sam, are you there?"` → `named=True`); it did
  not fire live because the room's speech does not contain the configured name.

### 4.4 Class-quality caveat and the overload gates

YAMNet's fixed 0.975 s window dilutes a 30 ms transient, so a *synthetic* click reads
`Silence`/`Tick` rather than `Clapping`; a real clap recording is the honest test.

Two problems showed up in a long live run and are now fixed at the source:

1. **The log filled with `Silence`.** A detector working against a −68 dB floor fires on every room
   bump, and the classifier honestly answers `Silence` (or YAMNet's room-tone class `Inside, small
   room`) at confidence 0.1–0.5. Those are measurements of nothing, not events. An event is now
   reported only when its class is not in the no-sound list *and* its segment `snr_db ≥ 12`.
2. **The terminal and the wire disagreed.** Suppressed events were logged like any other, so the HUD
   looked broken while the log looked busy. The log line now says `SUPPRESSED`, and the periodic line
   reports `events sent N, suppressed M` so the ratio is visible at a glance.

A third cause of "the log has events but the HUD shows no markers" is *by design* and stays: an event
that could not be localized is sent with `source: none`, `accuracy_deg: 180`, `ambiguous: true`, and
the HUD fades it to nothing rather than drawing a confident lie. On this laptop that is most events
(§4.2); on the hat they will have positions.

---

## 5. Camera path (the only sensor that can still localize on this laptop)

There is exactly one webcam and the browser owns it, so the backend gets its camera from the HUD over
the socket (`vision`, README §4.6 — additive, added in the same commit as `web/src/ws.ts`).

Verified over the wire with a real WS client sending `{"xc":0.80,"w":0.14,"mouth":0.55,"mouthActive":true}`
while a tone played:

- `presence` transitions emitted from the camera: `(489.191, True) → (491.194, False)`, `source: camera`.
- The face-to-bearing mapping is the exact inverse of `web/src/projection.ts`: xc 0.80 at 62° FOV
  predicts **+19.8°**; a face at that bearing is what `fuse.localize` uses for `source: vision` /
  `array+vision`, with the error bar from the box width.
- The HUD renders my stream with `unknownTypes: 0, malformed: 0` — the additive fields do not break
  the frozen consumer.

Not verified automatically: the browser end of it. The managed headless Chromium returns
`NotAllowedError: Permission denied` for `getUserMedia`, so the camera could not be opened from this
session. The frontend change typechecks (`npx tsc --noEmit` clean) and the user's own browser was
connected to this backend during testing (3–4 clients, diagnostics chip reading
`OPEN · YAMNET · PW · 2BCEA84 · MICS 2/2`), which is where the visual confirmation has to come from.

---

## 6. Contract additions (README §4.5/§4.6, same commit)

- `sound_event`/`speech`: `t_onset` (the reference for onset→client latency), plus diagnostics
  `method`, `delay_samples`, `snr_db`, `peak_db`, `alternatives`, `name_heard`.
- `array_status.calibration`: `calibrated`, `profile`, `fit_spacing_m`, `fit_n`.
- `backend_status`: `source`, `asr`, `vision_frames`, `mode`, `noise_floor_db`, `events`, `latency`.
- §4.6: `vision` (face boxes from the HUD, ~10 Hz, aged out after 0.6 s).

All additive; the HUD ignores unknown keys by design and the live run confirmed it.

## 7. Open / not claimed

| Item | State |
|---|---|
| B10 live sign-flip | blocked by the missing baseline (§4.2), not by code; synthetic sign flip verified |
| B11 controlled live `speech` text match | live path works end-to-end; word-level match verified at module level; a controlled test needs a quiet room |
| B13 fresh venv on a second machine | not run; fresh install on this machine succeeded (`import ai_edge_litert` OK, no §8.5 loader workaround needed) |
| Live `Clapping` label | not claimed (synthetic-click caveat, §4.4) |
| `--profile hat` end-to-end | synthetic only; needs A's packets |
| Serial (§4.2 over USB-CDC) | same parser as UDP, live test pending a board |
| Spacing auto-fit (`calib_fit.py`) | implemented and gated; needs a *coherent* array, so it starts working on the hat |
| `array_status` at 2 s + `backend_status` at 10 s | chosen to match the HUD's cadence; no overload pressure measured (3 clients, emit→client p95 12.7 ms) |
