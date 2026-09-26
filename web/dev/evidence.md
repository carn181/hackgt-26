# Frontend HUD — measured evidence (owner C)

All numbers below were observed on this laptop, in a real browser, by driving the app and reading
its own read-only introspection hook. Nothing here is inferred from source.

- Machine: NixOS 26.05, AMD Ryzen 7 PRO 5850U, Chromium 151.0.7922.137 (headless, SwiftShader),
  Node v24.19.0, Vite 8.3.1, `@mediapipe/tasks-vision` 1.0.1
- Backend: `web/dev/mock-ws.mjs` (speaks the frozen §4.5 contract on `127.0.0.1:8000/ws`).
  `server/` is still empty, so **no real backend participated in any measurement below.**

## How to run

```bash
# terminal 1 — mock backend stream
cd web && npm run mock

# terminal 2 — app (port 5173; the mock owns 8000)
cd web && npm run dev -- --host 0.0.0.0
# open http://localhost:5173          (laptop, camera + ws://127.0.0.1:8000/ws)
# or  https://<laptop-lan-ip>:5173    (phone; see the TLS section)
```

Read-only hooks used for every number below (also the manual debugging surface):

```js
window.__hud.snapshot() // per-event x / inFov / alpha / age / caption, captions drawn this frame,
                        // counts (timeline merges, stale, rejected, backend restarts), fps
window.__hud.ws()       // state, url, received, unknownTypes, malformed, latencyMs, latencyMedianMs
window.__hud.vision()   // state, delegate, analyzedFrames, analyzedFps, inferenceMs
```

## C1 — app runs, camera opens, WS connects, `backend_status` rendered ✅

- Real camera: `getUserMedia` on `http://localhost:5173` (secure context) → `cameraStarted: true`,
  `videoWidth×videoHeight = 1280×720`, `readyState 4`, `paused: false`. Device: `/dev/video0`
  "Integrated Camera". Preview is unmirrored (`object-fit: cover`, no transform).
- WS: default on localhost is `ws://127.0.0.1:8000/ws`; status `open`, `received: 163` messages,
  `unknownTypes: 0`, `malformed: 0`.
- Rendered: compact diagnostics row `OPEN · YAMNET · UDP · MOCK · MICS 3/4 ⚠`; expanded panel shows
  model + `model_path` + 521 classes + 16000 Hz, full `model_sha256`, `git_rev`, transport, every
  mic's state (`0:ok 1:ok 2:FAIL 3:ok`), calibration, presence, rolling FPS, latency, face-tracking
  state, mode, event counters, last malformed payload, vision error.
- Cross-checks: camera-failure path renders a visible card with a Retry button (observed when the
  device was busy: "Camera failed: Could not start video source"); no-backend path renders
  `NO BACKEND · 4s/8s` and keeps rendering at 60 fps.
- Phone path (`npm run phone`, added after the first sweep): mkcert is fetched through nix, certs land in
  `web/.certs/` (gitignored) covering `localhost`, `127.0.0.1`, the WiFi IP and the tailscale IP, and Vite
  serves HTTPS on `0.0.0.0:5173` with `--strictPort`. Verified from the laptop against the **real CA chain**
  (no `rejectUnauthorized` shortcut): `wss://10.90.57.35:5173/ws` returned the ping echo and the full
  `backend_status`/`array_status`/`sound_event` stream; a browser on `https://10.90.57.35:5173` reported
  `isSecureContext: true`, auto-resolved socket `wss://10.90.57.35:5173/ws` (`open`, 19 messages, 6 events,
  60 fps, latency 2.1 ms) and `navigator.mediaDevices` present. Only the phone's own CA import is untested.
- Earlier HTTPS/TLS path verified with a self-signed cert
  (`nix shell nixpkgs#openssl -c openssl req -x509 … -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`):
  Vite served `https://127.0.0.1:5174`, page reported `isSecureContext: true`, default socket became
  `wss://127.0.0.1:5174/ws` through the same-origin proxy, state `open`, latency median 2.0 ms.
  A raw `ws://` override from that page is refused with the explicit mixed-content message pointing at
  `wss://<host>/ws`.
