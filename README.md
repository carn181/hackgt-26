# hackgt-26 — Wearable Sound-Awareness Cap

A cap with a 4-microphone array that finds **where** a sound came from, identifies **what** it is, and shows
both to a d/Deaf or hard-of-hearing wearer — direction on an LED strip on the brim, and a game-style HUD
overlay (bearing marker, class label, speech bubbles anchored to faces) on a phone/laptop camera view.

**Status: nothing built yet.** Timestamp of this revision: **Sat 2026-09-26 10:35 EDT**.

| Clock | |
|---|---|
| Hacking ends / submission deadline | **Sun 2026-09-27 08:00 EDT** (~21 h from this revision) |
| Expo + judging | Sun 09:00–11:15 |
| Code freeze | **Sun 05:00** (hard) |
| Hive (3D print / laser, PI-supervised) | **today 15:00–21:00 — the only window** |
| Fabrication dependency | **CAD (if any) must exist by 14:30** |

## Hardware on hand

| Part | Notes |
|---|---|
| 1× ESP32-S3 (+ 1× ESP32-C3 spare) | **Use the S3**: 4 mics need **2 I2S buses** (2 channels each). The C3 has one I2S port → 2 mics max. |
| **4× Adafruit ICS-43434 I2S mic breakouts** (PID 6049) | 1.6–3.6 V, 24-bit, bottom-ported, `SEL` pin picks L/R |
| Servo, PIR (HC-SR501), HC-SR04, WS2812 ring/strip, OLED | optional / stretch |
| Fifine lav (single TX) | **not part of the array** — wireless AGC + unknown latency ruin TDOA. Wearable-comparison prop only. |

---

## 1. What we are building and why it isn't the 42nd version of this

The category ("sound awareness for DHH users") is well populated — see §11. Two prior projects explicitly left
our core claim as *future work*:

- **echoAI** (Qualcomm × LiteRT): *"our array consisted of a 1D line of closely spaced microphones… impossible
  to achieve greater than 1D localization."*
- **Low-latency Sound Disambiguator** (UB Hacking 2025): *"3D Spatial Localization: upgrade from 2D to full 3D
  using 3-4 microphone arrays with multilateration."*

One prior project is architecturally close to us: **HearLink** (4× I2S mics on 2 buses + ESP32-S3 + laptop +
YAMNet + beamforming, in a 3D-printed necklace) — but it is a **desk/necklace device**, not head-worn, and it
reports no accuracy numbers.

Our delta, in one sentence for the write-up:

