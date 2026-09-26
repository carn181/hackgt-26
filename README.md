# hackgt-26 — Spatial Sound Awareness HUD

A microphone array that finds **where** a sound came from, identifies **what** it is, and renders both
on a camera HUD — so a d/Deaf or hard-of-hearing user can see the room's soundscape the way a game
shows off-screen threats. Speech is transcribed and anchored to the face that produced it.

**Status:** scaffolding. Deadline **Sun 2026-09-27 08:00 EDT**. Expo **09:00–11:15**. Code freeze **05:00**.
Target hardware: ESP32-S3 + 4× INMP441 I2S mics, servo pan stage, PIR, HC-SR04, WS2812 ring.

---

## 1. What we are building and why it isn't the 42nd version of this

The category ("sound awareness for DHH users") is well populated — see §11. Two prior projects explicitly
left our core claim as *future work*:

- **echoAI** (Qualcomm × LiteRT): *"our array consisted of a 1D line of closely spaced microphones… impossible to
  achieve greater than 1D localization"*; plans DOA + external mic arrays.
- **Low-latency Sound Disambiguator** (UB Hacking 2025): *"3D Spatial Localization: upgrade from 2D to full 3D
  using 3-4 microphone arrays with multilateration."*

Our delta, in one sentence for the write-up:

> We measure **bearing on real synchronized hardware** (planar array, one sample clock), report a **calibration
> curve** instead of a claim, resolve the front/back ambiguity by **rotating the array**, and deliver direction
> through a **physical pointer** as well as a screen — so the system works with no headset and no display.

Three things we must therefore do and say explicitly:
1. Report measured accuracy (play claps at 12 known angles; plot mean error + spread). No hand-waving.
2. Cite the prior art by name and state what we extend. Judges who know SoundWatch/HoloSound will check.
3. Ship the physical pointer. It is the only part of this nobody has built.

---

## 2. Constraints (do not plan around these being relaxed)

| Constraint | Value |
|---|---|
| Hacking window | Fri 20:00 → **Sun 08:00** (~31 h left at commit time) |
| Expo / judging | Sun 09:00–11:15, Devpost write-up + 2-minute video |
| Hive (3D printing / laser) | Sat **15:00–21:00** only — one fabrication window |
| Submission rule | **One track only**; unlimited sponsor challenges |
| Track candidates | **Social Good (Aramco)** — accessibility framing, least crowded · **Lighthouse (Immersive)** — if the HUD is the hero |
| Free sponsor stacks | Notability (2 screenshots in write-up), Create-X (interest flag), SpaceXAI (build in Cursor/Grok) |
| Not reachable from this project | Visa ($5k), Impiricus ($3k), Meta — those need commerce / HCP / social-product framing |

---

## 3. Architecture

```
  ┌──────────────┐   4-ch PCM over UDP (:7000)   ┌─────────────────────────┐
  │  ESP32-S3    │ ─────────────────────────────▶│  backend (laptop)       │
  │  4× INMP441  │    telemetry JSON   (:7001)   │  • UDP ingest + ringbuf │
  │  servo pan   │◀───────────────────────────── │  • GCC-PHAT / SRP-PHAT  │
  │  PIR, sonar  │    servo/led commands (:7002) │  • YAMNet  (class)      │
  │  WS2812 ring │                               │  • faster-whisper (text)│
  └──────────────┘                               │  • fusion → events      │
                                                 └───────────┬─────────────┘
                                                             │ WebSocket :8000/ws
                                                             ▼
                                                 ┌─────────────────────────┐
                                                 │  web (browser)          │
                                                 │  • getUserMedia camera  │
                                                 │  • MediaPipe faces      │
                                                 │  • HUD overlay + bubbles │
                                                 └─────────────────────────┘
```

### Latency budget (target ≤ 1.5 s end-to-end)