- TLS misconfiguration: `TLS_CERT_FILE=/tmp/x.pem npm run dev` exits 1 with
  `configuration error: TLS_CERT_FILE and TLS_KEY_FILE must be set together (or both unset for HTTP dev)`
  — no silent HTTP fallback.
- WSS proxy checked independently of the page: a Node `ws` client to `wss://127.0.0.1:5174/ws`
  received the full stream (`ping` echo, `backend_status`, `array_status`, `sound_event`, `speech`).

## C2 — compass + markers render from fake events, before the backend exists ✅

Mock-only run (no backend process, camera not required):

- Calibration taken from `array_status.calibration` (fov 62°, yaw 0°, spacing 0.08 m, baseline 0.24 m).
- Captions drawn (read from `snapshot().captions`):
  `◀ Clapping 90% · ±12° · NORMAL · AMB`, `▶ Speech 91% · ±10° · NORMAL`,
  `◀ Glass breaking 72% · ±16° · HIGH`, `+2 low`.
- Compass renders at the bottom with the FOV cone, 15° ticks, 45° labels and event ticks.
- Before `array_status` arrives the HUD draws no markers instead of inventing a bearing, and says which link
  is missing — verified in all four connection states (canvas plate + top-left notice):
  `CONNECTING · waiting for the backend` → `NO BACKEND · nothing connected` (nothing ever answered) →
  `FEED LOST · disconnected after N messages` (it talked, then went away) →
  `CALIBRATION PENDING · backend sent no array_status.calibration` (connected, silent about calibration).
  With `npm run mock` running the notice clears ~250 ms after the socket opens and markers appear.
- Capture: 106 samples over 34.5 s, render FPS 59.1–60.0.

## C3 — marker lands within ±10 % frame width for claps at −40°/0°/+40° ⛔ NOT MEASURED

Requires a human clapping at known angles in the hat frame; not available in this session — leaving
the box unticked rather than reporting a number nobody took.

Procedure to close it (needs D + a wearer):

1. `config/calib.json` must hold D's measured `head_yaw_offset_deg` and `camera_fov_deg`
   (still `null` today; the mock falls back to `config/array.json` values).
2. Hold the phone (or cap camera) fixed and pointing forward; clap at −40°, 0°, +40° of the hat frame.
3. For each clap read `window.__hud.snapshot().events[]` → the matching event's `x` (frame-width
   fraction) and `inFov`. Expected: `x = 0.5 · (1 + tan(b)/tan(fov/2))`, `b = bearing − head_yaw_offset_deg`.
4. Pass when `|x_measured − x_expected| ≤ 0.10`.
5. Caveat measured here: with `camera_fov_deg = 62` the half-FOV is 31°, so ±40° is *outside* the
   frame and renders as an edge chevron (`x = −0.198` for −40°). ±40° can only land on screen with a
   wider measured FOV (or the phone aimed at the clapper), so record the FOV used.

## C4 — edge chevrons when |bearing| > fov/2; `ambiguous:true` → two mirrored candidates ✅

From `snapshot()` (fov 62°, yaw 0°):

| event | bearing | inFov | x | mirrored candidate (180° − θ) | mirror x | mirror inFov |
|---|---|---|---|---|---|---|
| Clapping | −40.0° | false | −0.198 (left edge) | −140.0° | 1.198 (right edge) | false |
| Alarm | +120.0° | false | −0.941 | +60.0° | 0.363 | false |
| Speech | +10.0° | true | 0.6467 | 170.0° | 0.353 | false |
| Glass breaking | −15.0° | true | 0.2805 | 195°→−165° | 0.324 | false |

- Out-of-FOV bearings are never clamped into a false on-screen position: they are drawn as chevrons at
  the correct edge and captioned `▶ Alarm 94% · ±18° · URGENT · AMB · right edge of view`.
- Ambiguous events always render both candidates (dashed link between them when both are on screen) —
  the linear array's front/back ambiguity is never resolved by picking a half-space.