> A **head-worn** array in the frame that actually matters (the wearer's own sense of direction), with measured
> accuracy, front/back resolved by **head rotation and head-shadow spectral cues**, and direction delivered
> through a **screen-free LED strip** so the wearer does not have to look at anything.

Three things we must do and say explicitly:
1. Report **measured** accuracy (claps at known angles, mean error + spread). Not a vibe.
2. Cite the prior art by name and state what we extend. Judges who know SoundWatch/HoloSound will check.
3. Ship the **screen-free direction output**. It is the part nobody has built, and it is what makes this a
   wearable rather than a laptop demo.

---

## 2. Constraints

| Constraint | Value |
|---|---|
| Submission rule | **One track only**; unlimited sponsor challenges |
| Track candidates (best fit first) | **Shipyard (Hardware)** — a wearable is squarely "smart devices", 1st prize = Meta Ray-Bans per member · **Social Good (Aramco)** — accessibility framing, likely least crowded · **Lighthouse (Immersive)** — only if the HUD is the hero |
| Free sponsor stacks | Notability (2 screenshots), Create-X (interest flag), SpaceXAI (build in Cursor / Grok Voice) |
| Unreachable from this project | Visa ($5k), Impiricus ($3k), Meta — wrong domains |
| Real work left | ~21 h wall, realistically ~15 h after food/sleep. **Scope accordingly (§9 ladder).** |

---

## 3. Architecture

```
   ┌──────────────────────── HAT ────────────────────────┐
   │  4× ICS-43434  (straight bar, 80 mm spacing)        │
   │    bus 0: mic0 (SEL=GND, L)  mic1 (SEL=3V3, R)      │
   │    bus 1: mic2 (SEL=GND, L)  mic3 (SEL=3V3, R)      │
   │  ESP32-S3 (crown, back)  WS2812 strip on brim       │
   └───────────┬─────────────────────────────┬───────────┘
               │ UDP :7000 PCM  (+USB-CDC     │ UDP :7001 telemetry
               │  fallback, same format)      │ ← :7002 aim/led commands
               ▼                              ▼
      ┌──────────────────────────────────────────────────┐
      │  backend (laptop)                                │
      │  ingest → ringbuf → GCC-PHAT/SRP-PHAT → bearing   │
      │  YAMNet → class   faster-whisper → text           │
      │  fusion → event stream                            │
      └──────────────────────┬───────────────────────────┘
                             │ WebSocket :8000/ws
                             ▼
      ┌──────────────────────────────────────────────────┐
      │  web (phone or laptop browser)                   │
      │  getUserMedia camera + MediaPipe faces           │
      │  HUD: bearing compass, markers, speech bubbles   │
      └──────────────────────────────────────────────────┘
```

### Latency budget (target ≤ 1.5 s)

| Stage | Budget | Measured |
|---|---|---|
| TDOA window / YAMNet window | 0.15 s / 0.975 s | — |
| Decision cadence (hop) | 0.25 s | — |
| YAMNet inference | < 50 ms | **2.4–2.9 ms** (verified on this laptop) |
| Whisper (2–4 s utterance) | 0.3–0.8 s | — |
| WS + render | < 50 ms | — |

### Frame of reference (read this twice)

Bearing is measured **in the hat frame** (0° = the wearer's nose). The camera is **in the hand/phone frame**.
Those differ. Three ways to handle it, in order of robustness:

1. **LED strip on the brim** — head-locked by construction, no alignment problem, no screen. **This is P0.**
2. **Phone held in front of the face** — one calibration constant (`head_yaw_offset_deg`) absorbs the
   difference; good to ~±15°. Fine for the demo, state the caveat honestly.
3. **Head-mounted display** (Quest passthrough, if one is at the hackathon hardware desk) — camera is
   head-locked by definition, `yaw_offset = 0`. P2, only if everything else is done.

---

## 4. Frozen interfaces

**Do not change these unilaterally.** If a change is required, edit this section in the same commit that changes
the code and say so in the commit message — a teammate may be mid-flight against the old shape.

### 4.1 Angle convention

- `bearing_deg`: **0° = straight ahead of the hat** (the wearer's nose). Positive = clockwise viewed from
  above = toward the wearer's right. Range `-180 … +180`.
- `elevation_deg`: `+` up; `null` until a vertical baseline exists (crown mic — P2).
- `accuracy_deg`: estimated 1-sigma error, **mandatory**. The HUD fades markers with it.
- Front/back ambiguity is a property of a linear array. It is resolved by (a) head rotation, (b) HF/LF energy
  ratio from head shadow, or (c) the camera. Never silently pick a half-space: report `bearing_deg` **and**
  the ambiguity flag.

### 4.2 Hat → backend: audio, UDP `:7000` (identical framing over USB-CDC)

Little-endian, one packet = one block for all channels:

```
offset  type    field
0       u16     magic     0xA14D
2       u8      version   1
3       u8      nch       channels (4)
4       u32     seq       packet counter, wraps
8       u64     t_us      ESP32 monotonic microseconds at first sample
16      u16     nsamp     samples per channel (320 = 20 ms)
18      i16[]   samples   channel-major, nch × nsamp, int16 (top 16 bits of the 24-bit mic word)
```

- 16 000 Hz, 320-sample blocks ⇒ 50 packets/s/ch ⇒ ~1.0 Mbit/s at 4 ch.
- No retransmission. `seq` gaps are measured, not hidden.
- **Transport is swappable by design:** the same packets go over WiFi UDP or USB serial. At Expo, in a hall
  with a thousand 2.4 GHz devices, **use USB**.

### 4.3 Hat → backend: telemetry, UDP `:7001` (2 Hz, JSON)

```json
{"type":"telemetry","t_us":123456789,"rssi":-52,"dropped":3,"pir":true,"sonar_cm":214,
 "battery_v":3.9,"cpu_c":41.2,"fw":"0.3","transport":"udp"}
```

### 4.4 backend → hat: commands, UDP `:7002` (JSON)

```json
{"type":"led","mode":"direction","deg":-37.5,"hue":210,"urgency":"normal"}
{"type":"led","mode":"off"}
{"type":"scan","from":-150,"to":150,"speed":90}
{"type":"aim","deg":-37.5}
```

### 4.5 backend → frontend: WebSocket `ws://127.0.0.1:8000/ws`

Every message carries `type` and `t` (seconds since backend start, monotonic).

```json
{"type":"sound_event","id":"e17","t":12.34,"class":"Speech","confidence":0.91,
 "bearing_deg":-37.5,"elevation_deg":null,"accuracy_deg":12,"ambiguous":true,
 "urgency":"normal","source":"array"}

{"type":"speech","id":"s3","t":12.9,"parent_event":"e17","bearing_deg":-35.0,
 "text":"did you see that","partial":false,"confidence":0.78,"lang":"en"}

{"type":"presence","t":12.9,"human":true,"source":"pir"}

{"type":"array_status","t":13.0,"mics":[{"id":0,"ok":true},{"id":1,"ok":true},
 {"id":2,"ok":false},{"id":3,"ok":true}],
 "calibration":{"baseline_m":0.24,"spacing_m":0.08,"head_yaw_offset_deg":0.0,
 "camera_fov_deg":62.0,"audio_delay_ms":18.0},"transport":"udp"}

{"type":"timeline","t":20.0,"events":[ /* recent sound_event / speech objects */ ]}
```

`urgency` ∈ `low | normal | high | urgent`; alarm/siren/smoke → `urgent`, and the HUD must let it displace
everything else (SoundWatch's top finding: **overload is the failure mode**).

### 4.6 frontend → backend: control, same socket

```json
{"type":"set_mode","mode":"all|important|quiet"}
{"type":"ping","t":1.0}
```

### 4.7 `config/array.json` — geometry single source of truth

Straight bar on the brim. Spacing 80 mm ⇒ total baseline 240 mm. Aliasing limit $c/2d$ = **2.1 kHz**
(better than a 200 mm desk array's 857 Hz); finer spacing costs delay resolution, so don't go below ~60 mm.

```json
{"rate_hz":16000,"layout":"line","spacing_m":0.08,"baseline_m":0.24,
 "mics":[{"id":0,"bus":0,"lr":"L","x":-0.12,"y":0.0,"z":0.0},
         {"id":1,"bus":0,"lr":"R","x":-0.04,"y":0.0,"z":0.0},
         {"id":2,"bus":1,"lr":"L","x": 0.04,"y":0.0,"z":0.0},
         {"id":3,"bus":1,"lr":"R","x": 0.12,"y":0.0,"z":0.0}],
 "inter_bus_offset_samples":[0,0,0,0],
 "head_yaw_offset_deg":0.0,"camera_fov_deg":62.0,"front_half_is":"nose"}
```

---

## 5. Repo layout and ownership

| Path | Owner | Contents |
|---|---|---|
| `esp32/` | **A** | PlatformIO firmware; wiring map; `esp32/HAT.md` build notes |
| `server/` | **B** | UDP/USB ingest, DOA, YAMNet, Whisper, fusion, WS |
| `web/` | **C** | Vite + TS: camera, HUD, bubbles |
| `config/` | **A** owns edits | `array.json`, `calib.json` |
| `docs/` | **D** | calibration log, accuracy curve, write-up, video script |
| `tools/` | shared | `udp_sniff.py`, angle plots, throwaway spikes |
| `models/` | B | gitignored; fetch per §8.2 |

Rules for everyone and their agents: touch only your globs; never reformat another owner's files; §4 changes
require a README edit in the same commit; `main` must stay runnable.

---

## 6. Workstream briefs (paste these into your coding agent)

> Scaffolding dirs are empty. Every script or module named below **does not exist yet — writing it is the
> deliverable**. Don't go looking for it.

### 6.1 Agent brief — ESP32 / hardware (member A)

> You are in `~/hackgt-26` during a 36-hour hackathon; ~20 h remain. Read §1, §3, §4, §7.1 of `README.md`
> first — §4 is frozen. You own `esp32/**` and `config/array.json`. Do not touch `server/**`, `web/**`, `models/**`.
>
> **Deliverable:** PlatformIO firmware for **ESP32-S3** that
> 1. captures **4× ICS-43434** as two stereo pairs: bus 0 = mics 0/1, bus 1 = mics 2/3, 16 kHz, 32-bit slots;
> 2. emits the §4.2 packets over **UDP** *and* over **USB-CDC serial** (same bytes, `--transport` build flag) —
>    the USB path is the Expo insurance policy;
> 3. emits §4.3 telemetry at 2 Hz; accepts §4.4 LED/scan commands;
> 4. drives the WS2812 strip so the lit position/hue equals the commanded bearing.
>
> **ICS-43434 specifics (do not re-derive):**
> - Pins: `3V` (1.6–3.6 V), `GND`, `BCLK`, `DOUT`, `LRCLK`, `SEL`. **3.3 V logic only — never 5 V.**
> - `LRCLK` low = left channel transmits, high = right. `SEL` low = left, `SEL` high = right.
> - The mic packs **24-bit signed samples left-justified in each 32-bit slot**, so the **top 16 bits of each
>   32-bit slot are already a signed int16** → configure 32-bit slots and `>> 16` (arithmetic) per sample.
>   Get this wrong and you get either silence or a −6 dB/octave mess that looks like "bad mics".
> - `BCLK` 2–4 MHz nominal: `2 ch × 32 bit × 16 kHz = 1.02 MHz` for one bus — slower than nominal but reliably fine.
> - Both mics on a bus **share BCLK/LRCLK/DOUT**; wire `SEL` to GND on one, 3V3 on the other. Five wires per bus total.
>
> **Acceptance, in order:**
> 1. **One bus first.** With only mics 0/1 wired, print per-channel RMS at 10 Hz: silence ≈ tens of LSB,
>    speech in a quiet room ≈ hundreds-to-thousands. Both channels must show signal.
> 2. `python3 tools/udp_sniff.py` (written by B) shows `magic=0xA14D`, `nch=4`, `seq` gaps < 0.1 %.
> 3. **Clap sign-flip test — the make-or-break test.** Clap left of the wearer, then right. The measured
>    inter-channel delays must **flip sign**. If they don't: geometry, `SEL` wiring, or `>> 16` is wrong.
>    Do not proceed to integration until this passes.
> 4. Strip lights the commanded bearing within one frame; serial transport streams at full rate.
>
> **Traps:** never power the array from the same rail as a servo (transients are audible and produce phantom
> detections); mount the bar so the **bottom ports face away from the head** (these are bottom-ported parts —
> the acoustic hole is under the PCB, on the side away from the solder pads); keep the bar ≥5 mm off the fabric
> (fabric+foam comb-filters the HF you need for TDOA); keep the S3's antenna clear of the head, the battery,
> and the brim.

### 6.2 Agent brief — backend, DSP and models (member B)

> Read §3, §4, §8 of `README.md`; §4 is frozen. You own `server/**`, `models/**`, `tools/**`.
>
> **Deliverable:** Python service: `tools/udp_sniff.py` (packet verifier, needed by A today),
> `server/ingest.py` (UDP **and** serial readers → per-channel ring buffers, seq-gap stats),
> `server/doa.py` (GCC-PHAT, then SRP-PHAT over a coarse grid), `server/classify.py` (YAMNet),
> `server/asr.py` (faster-whisper + name spotter), `server/fuse.py`, `server/main.py` (FastAPI + WS on :8000).
>
> **Reuse `~/yamnet/`**: `yamnet_live.py` already classifies at 2.4–2.9 ms per 0.975 s window with the TFLite
> model + class map; copy those two files into `models/` and reuse `classify()`. Do not re-derive loading code.
>
> **Acceptance:**
> 1. `python -m server.selftest`: synthetic multichannel audio with a source at a known angle → recovered
>    within ±8° at −60/−30/0/+30/+60°. Prints the error table.
> 2. On files: `sine.wav` → `Sine wave`; white noise → `Static`/`Noise`; speech → `Speech` > 0.7.
> 3. Live: a clap reaches the WS client as a `sound_event` in < 1.5 s **with the correct left/right sign**.
> 4. A spoken sentence yields a `speech` message with matching text in < 2 s.
>
> **Traps:** band-limit to 300–6000 Hz and use SRP-PHAT — plain cross-correlation fails badly in a reverberant
> room, and reporting 40° errors as 5° loses the prize. Derive `accuracy_deg` from measured spread. Because the
> array is 1-D, emit `ambiguous:true` rather than guessing the half-space.

### 6.3 Agent brief — frontend HUD (member C)

> Read §3, §4.5, §4.6 first. You own `web/**`.
>
> **Deliverable:** Vite + TS app that opens the camera, connects to `ws://127.0.0.1:8000/ws`, and renders a
> game-HUD overlay: bottom bearing compass, per-event direction markers, class + confidence + urgency labels,
> and — for `speech` — **bubbles anchored to the face that produced them**. Markers fade with `accuracy_deg`,
> low-urgency events collapse, `urgent` displaces everything.
>
> **Camera ↔ bearing mapping (hat frame → camera frame):**
> ```ts
> // 0° = hat nose; head_yaw_offset_deg = calibration constant between hat-forward and camera-forward
> const b = toRad(bearing_deg - calib.head_yaw_offset_deg);
> const x = 0.5 * (1 + Math.tan(b) / Math.tan(toRad(calib.camera_fov_deg / 2)));
> const px = x * canvas.width;   // clamp; if |b| > fov/2 draw a chevron at the edge instead
> ```
> Faces: MediaPipe Tasks Vision `FaceLandmarker` — face box **and** mouth-open state; the mouth signal is what
> separates a person from a loudspeaker, which is a required demo beat.
>
> **Acceptance:**
> 1. Claps at −40°/0°/+40° put the marker under the matching real-world position (±10 % frame width).
> 2. Speech → bubble anchored to the speaker's face; a speaker playing speech → marker with **no** face anchor.
> 3. 60 fps overlay, < 50 ms added latency (echo `t` back and compare with `performance.now()`).
> 4. `set_mode:important` suppresses low-urgency; `quiet` shows only `high`+.
>
> **Traps:** camera needs a secure context — `localhost` or a self-signed HTTPS origin; **iOS Safari has no
> WebXR** (Android Chrome/desktop are fine). Interpolate positions — events arrive at 2–4 Hz and will jump.
> `ambiguous:true` events should render as two mirrored candidates, not one arbitrary choice.

### 6.4 Integration owner (member D)

Owns `docs/`, hat assembly, the calibration log, the accuracy curve, the Devpost write-up, the 2-minute video,
and the final merge. Runs the full acceptance test at **04:00 Sunday**, freezes the repo at **05:00**.

---

## 7. Hardware

### 7.1 Hat build (do this before anything aesthetic)

| Concern | Decision |
|---|---|
| Array | **Straight bar, 4 mics, 80 mm spacing (240 mm baseline)**, in front of the brim. A curved arc breaks the linear TDOA formula — keep it straight. |
| Port direction | ICS-43434 is **bottom-ported**: acoustic hole is on the far side from the solder pads. Mount so ports face **away from the head**, bar standing ≥5 mm off the fabric. |
| Mid-build carrier | Strip of perfboard + hot glue. **Do not put the Hive on the critical path** — the printed bar/shell is a P1-P2 nicety, not a dependency. |
| Wiring | 5 wires per bus (BCLK, LRCLK, DOUT, 3V, GND) shared by both mics on that bus; 30 AWG silicone wire; strain-relieve at the board. |
| Power | Small 5 V power bank in the crown at the back; S3 regulator to 3V3 for the mics. Balance the hat, or the brim droops. |
| RF | 2.4 GHz is absorbed by the body and jammed at Expo. Antenna up and outward, and **test the USB tether early**. |
| Wind / fabric | Foam windscreen over the bar; a bare MEMS port against fabric hears only the wearer's scalp and clothing noise. |
| Stretch | 5th mic on the crown for a vertical baseline (elevation). WS2812 strip on the brim is P0 output. |
| Explicitly not | A servo on the head: heavy, noisy (it injects into the mics), and unnecessary once the strip is the display. Keep the servo for a desktop variant only. |

### 7.2 Calibration (write results into `config/calib.json`)

1. **Baseline.** Measure actual mic-to-mic distance; set `spacing_m` / `baseline_m`. Never trust CAD.
2. **Inter-bus offset.** Clap at 0°; cross-correlate bus 0 vs bus 1; store the sample offset.
3. **Head yaw offset.** Point the camera at a source; store `head_yaw_offset_deg = measured_bearing`.
4. **Accuracy curve — this is our delta.** Claps at −90…+90° in 15° steps, 5 trials each: plot measured vs
   actual, record mean absolute error and 1-sigma per bin. Cold-start vs 30-minute-later run (drift check).
5. **Audio/vision offset.** Clap while the camera sees it; record `audio_delay_ms`.

---

## 8. Environment (this laptop: NixOS, Python 3.13, Ryzen 7 PRO 5850U)

### 8.1 Already done and verified

- `~/yamnet/`: working YAMNet runner — `./yamnet-live` (live mic TUI), `-f file.wav`, `--jsonl`.
  Verified: 440 Hz sine → `Sine wave 89 %`; pink noise → `Pink noise`; live speech → `Speech 88–92 %`;
  **2.4–2.9 ms per 0.975 s window**.
- NixOS quirk: PyPI wheels need `libstdc++.so.6` and `libz.so.1`, which are not on the default loader path;
  `~/yamnet/yamnet-live` exports both. Copy that pattern for any new venv.

### 8.2 Model fetch (gitignored)

```bash
mkdir -p models
curl -L -o models/yamnet.tflite \
  "https://tfhub.dev/google/lite-model/yamnet/classification/tflite/1?lite-format=tflite"
curl -L -o models/yamnet_class_map.csv \
  "https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv"
```

### 8.3 Environment

```bash
uv venv .venv && . .venv/bin/activate
uv pip install numpy scipy ai-edge-litert soundfile faster-whisper fastapi uvicorn websockets pyserial
```

---

## 9. Plan from 10:35 Saturday

**Scope ladder — build top-down, cut bottom-up:**

- **P0 (must ship):** hat serves audio → backend computes bearing + YAMNet class → **LED strip shows direction**
  and a browser HUD marker lands in the right place. Accuracy honestly reported (even if ±20°).
- **P1 (should):** 4 mics, real accuracy curve, transcription bubbles anchored to faces, urgency tiers,
  playback-vs-person imagery.
- **P2 (nice):** printed bar/shell, elevation from a crown mic, Quest passthrough view, importance-filter UI.

Cut order when behind: Quest → elevation → printed parts → bubbles (keep transcript as a list) → 4th mic →
3rd mic → LED strip (then you only have the screen HUD).

| Window | A — hat/ESP32 | B — backend | C — frontend | D — integration |
|---|---|---|---|---|
| 10:35–12:00 | **One bus, two mics, RMS printout.** Split off a buyer (hat, perfboard, 30 AWG, power bank, foam, USB-C cable) | venv, `udp_sniff.py`, `server/selftest.py` on synthetic data | Vite app + WS client + compass HUD with **fake events** | contract sanity check, start `docs/calibration.md` |
| 12:00–14:30 | 4 mics on 2 buses, packetizer, UDP out | ingest + GCC-PHAT on live packets | markers from live events | geometry measurement, `array.json` values |
| **14:30** | — | — | — | **CAD deadline** — only if a printed part is in scope |
| 15:00–18:00 | Hat assembly (perfboard bar, wiring, power, RF check), telemetry, strip | SRP-PHAT + YAMNet on real audio, event fusion | camera + face detection | Hive window (print/laser) + B-roll |
| 18:00–21:00 | **Clap sign-flip test**, then calibration | live end-to-end tuning, ambiguous flag | real markers + edge chevrons | run calibration, record first numbers |
| 21:00–01:00 | strip/urgency integration, strain relief, spares | Whisper + name spotter, accuracy sweep | bubbles anchored to faces, playback case | accuracy curve (§7.2.4) |
| 01:00–04:00 | sleep in staggered shifts (two awake) | same | same | draft write-up + video outline |
| **04:00–05:00** | freeze | freeze | freeze | **full acceptance test 04:00, freeze 05:00** |
| 05:00–08:00 | — | — | — | video + Devpost submission |
| 09:00 | — | — | — | Expo: wearer turns their head; judges clap from different sides |

---

## 10. Demo script (2 minutes)

1. Wearer faces the camera; judge claps **left-behind** → brim strip lights left-rear, HUD marker lands there, label `Clapping 0.9`.
2. Judge walks around the wearer; the wearer **turns their head** → the reading follows the head frame, front/back resolves live.
3. Judge says the wearer's name → bubble anchored to the speaker's face with the transcribed text.
4. A phone plays a speech clip from off-screen → marker appears with **no face anchor**, labelled `playback`.
5. Smoke-alarm sound from a laptop → `urgent`, displaces everything, strip pulses.
6. Screens off: **the strip alone still shows direction.** (This is the accessibility shot.)
7. Title card with the §7.2.4 accuracy curve.

## 11. References

- Adafruit ICS-43434 breakout (PID 6049): pins, `SEL`, bottom-ported, 1.6–3.6 V — https://learn.adafruit.com/adafruit-i2s-mems-microphone-breakout/pinouts
- 24-bit left-justified-in-32-bit-slot detail (top 16 bits = int16) — https://learn.adafruit.com/i2s-microphones-with-circuitpython
- SoundWatch, ASSETS 2020 — smartwatch sound classification; **overload/filtering** findings: https://makeabilitylab.cs.washington.edu/project/soundwatch/
- HoloSound, ASSETS 2020 — AR HMD speech + sound ID for DHH: https://makeabilitylab.cs.washington.edu/project/holosound/
- HMD sound visualizations, CHI 2015: https://dl.acm.org/doi/abs/10.1145/2702123.2702393
- Prior projects we extend: **HearLink** (4× I2S mics, 2 buses, S3, necklace) https://devpost.com/software/hearlink · **echoBelt** (1st place, Hackaburg 2026) https://devpost.com/software/echobelt · **WhisperMap** https://devpost.com/software/whispermap · **N1 AR glasses** https://devpost.com/software/n1-augmented-relaity-sound-awareness-glasses · **Low-latency Sound Disambiguator** https://devpost.com/software/low-latency-sound-disambiguator
- YAMNet TFLite: https://tfhub.dev/google/lite-model/yamnet/classification/tflite/1

## 12. Traps, ranked by time cost

| Trap | Mitigation |
|---|---|
| ICS-43434 32-bit slot handling (`>> 16` for int16) | Do it in the first 20 minutes; validate with the RMS test before wiring all 4 mics |
| Bottom-ported mics mounted against fabric | Ports face away from the head; 5 mm standoff; foam windscreen |
| Servo/regulator transients injecting into the mic bus | Separate 5 V rail, common ground, no servo on the head |
| Two I2S buses drifting apart | One-time inter-bus offset via clap; re-check at 30 min (drift test) |
| Only one I2S port available (if the C3 is used) | Use the S3 for 4 mics; with one port, ship **2 mics** — azimuth still works |
| Reverberation wrecking TDOA | 300–6000 Hz band, SRP-PHAT, report honest `accuracy_deg` |
| Expo hall jams 2.4 GHz | **USB-CDC transport is the demo path**; WiFi is the "look, wireless" shot |
| Overload: the HUD becomes noise | Urgency tiers + `set_mode`, both in P1 |
| Camera needs HTTPS; iOS has no WebXR | localhost/self-signed cert; demo on Android Chrome or desktop |
| Four people editing one interface | §4 frozen; contract changes = README edit in the same commit |
