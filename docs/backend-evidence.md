# Backend evidence — owner B, 2026-09-26

Everything here was run on this laptop (`~/hackgt-26`, branch `ryan-integration`), Python 3.12 in
`.venv`, `models/yamnet.tflite` present (4126810 bytes, sha256 `10c95ea3eb9a7bb4cb8bddf6feb023250381008177ac162ce169694d05c317de`).
The ESP32 hat does not exist yet, so the pipeline runs against this laptop's 2-channel DMIC pair and
the §4.2 packet path is verified without hardware.

Commands are the evidence. Raw output is quoted, not paraphrased.

---

## 1. What runs

| Command | What it does |
|---|---|
| `tools/run_backend.sh [--profile laptop_dmic]` | the service: capture → onset → DOA + YAMNet (+ Whisper) → `ws://127.0.0.1:8000/ws` (§4.5/§4.6) |
| `.venv/bin/python -m server.selftest` | 4 self-checks: DOA sweep, §8.2 model reproduction, §4.2 UDP framing, end-to-end pipeline |
| `.venv/bin/python tools/latency_bench.py --inject-side flip` | real-sound latency + the A10 sign-flip test |
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
them: the lag was being divided by the FFT zero-pad factor, and `sinθ` was missing its sign. The sign
is now pinned by `_bearing_from_lags`'s docstring and by the end-to-end check below.

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
| Whisper `base.en`, int8, CPU | **1.2 s** per 2.78 s utterance (**0.43× realtime**) | warm load 1.4 s; cold load + download 7.5 s |

---

## 3. Measured latency, real sound, loopback WS (the ask)

`.venv/bin/python tools/latency_bench.py --duration 18 --inject tone --inject-side flip --shots 3`,
backend on `--profile laptop_dmic --source pw`, sounds played through the speakers with `pw-play`
(sink raised to 0.9 for the test, restored afterwards). Three stages are reported separately, because
"the latency" is otherwise ambiguous:

```
ping echo RTT (the HUD's own metric)  n=90 p50=1.3 ms  p95=1.6  p99=1.9  max=2.4
backend onset→emit                    n=5  p50=386.0   p95=399.6
emit→client (clock-corrected)         n=5  p50=12.9    p95=23.4
onset→client  <-- the README's number n=5  p50=391.7   p95=414.5
play command→client (incl. player)    n=3  p50=635.7   p95=2964.7
messages: backend_status 3, array_status 10, timeline 1, ping 90, sound_event 5
connect 31.0 ms · arrival gap p50 200.8 ms (the 2 s/10 s status cadence plus events)
```

- **onset → client p50 392 ms, p95 415 ms** against a 1.5 s budget (README §3).
- **emit → client p50 12.9 ms** over loopback with three browser clients attached.
- **ping RTT 1.3 ms p50** — the same metric the HUD shows in its diagnostics chip (it reported
  1.3–1.7 ms median from the browser while this ran).