- Verified visually (portrait + landscape screenshots) and in the event table above.

## C5 — face landmarks + mouth-open; bubble anchored to the speaking face ✅ (mechanism)

The laptop's physical camera was held by another application during the vision runs, so real camera
frames were fed through the **normal `getUserMedia` path** using Chromium's fake capture device:

```bash
chromium --headless=new --no-sandbox --use-fake-device-for-media-stream \
  --use-fake-ui-for-media-stream --use-file-for-fake-video-capture=/tmp/face.y4m
```

(`/tmp/face.y4m` built with ffmpeg from a face photo; the photo and clip were temporary and are not
committed. Sources: MediaPipe asset `portrait.jpg`, and a Wikimedia Commons image with a wide-open
mouth, both used only to drive the pipeline.)

- Face tracking: `state: ready`, delegate `CPU`, 203–493 analyzed frames at **9.99–10.0 frames/s**,
  **47.7–58 ms** per frame inference, with the canvas render loop concurrently at **59.1–60.0 fps**.
- Open-mouth frame: `jawOpen = 0.43 → mouthActive: true` (gate: `jawOpen > 0.25` on ≥2 of the last 3
  analyzed frames) → the `speech` at +10° (x = 0.647, inside the detected face box) is **anchored**:
  `snapshot().speeches[].anchored === true`, bubble text `SPEAKER · did you see that` drawn above the
  face box with anchor corner marks and a leader line that does not cover the mouth.
- Closed-mouth frame with the same geometry: `jawOpen 0.123–0.239 → mouthActive: false` → **not**
  anchored (see C6).
- Model/assets are local: `/models/face_landmarker.task` (3.76 MB, sha256
  `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`) and `/wasm/*` (copied from the
  installed package by `dev/sync-assets.mjs`, npm `postinstall`). No runtime CDN.
- Still to re-run with a live human speaker at acceptance; the gate threshold (0.25) is a documented
  choice in `src/vision.worker.ts`, not a tuned constant.

## C6 — playback vs person: no face anchor, labelled playback ✅ (mechanism)

Same run as C5, both cases simultaneously:

- Speech at −25° (x = 0.112) with **no face box at that bearing** → bubble free-floating at the
  bearing, label `PLAYBACK · NO FACE`, `anchored: false`.
- Speech at +10° with a **face whose mouth is closed** → free-floating, label `PLAYBACK`,
  `anchored: false` (a face at the bearing is not enough — the mouth activity decides).
- With face tracking unavailable (model/worker cannot load) the bubble is labelled
  `UNANCHORED · NO TRACKING` and the app shows `FACE TRACKING UNAVAILABLE — captions shown unanchored`;
  no face match is ever claimed.
- Not yet exercised: an actual loudspeaker. The HUD's decision uses only the detected face box and the
  blendshape mouth signal, which is what the mock's playback beat drives.

## C7 — urgency tiers, urgent displacement, `set_mode` all/important/quiet ✅

- `all`: LOW/HIGH/NORMAL captions coexist, each carrying its tier word and tier-specific size/colour;
  the two `low` events collapse into a single `+2 low` chip (no per-event low captions).
- `important` (40 samples): no `LOW` caption and no `+2 low` chip appear; higher tiers unaffected.
- `quiet` (60 samples): only `HIGH` and `URGENT` captions — no `LOW`/`NORMAL`, and speech bubbles are
  suppressed (speech is normal urgency).
- Urgent: every sampled frame containing the `urgent` Alarm has captions exclusively containing
  `URGENT` and no speech bubbles (`urgent` displaces everything; compass, connection state,
  diagnostics and controls stay visible).
- Wire: the mock log shows `received set_mode: mode=all|important|quiet` for each control change, and
  re-asserts the current mode once per (re)connect — 2 messages in a 9 s window (a per-message storm
  was found and fixed, see below).

## C8 — 60 fps with camera running; added latency < 50 ms ✅ (conditions below)

