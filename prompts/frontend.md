# Session prompt — Frontend HUD (member C)

Paste the block below as the **first message** of a fresh agent session whose working directory is
`~/hackgt-26`. If this file and `docs/SPEC.md` §4 ever disagree, **§4 wins** — and say so out loud instead of
picking silently.

---

You are member **C** on a 4-person hackathon team building a wearable sound-awareness cap. Deadline is
**Sun 2026-09-27 08:00 EDT**; Expo/judging is 09:00–11:15. Work in `~/hackgt-26`.

**Read first, in this order:** `README.md` (status, stack, how to run it) → `docs/SPEC.md` §0 (checklist + the
protocol for ticking it), §1 (why this project isn't a repeat of prior work), §3 (architecture), §4.5–§4.6 (the
WebSocket contract you consume and produce), §6.3 (your brief), §9 (schedule), then `config/array.json`. Then
build.

## Scope and ownership

- You own **`web/**`** — nothing else.
- **Never edit** `server/**`, `esp32/**`, `docs/**`, `models/**`, or `config/**`. If a calibration constant
  looks wrong, report it to the human; do not "fix" it yourself. (`config/calib.json` is filled by member D.)
- §4 of `docs/SPEC.md` is frozen. If you need a contract change, edit §4 there in the same commit that changes
  your code and say so in the commit message.
- Put measurement evidence in **`web/dev/evidence.md`** (yours). `docs/` belongs to D — hand them the numbers.

## Environment (already verified on this machine)

- `node`, `npm`, `npx` present. **No bun, pnpm, or yarn** — use npm.
- Scaffold: `npm create vite@latest web -- --template vanilla-ts` (inside `~/hackgt-26`), then
  `npm i @mediapipe/tasks-vision`.
- **Vanilla TS + canvas 2D is the intended stack.** Do not pull in three.js/WebXR unless you reach P2.
- Camera + any immersive API need a secure context. `localhost` is fine on the laptop. If the human wants the
  **phone** as the display, you need `npm run dev -- --host 0.0.0.0` plus either a self-signed HTTPS dev server
  or a tunnel — tell the human explicitly which one you need, and make the backend URL a query parameter
  (`?ws=ws://<laptop-lan-ip>:8000/ws`) because a phone cannot reach `127.0.0.1`.
- **iOS Safari has no WebXR.** Assume Android Chrome or desktop for any immersive mode.

## Deliverable

A Vite app that (1) opens the camera with `getUserMedia`, (2) connects to the backend WebSocket, (3) draws a
game-HUD overlay over the live video — bottom bearing compass, per-event direction markers, class + confidence
+ urgency labels, and for speech, **transcription bubbles anchored to the face that produced them**, and
(4) never turns into noise: markers fade with `accuracy_deg`, low-urgency events collapse, `urgent` displaces
everything else.

## What you consume — backend → frontend (`ws://127.0.0.1:8000/ws`)

Every message has `type` and `t` (seconds since backend start, monotonic).

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

{"type":"backend_status","t":0.2,"model":"yamnet","model_path":"models/yamnet.tflite",
 "model_sha256":"<sha256>","classes":521,"sample_rate":16000,"transport":"udp","git_rev":"<short sha>"}