- Backend-internal breakdown: 350 ms of the 386 ms is the deliberate classification tail
  (`--classify-tail`, the wait that puts the sound in the middle of YAMNet's 0.975 s window);
  DOA + YAMNet together are ~15 ms.
- The three late `play command→client` samples are `pw-play` process start-up (250 ms–2.9 s),
  not the pipeline: it is reported to show what the injection harness adds.

The bench also validates its own clock handling: the backend/client offset is the min-filtered
`recv − t`, so `emit→client` excludes the fastest path's one-way delay (sub-ms on loopback). The
absolute figures are therefore conservative.

### 3.1 Bug this measurement found (worth reading)

The first bench run reported `onset→emit p50 19 982 ms`, `source.jitter_ms_max 16 303 ms` and
`rate_est_hz 15 273` (nominal 16 000). Cause: **Whisper was running on the capture thread** — every
speech-ish event cost ~1.2 s inline, block reads fell behind, and the ring buffer drifted. Fix:
ASR now runs on a dedicated worker thread with a bounded (4-deep) queue, and the segment audio is
sliced on the capture thread before queueing (the ring only holds 20 s). After the fix the same run
gave `rate_est_hz 15 935`, `jitter_ms_max 137 ms` and the numbers above. Any future heavy stage
belongs on a worker, not in `_consume`.

---

## 4. Hardware finding: this laptop's DMIC capture is not usable for acoustic analysis

This is the honest blocker for the "live audio" half of §0 B8/B10/B11, and it is a *capture path*
problem, not a code problem. Measured with the sink monitor as the reference, so the two sides are
independent:

| Measurement | Result |
|---|---|
| 1 kHz tone at the sink monitor (playback reference) | **−21.7 dB** — playback is clean |
| the same tone at the mic (any of the 3 capture nodes) | **−73 … −80 dB** |
| mic idle level, 300–6000 Hz band | **−15 … −18 dBFS**, U-shaped spectrum: +21.8 dB (0–250 Hz), +20.6 dB (7.75–8 kHz), top bins at 0 Hz and Nyquist at **+68 dB** |
| channel DC offsets | ch0 +5162 LSB, ch1 +5167 LSB |
| clap played from the speakers, unfiltered | 5.6 dB above the room → **0 onsets detected** |
| the same clap, after the 300–6000 Hz band-pass | **26 dB** above the room → every clap detected |
| inter-channel coherence, 500 Hz tone at 0.95 volume, 0.5 s window | **0.06–0.12** |
| measured TDOA for the same tone, left vs right speaker | −0.1, +1599.8, −319.9, −320.3 samples — no reproducible directionality |

Consequences, stated plainly:

- The **band-pass (`BandPass`, `highpass_hz`/`lowpass_hz` per profile) is mandatory**, not hygiene:
  without it the noise floor sits ~45 dB above the room and the detector never fires.
- `estimate_bearing` **refuses to report an angle** here (coherence gate), so live events carry
  `source: "none"`, `accuracy_deg: 180`, `ambiguous: true` — the HUD fades them instead of drawing a
  confident lie. That is the designed behaviour, and it is why the laptop's live sign-flip test is
  **not verifiable today**: the bench prints `no localized event for the left side — the array could
  not measure this source`.
- Everything that does *not* need directionality works on the laptop: onset timing, event cadence,
  classification, transcription, presence (camera), the whole latency chain.
- On the hat the same code path is used with `--profile hat`; the synthetic sweep above (±6° at
  ±60°) and `tools/latency_bench.py --inject-side flip` are the two tests to run the day A's array
  streams §4.2 packets.

Class-quality caveat, same spirit: YAMNet's fixed 0.975 s window dilutes a 30 ms transient, so a
synthetic click reads `Silence`/`Tick` rather than `Clapping`. A *real* clap recording is the honest
test; nothing in this doc claims a live `Clapping` label.

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
`NotAllowedError: Permission denied` for `getUserMedia` (the flag is not applied to the shared
instance), so the camera could not be opened from this session. The frontend change typechecks
(`npx tsc --noEmit` clean) and the user's own browser was connected to this backend during testing
(3 clients, diagnostics chip reading `OPEN · YAMNET · PW · 2BCEA84 · MICS 2/2`), which is where the
visual confirmation has to come from.

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
| B10 live sign-flip, B11 end-to-end `speech` | blocked on the capture path above, not on code |
| B13 fresh venv on a second machine | not run; fresh install on this machine succeeded (`import ai_edge_litert` OK, no §8.5 loader workaround needed) |
| Live `Clapping` label | not claimed (synthetic-click caveat, §4) |
| `--profile hat` end-to-end | synthetic only; needs A's packets |
| Serial (§4.2 over USB-CDC) | same parser as UDP, live test pending a board |
| Spacing auto-fit (`calib_fit.py`) | implemented and gated; needs a *coherent* array (it borrows the camera bearing while someone talks), so it starts working on the hat |
| `array_status` at 2 s + `backend_status` at 10 s | chosen to match the HUD's cadence; no overload pressure measured (3 clients, 12.9 ms emit→client p95) |