| Stage | Budget | Measured |
|---|---|---|
| Audio window (TDOA 0.1–0.3 s; YAMNet 0.975 s) | 1.0 s | — |
| Hop / decision cadence | 0.25 s | — |
| YAMNet inference | < 50 ms | **2.4–2.9 ms** (verified) |
| Whisper on a 2–4 s utterance | 0.3–0.8 s | — |
| WS + render | < 50 ms | — |

---

## 4. Frozen interfaces

**Do not change these unilaterally.** If a change is required, edit this section in the same commit that
changes the code, and say so in the commit message — a teammate may be mid-flight against the old shape.

### 4.1 Angle convention (get this wrong and every downstream sign is wrong)

- `bearing_deg`: **0° = straight ahead of the array** (aligned with the camera's optical axis by calibration).
- Positive = **clockwise viewed from above** (i.e. toward the user's right). Range `-180 … +180`.
- `elevation_deg`: `+` up. `null` until the planar array is calibrated for it.
- `accuracy_deg`: estimated 1-sigma error. Never omit; the HUD fades markers by it.

### 4.2 ESP32 → backend: audio, UDP `:7000`

Little-endian, one packet = one block for all channels:

```
offset  type    field
0       u16     magic     0xA14D
2       u8      version   1
3       u8      nch       number of channels (4)
4       u32     seq       packet counter, wraps
8       u64     t_us      ESP32 monotonic microseconds at first sample
16      u16     nsamp     samples per channel (default 320 = 20 ms)
18      i16[]   samples   channel-major, nch blocks of nsamp
```

- Rate 16 000 Hz. 320 samples ⇒ 50 packets/s/ch ⇒ 1.0 Mbit/s at 4 ch.
- No retransmission. Packet loss is expected; `seq` gaps are measured, not fixed.
- Channels: `0,1` = bus 0 (L/R), `2,3` = bus 1 (L/R). Geometry in `config/array.json`.

### 4.3 ESP32 → backend: telemetry, UDP `:7001` (2 Hz, JSON)

```json
{"type":"telemetry","t_us":123456789,"rssi":-52,"dropped":3,"servo_deg":-40.0,
 "pir":true,"sonar_cm":214,"temp_c":41.2,"fw":"0.3"}
```

### 4.4 backend → ESP32: commands, UDP `:7002` (JSON)

```json
{"type":"aim","deg":-37.5}        // point the stage / light the ring
{"type":"scan","from":-150,"to":150,"speed":90}   // deg/s
{"type":"home"}
{"type":"led","mode":"direction","deg":-37.5,"hue":210}
```

### 4.5 backend → frontend: WebSocket `ws://127.0.0.1:8000/ws`

Every message has `type` and `t` (seconds since backend start, monotonic).

```json
{"type":"sound_event","id":"e17","t":12.34,"class":"Speech","confidence":0.91,
 "bearing_deg":-37.5,"elevation_deg":null,"accuracy_deg":12,"urgency":"normal",
 "source":"array","parent_event":null}

{"type":"speech","id":"s3","t":12.9,"parent_event":"e17","bearing_deg":-35.0,
 "text":"did you see that","partial":false,"confidence":0.78,"lang":"en"}

{"type":"presence","t":12.9,"human":true,"source":"pir","bearing_deg":null}

{"type":"array_status","t":13.0,"mics":[{"id":0,"ok":true},{"id":1,"ok":true},
 {"id":2,"ok":false},{"id":3,"ok":true}],
 "calibration":{"baseline_m":0.20,"yaw_offset_deg":0.0,"camera_fov_deg":62.0,
 "audio_delay_ms":18.0}}

{"type":"timeline","t":20.0,"events":[ /* last N sound_event/speech objects */ ]}
```

`urgency` ∈ `low | normal | high | urgent` (alarm/siren/smoke → `urgent`). The HUD must let `urgent`
displace anything else on screen — SoundWatch found overload to be the top failure mode.

### 4.6 frontend → backend: control, same socket

```json
{"type":"set_mode","mode":"all|important|quiet"}   // importance filtering, default "important"
{"type":"ping","t":1.0}
```

### 4.7 Config file `config/array.json` (single source of truth for geometry)

```json
{"rate_hz":16000,"baseline_m":0.20,"layout":"square",
 "mics":[{"id":0,"bus":0,"lr":"L","x":-0.10,"y":-0.10},
         {"id":1,"bus":0,"lr":"R","x": 0.10,"y":-0.10},
         {"id":2,"bus":1,"lr":"L","x": 0.10,"y": 0.10},
         {"id":3,"bus":1,"lr":"R","x":-0.10,"y": 0.10}],
 "inter_bus_offset_samples":[0,0,0,0],
 "yaw_offset_deg":0.0,"camera_fov_deg":62.0}
```

---

## 5. Repo layout and ownership

| Path | Owner | Notes |
|---|---|---|
| `esp32/` | **Member A** | PlatformIO project; firmware + wiring notes |
| `server/` | **Member B** | Python: ingest, DOA, models, fusion, WS |
| `web/` | **Member C** | Vite + TS: camera, HUD, bubbles |
| `config/` | shared — **A owns edits** | `array.json`, `calib.json` |
| `docs/` | **Member D / integration** | calibration log, write-up, video script |
| `models/` | B | gitignored; fetch with §8.2 |
| `tools/` | shared | throwaway spikes, angle plots |

Rules for everyone (and for agents):
- Touch only your globs. Never reformat or "improve" another owner's files.
- Interfaces in §4 are the contract; a change requires editing §4 in the same commit.
- No file in `models/` is committed (see `.gitignore`).
- `main` stays runnable: your branch must not break another stream's entry point.

---

## 6. Workstream briefs (paste these into your coding agent)

> Directory scaffolding (`esp32/`, `server/`, `web/`, `tools/`, `docs/`, `config/`) is empty. Every script,
> module and command named in the briefs below (e.g. `tools/udp_sniff.py`, `python -m server.selftest`) **does
> not exist yet — writing it is part of the deliverable**. Don't go looking for it.

### 6.1 Agent brief — ESP32 / hardware

> You are working in `~/hackgt-26` during a 36-hour hackathon. Read `README.md` §4 and §7 first; they are
> the frozen contract. You own `esp32/**` and `config/array.json`. You must not modify `server/**`, `web/**`,
> or the interface shapes in §4.
>
> **Deliverable:** `esp32/` PlatformIO firmware for ESP32-S3 that (1) captures 4× INMP441 mics on two I2S
> buses at 16 kHz mono per channel, (2) emits the binary packet of §4.2 over UDP to the laptop at 50 Hz per
> channel, (3) emits telemetry per §4.3 at 2 Hz, (4) accepts commands per §4.4 (servo pan, LED ring, home),
> (5) reads PIR + HC-SR04 into telemetry.
>
> **Acceptance (verifiable, in order):**
> 1. `python3 tools/udp_sniff.py` shows packets with `magic=0xA14D`, `seq` gaps < 0.1 %, 4 channels of sane
>    magnitude (silence ≈ ±10 LSB, talking ≈ ±2000+ LSB).
> 2. **Clap test:** record the 4 channels, plot 20 ms around the onset. All four must show the clap, and the
>    inter-channel delays must **flip sign** when the clapper moves from the user's left to their right.
>    If the sign doesn't flip, the array geometry or the L/R wiring is wrong — fix it before anything else.
> 3. Servo reaches 0°, ±90°, ±150° commanded from the backend within 1 s; ring lights the commanded bearing.
>
> **Known traps (each has cost a previous team hours):**
> - **INMP441 data is 24-bit left-justified inside a 32-bit I2S slot.** You must shift before scaling
>   (`>> 8` for 24-bit, then scale to int16). HearLink hit exactly this; verify with the magnitude test above.
> - Mics on the **same** I2S bus share BCLK/WS and are selected by the `L/R` pin. Two buses ⇒ one-time
>   inter-bus offset calibration (`config/array.json:inter_bus_offset_samples`) via a handclap at 0°.
> - **Never let the mic bus and the servo share a supply rail.** Servo transients on the 3V3 rail produce
>   audible clicks in the capture and phantom detections. Separate 5 V, common ground.
> - HC-SR04 `ECHO` is 5 V and the HC-SR501 PIR prefers 5 V: level-shift both, or you kill the S3.
> - WiFi: use a fixed channel, disable power save (`esp_wifi_set_ps(WIFI_PS_NONE)`), and prefer UDP over TCP.

### 6.2 Agent brief — backend, DSP and models

> You are working in `~/hackgt-26` during a 36-hour hackathon. Read `README.md` §3, §4 and §8 first; §4 is
> frozen. You own `server/**`, `models/**`, `tools/`. You must not modify `esp32/**`, `web/**`, or §4.
>
> **Deliverable:** a Python service that ingests UDP audio (§4.2), runs direction-of-arrival estimation and
> classification, fuses them into the event stream of §4.5, and serves it at `ws://127.0.0.1:8000/ws`.
> Components: `server/ingest.py` (UDP → per-channel ring buffers), `server/doa.py` (GCC-PHAT + SRP-PHAT),
> `server/classify.py` (YAMNet), `server/asr.py` (faster-whisper + name spotter), `server/fuse.py`,
> `server/main.py` (FastAPI/websockets).
>
> **A verified YAMNet runner already exists at `~/yamnet/`** — `yamnet_live.py` classifies at 2.4–2.9 ms per
> 0.975 s window on this laptop, with the TFLite model and the class map. Reuse its `classify()` and copy the
> model + CSV into `models/`; do not re-derive the loading code.
>
> **Acceptance:**
> 1. `python -m server.selftest` feeds synthetic multichannel audio containing a source at a known angle,
>    and recovers it within ±8° (azimuth). Report the error for −60°, −30°, 0°, +30°, +60°.
> 2. Classification on files: `sine.wav` → `Sine wave`, white noise → `Static`/`Noise`, a real recording of
>    someone talking → `Speech` > 0.7. (All three verified in `~/yamnet`.)
> 3. `websocat ws://127.0.0.1:8000/ws` shows a `sound_event` within 1.5 s of an actual clap, with the correct
>    sign for left/right.
> 4. A `speech` message appears within 2 s of a spoken sentence, with text that matches what was said.
>
> **Traps:** band-limit TDOA to 300–6000 Hz and use SRP-PHAT, not plain cross-correlation, or Klaus's
> reverberation will give you 40° errors. Report `accuracy_deg` from the actual spread, not from theory.
> An array in a room has a front/back ambiguity by construction — the HUD must be told which half-space is
> valid (the camera usually resolves it); don't silently pick one.

### 6.3 Agent brief — frontend HUD

> You are working in `~/hackgt-26` during a 36-hour hackathon. Read `README.md` §3, §4.5, §4.6, §7.3 first.
> You own `web/**`. You must not modify `server/**`, `esp32/**`, or §4.
>
> **Deliverable:** a Vite + TypeScript app that (1) opens the camera with `getUserMedia`, (2) connects to
> `ws://127.0.0.1:8000/ws`, (3) draws a game-HUD overlay: a bearing compass at the bottom, direction markers
> at each sound event, a label with class + confidence + distance/urgency, (4) for `speech` events
> transcribes are drawn as **bubbles anchored to the face that produced them**, and (5) dims/floats markers
> by `accuracy_deg` and `urgency` so the screen never becomes noise.
>
> **Camera ↔ bearing mapping (implement exactly this):**
> ```ts
> // 0° = camera optical axis. Pinhole: x_ndc = tan(bearing - yaw_offset) / tan(fov/2)
> const x = 0.5 * (1 + Math.tan(toRad(bearing - calib.yaw_offset_deg)) / Math.tan(toRad(calib.camera_fov_deg / 2)));
> const px = x * canvas.width;
> ```
> Config comes from `array_status.calibration` (§4.5). Faces come from MediaPipe Tasks Vision
> (`FaceLandmarker`) — use it for both the face box and mouth-open state; the mouth signal is what
> distinguishes a person from a loudspeaker playing speech, which is a required demo beat.
>
> **Acceptance:**
> 1. With a phone/laptop playing a clap at −40°, 0°, +40°, the marker lands under the matching real-world
>    position (±10 % of frame width) in the camera view.
> 2. Speaking produces a bubble whose anchor sits on the speaker's face; a loudspeaker playing speech
>    produces a marker **without** a face anchor and is labelled as playback.
> 3. Overlay holds 60 fps with the camera running; added latency < 50 ms (emit `t` in the message, compare
>    with `performance.now()`).
> 4. `set_mode: "important"` suppresses low-urgency events; `"quiet"` shows nothing below `high`.
>
> **Traps:** `getUserMedia` and WebXR require a secure context — use `localhost` or a self-signed HTTPS
> origin; **iOS Safari has no WebXR** (Android Chrome or desktop is fine). Don't position markers by absolute
> time; interpolate, because events arrive at 2–4 Hz and jump.

### 6.4 Integration owner (member D)

Owns `docs/`, the calibration log, the Devpost write-up, the 2-minute video, and the final merge. Runs the
end-to-end acceptance test in §7.4 at 04:00 Sunday and freezes the repo at 05:00.

---

## 7. Calibration procedures (do these once, write the numbers into `config/calib.json`)

1. **Baseline.** Measure the actual mic-to-mic distance with calipers; set `baseline_m`. Do not trust the CAD.
2. **Inter-bus offset.** Clap directly in front (0°). Cross-correlate bus 0 against bus 1; write the sample
   offset into `inter_bus_offset_samples`.
3. **Yaw offset.** Put a clap/phone at the camera's optical axis. Backend should report ≈0°; if it reports
   `θ`, set `yaw_offset_deg = θ`.
4. **Accuracy curve.** Claps at −90…+90 in 15° steps, 5 trials each. Plot measured vs actual; record mean
   absolute error and the 1-sigma spread per bin. **These numbers go in the write-up** — they are our delta.
5. **Audio/vision offset.** Clap while the camera sees the hands; measure the video-vs-audio timestamp skew;
   record as `audio_delay_ms`.

---

## 8. Environment (this laptop: NixOS, Python 3.13, Ryzen 7 PRO 5850U)

### 8.1 Already done and verified

- `~/yamnet/` holds a working YAMNet runner: `./yamnet-live` (live mic, TUI), `./yamnet-live -f x.wav`,
  `--jsonl` for machine-readable output. Model + class map included (4.1 MB, 521 AudioSet classes).
- Verified today: 440 Hz sine → `Sine wave 89 %`; pink noise → `Pink noise`; live speech → `Speech 88–92 %`;
  inference **2.4–2.9 ms per 0.975 s window**.
- NixOS quirk: the PyPI wheels need `libstdc++.so.6` and `libz.so.1`, which are not on the default loader
  path. `~/yamnet/yamnet-live` exports both — copy that pattern if you build your own venv.

### 8.2 Fetching the model (gitignored)

```bash
mkdir -p models
curl -L -o models/yamnet.tflite \
  "https://tfhub.dev/google/lite-model/yamnet/classification/tflite/1?lite-format=tflite"
curl -L -o models/yamnet_class_map.csv \
  "https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv"
```

### 8.3 Quick environment

```bash
uv venv .venv && . .venv/bin/activate
uv pip install numpy scipy ai-edge-litert soundfile faster-whisper fastapi uvicorn websockets
```

Camera capture for the backend-side tests uses `ffmpeg` (already installed) — the browser owns the camera
for the HUD; the backend never needs it.

---

## 9. Timeline (remaining)

| Time | A — ESP32 | B — backend | C — frontend | D — integration |
|---|---|---|---|---|
| now → 04:00 | 4-ch I2S capture, packetizing, UDP out | ingest + ring buffer + GCC-PHAT stub | camera + WS client + compass HUD | contract check, calibration rig |
| 04:00–09:00 | sleep shift | sleep shift | sleep shift | sleep shift |
| 09:00–12:00 | clap sign-flip test, telemetry, servo | SRP-PHAT + YAMNet wired to live audio | markers from live events | angle-calibration rig |
| 12:00–15:00 | servo aim command path, ring | fuse events + Whisper | face detection + bubble anchoring | run accuracy curve (§7.4) |
| **15:00–21:00** | **Hive window:** print array bracket, pointer, stand | importance filtering | urgency styles, playback-vs-person | video B-roll |
| 21:00–04:00 | pointer + ring integration | end-to-end stability, accuracy report | final HUD polish, fps check | **04:00 full acceptance test** |
| 04:00–05:00 | — | freeze | freeze | **code freeze 05:00**, video + write-up |
| 09:00 | — | — | — | Expo; invite judges to clap from different sides |

---

## 10. Demo script (2 minutes)

1. Judge stands behind-left and claps → HUD marker appears at that bearing, labelled `Clapping 0.9`, ring lights the same direction, physical pointer snaps to it.
2. Judge says the user's name → bubble anchored to their face, transcribed text, bearing tag.
3. A phone plays a speech clip from off-screen → marker appears **with no face anchor**, labelled `playback`.
4. A smoke-alarm test sound from a laptop speaker → `urgent`, displaces everything, pointer + ring pulse.
5. Cut to the pointer alone on the desk, screens off, still tracking.
6. Title card with the accuracy curve from §7.4.

## 11. References

- SoundWatch, ASSETS 2020 (UW) — smartwatch sound classification; overload/filtering findings: https://makeabilitylab.cs.washington.edu/project/soundwatch/
- HoloSound, ASSETS 2020 (UW) — AR HMD speech + sound identification for DHH: https://makeabilitylab.cs.washington.edu/project/holosound/
- HMD sound visualizations, CHI 2015: https://dl.acm.org/doi/abs/10.1145/2702123.2702393
- AR household sounds for DHH, 2023: https://pmc.ncbi.nlm.nih.gov/articles/PMC10490607/
- Prior projects we extend: HearLink (4× INMP441 on 2 I2S buses) https://devpost.com/software/hearlink · echoBelt (1st place, Hackaburg 2026) https://devpost.com/software/echobelt · WhisperMap https://devpost.com/software/whispermap · N1 AR sound-awareness glasses https://devpost.com/software/n1-augmented-relaity-sound-awareness-glasses · Low-latency Sound Disambiguator https://devpost.com/software/low-latency-sound-disambiguator
- YAMNet: https://tfhub.dev/google/lite-model/yamnet/classification/tflite/1

## 12. Traps, ranked by how much time they cost

| Trap | Mitigation |
|---|---|
| INMP441 24-bit-in-32-bit-slot scaling | `>> 8` then scale; validate with the magnitude test |
| Servo noise coupling into the mic bus | separate 5 V rail, common ground, only move the servo between windows |
| Two I2S buses drifting apart | fixed inter-bus offset via clap calibration; verify weekly-drift-free over 30 min |
| Reverberation ruining TDOA | band-limit 300–6000 Hz, SRP-PHAT, report honest `accuracy_deg` |
| Overload: the screen becomes noise | importance filtering + urgency tiers + `set_mode` |
| iOS Safari has no WebXR / camera needs HTTPS | demo on Android Chrome or desktop; tunnel or self-signed cert |
| Expo hall noise → false events | `set_mode: important`, demo vocabulary, manual trigger for the video |
| Four people editing the same interface | §4 is frozen; changes are README edits in the same commit |