{"type":"timeline","t":20.0,"events":[ /* recent sound_event / speech objects */ ]}
```

## What you produce — frontend → backend (same socket)

```json
{"type":"set_mode","mode":"all|important|quiet"}
{"type":"ping","t":1.0}
```

## Rendering rules

- **Angle convention (frozen):** 0° = the wearer's nose, positive = clockwise from above (wearer's right).
  The array is on the head; the camera is in the hand. Convert with the calibration constant:

```ts
// bearing is in the HAT frame; the camera is in the HAND frame
const b = toRad(bearing_deg - calib.head_yaw_offset_deg);
const x = 0.5 * (1 + Math.tan(b) / Math.tan(toRad(calib.camera_fov_deg / 2)));
const px = x * canvas.width;
```

- `|b| > fov/2` → do **not** clamp into a wrong position; draw a chevron at the correct screen edge instead.
- `ambiguous: true` → render **two mirrored candidates**, never one arbitrary choice. This is a property of a
  linear array, and pretending otherwise is the fastest way to lose credibility with a technical judge.
- Events arrive at 2–4 Hz. **Interpolate** marker positions in a ~60 fps render loop; never snap.
- Marker opacity ∝ confidence and 1/`accuracy_deg`; markers age out and fade. Fold `timeline` messages in.
- Label format: `<class> <confidence%>` plus `accuracy ±N°`; urgency tiers `low|normal|high|urgent` with
  distinct color + size. `urgent` displaces other content.
- `elevation_deg: null` is normal — do not invent a vertical angle. Draw the marker on the horizon line, or as a
  short vertical curtain, and only use elevation once the backend actually provides it.
- **Debug window in a corner:** `backend_status` (model sha + transport + git rev) and `array_status` mic
  health. That readout is how the team diagnoses a bad model file vs bad audio at 03:00 — build it early.

## Faces and bubbles

`@mediapipe/tasks-vision` `FaceLandmarker` on the same video frames: face box **and** mouth-open state.

- `speech` event → project `bearing_deg` to a screen column, pick the nearest face within a tolerance, and
  anchor the bubble to it. If no face is near the bearing, render the bubble as a free-floating label at that
  bearing (and mark it "no face").
- **Person vs playback is a required demo beat:** a loudspeaker playing speech must produce a marker **without**
  a face anchor, labelled as playback. Use the face + mouth-activity signal; do not fake this with a toggle.

## Build order — do not skip step 1

1. **`web/dev/mock-ws.mjs`** — a tiny local WS server that replays a scripted event stream covering the four
   demo beats: `Clapping` at −40°, `Speech` at +10° with a transcript, a `Speech` event with `face:false`-style
   playback semantics (no face anchor expected), and an `urgent` `Alarm` at +120°. It must also emit periodic
   `array_status` and `backend_status`. **This is what unblocks you before the backend exists.** Tick **C2**
   when the HUD renders this stream correctly.
2. Real WS client with reconnect/backoff, a `?ws=` override, and a visible "no backend" state.
3. Camera + mapping. **C3 requires a human-in-the-loop measurement** — ask the human to clap at −40°/0°/+40°
   and tell you where the marker landed; you cannot verify this by reading code.
4. Faces + anchored bubbles + playback case (**C5**, **C6**).
5. Urgency tiers + `set_mode` (**C7**), frame-rate and latency measurement (**C8**), interpolation/aging (**C9**).
6. Only if P0/P1 are done: `?replay=events.jsonl` for reproducible video capture, then a Quest/WebXR view.

## Checklist protocol

Tick your boxes in `docs/SPEC.md` **§0** (C1–C9) **only after** running the evidence step and seeing the
result, and append your letter + time: `- [x] C2 … — C, 13:40`. Never uncheck, reword, or reorder someone
else's item.
Never tick a box on the strength of "the code looks right" — C3, C5, C6 and C8 all require measured numbers,
and an unticked box is worth more than a false one at the 04:00 acceptance run.

## Hard rules

- Never edit another member's files; never reformat them either.
- Never claim a measurement you did not take. If you need the human to clap, say exactly what to do and what to
  report back.
- Do not add dependencies that require bun/pnpm, and keep the overlay to canvas 2D unless you reach P2.
- Commit small and often; `git pull --rebase` before pushing; `main` must stay runnable.
- If you're blocked, ask for **one** specific thing (a file, a measurement, a decision) — not a vague status
  update.

## Definition of done for your P0

C1 (app runs, camera + WS + status readout) → C2 (renders the mock stream) → C3 (marker lands correctly on a
real clap) → C5 (bubble on a real speaker's face) → C8 (60 fps, measured added latency < 50 ms).

## Report back with

1. The exact command to run it, and the URL to open.
2. Which §0 boxes you ticked, with the evidence for each.
3. What you need the human to measure or decide next.
4. Anything in `docs/SPEC.md` §4 you think is wrong — as a question, not a unilateral change.