- Render: **59.1–60.0 fps** (median 60.0), rolling 5 s window, measured from completed Canvas frames
  while the camera ran and face inference processed 10 frames/s. Portrait 412×892 @ dpr 2 and
  landscape 892×412 both stayed at 60 fps.
- Added latency (prompt's method: send `{"type":"ping","t":performance.now()/1000}`, compare the echo
  with `performance.now()`): WS + render round trip **median 1.2–2.1 ms** over ≥10 samples
  (per-connection: 1.1–1.4 ms). Criterion is < 50 ms.
- Conditions: measured against `web/dev/mock-ws.mjs` on loopback, which echoes the exact `ping` payload.
  B's backend must be measured the same way at the 04:00 run; if it does not echo `t`, this number
  cannot be taken from it (and the frozen contract is not to be changed for it).

## C9 — positions interpolate; markers age and fade ✅

- Moving target: one event id re-sent every 250 ms walking −10° → +10°. Observed marker bearings move
  monotonically and smoothly; the largest step between consecutive 180 ms samples was **≤ 2.5°** with
  no snapping (9 /s exponential smoothing, wrapped shortest-path interpolation so a ±180° crossing
  never sweeps the frame).
- Aging: 6 s lifetime with a fade through the final second; `alpha = clamp(conf·12 / max(acc,1), 0, 1)`
  multiplied by the age fade and floored at 0.18 so a weak detection stays legible. Measured alphas
  decline in the last second, and events disappear at 6 s (the −40° clap was absent from > 40 % of a
  34.5 s capture).
- Timeline folding: snapshots update existing ids in place — `5 merged`, `44 stale ignored`,
  `0 rejected`, no duplicate ids across 106 samples. A timeline entry older than the live copy never
  walks an event backwards.

## Bugs found by these runs and fixed

1. **MediaPipe in a module worker** needed the ESM wasm variant: `FilesetResolver.forVisionTasks(path, true)`.
   The classic variant only exposes `ModuleFactory` as a module-scoped `var`, so MediaPipe threw
   `ModuleFactory not set.`
2. **Vite refuses `/wasm/*` imports from `public/`** (`?import` → 500). `vite.config.ts` serves that
   directory verbatim from a middleware installed ahead of Vite's transform pipeline.
3. **GPU delegate on a software rasterizer** measured **1782 ms/frame** (vs 50–58 ms CPU). The worker now
   probes `WEBGL_debug_renderer_info` before creating the landmarker and takes CPU when the renderer is
   software; a failed init restarts the worker once on CPU (MediaPipe's wasm module can only be
   initialized once per worker).
4. **`set_mode` storm**: the mode was re-sent on *every* WS status update (which fires per received
   message). Now sent only on the transition to `open`, plus on user change.
5. **Backend clock reset**: after a backend restart `t` restarts near 0 while the HUD's high-water clock
   kept advancing, so every new event was culled as ancient. The HUD now detects the backwards jump,
   resyncs, drops the previous run's events, and counts `backendRestarts` (observed: 1, events resumed
   immediately, badge back to `live`).
6. **`cover` cropping**: captions, chevrons and bubbles were clamped to the video *content* rect, which
   extends past the viewport when the video is cropped (portrait video on a landscape screen), so text
   was cut off. All readable chrome is now clamped to the visible intersection; bubbles, captions and
   the `+N` chip share one collision list (captions stack past bubbles instead of overprinting them),
   and the urgent banner shrinks/truncates to fit.

## Still open (needs the human / D)

- **C3**: human claps at −40°/0°/+40° with a measured `camera_fov_deg` (procedure above).
- **C5/C6 live re-run**: real visible speaker and a loudspeaker playing speech.
- **C8 live re-run**: repeat the ping-echo latency measurement against B's backend.
- **Phone run**: `npm run phone` now handles the certificate side (mkcert via nix, auto-regenerated when
  the LAN address changes) and prints the URL plus the CA-import steps; everything except importing
  `rootCA.pem` on the phone itself is verified over HTTPS on the laptop LAN origin.
