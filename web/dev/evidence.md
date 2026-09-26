# Frontend (member C) — dev evidence log

Owner: C. Append entries; don't rewrite history. Raw evidence only — checklist
ticks go in README §0 with the owner+time protocol.

## 2026-09-26 — phone viewport fix + real horizontal-FOV correction

Per human report on the actual phone: "too zoomed in, can't see the bottom
axis." Two separate bugs:

1. `#app` was sized with plain `height: 100vh`, which mobile Safari/Chrome
   don't shrink when their address bar is showing — added `height: 100dvh`
   (`src/style.css`) plus `env(safe-area-inset-bottom)` padding on
   `#controls`, and pulled `COMPASS_Y_FRAC` in from 0.93 to 0.9 for extra
   clearance from a phone's home-indicator strip.
2. `getUserMedia` requested a fixed landscape-ideal stream
   (1280x720) regardless of device orientation; on a portrait phone,
   `object-fit: cover` then has to scale the video up to fill the height,
   cropping a large chunk off the sides — the actual "zoomed in" look, and
   not just cosmetic: it silently shrinks the real visible FOV below what
   `calib.camera_fov_deg` claims, which would have broken C3's accuracy
   check once real bearings exist. Fixed two ways: (a) request
   `aspectRatio: {ideal: window.innerWidth/innerHeight}` instead of a fixed
   landscape size, so there's less to crop in the first place; (b) added
   `effectiveFovDeg()` (`src/calib.ts`), which derives the actual visible
   horizontal FOV from the real relationship between `video.videoWidth`/
   `videoHeight` and the displayed canvas size, and is now what's actually
   fed into the bearing math (`main.ts`'s per-frame `renderCalib`) instead
   of the raw backend-reported value. This protects C3 regardless of how
   good the aspect-ratio negotiation turns out to be on any given
   phone/browser.

Verified: hand-computed cases in Node (landscape video in a portrait
canvas → FOV correctly crushed from 62° to ~19°; matching aspect → ~62°
unchanged; laptop/landscape canvas → exactly 62°, no video yet → 62°
unchanged) all matched expectations. Also confirmed in the Browser pane at
a 375x812 mobile viewport that the compass bar and mode buttons now stay
fully on-screen (no camera in that sandboxed pane, so the FOV-crop part
specifically still needs a real-phone re-check — flagged back to the
human).

## 2026-09-26 — direction-aware speech bubbles (tailed, three anchor styles)

Per human feedback after live-testing on phone: speech bubbles now always
appear near wherever the sound actually is, not just on an already-visible
face. `drawSpeechBubble` (`src/render.ts`) picks one of three targets/styles:
**anchored** (real face in frame — tail points at the mouth, ~85% down the
face box), **maybePlayback** (bearing is on-screen but no face matched —
dashed reddish bubble, the actual person-vs-playback case from README §6.3
C6), and **directional** (bearing is off-FOV — neutral bubble docked next to
that event's edge arrow, no "playback" label since being off-screen implies
nothing about what's making the sound). All three are translucent
rounded-rects with a small triangular tail pointing at the target, replacing
the old plain box. Verified all three visually against the mock stream,
including temporarily forcing the "playback" mock event off-FOV to exercise
the directional path (reverted before committing — `git diff` confirmed
clean). As the camera pans and a bearing crosses from off-FOV → on-FOV →
face-matched, the bubble should visibly hand off between these three without
extra state (each frame just recomputes from current bearing + current face
detections) — full pan-across verification still needs a real speaker and a
turning camera, which needs the real backend to be meaningful (mock bearings
don't move on their own).

## 2026-09-26 — real camera + face detection, live over Tailscale

Tested via a phone browser over a Tailscale HTTPS tunnel to the dev laptop
(`vite.config.ts` proxies `/ws` and allows `.ts.net` hosts; `ws-client.ts`
defaults to same-origin `ws`/`wss` instead of hardcoded `127.0.0.1`).
Confirmed live: camera opens, MediaPipe face box tracks a real face, WS
connects through the tunnel (`ws: open  rtt 11ms`). Real evidence toward
**C1**. Clapping in front of the camera doesn't move any marker yet — expected,
since there's no real backend/DOA yet; the mock stream's bearings are scripted,
not derived from audio, so **C3** genuinely needs `server/doa.py` before it can
be evidenced (not a frontend bug).

## 2026-09-26 — design pass: pixel font, arrow markers, contrast fix

Per human request after seeing it live: switched all HUD text to Pixelify Sans
(Google Fonts; visually close to Minecraft's font, applied via CSS `@font-face`
link + `ctx.font`) instead of plain monospace/sans-serif. Replaced the
circle-marker + separate-chevron pair with one shared arrow glyph
(`drawArrow` in `src/render.ts`) used for both in-frame markers (pointing down
at the bearing) and off-FOV edges (pointing left/right) — matches the
reference "Minecraft sound mod" `<`/`>` convention. `ambiguous:true`
candidates now render as a hollow arrow + dashed ring instead of a dashed
stroke on a filled circle. Every label (markers, compass ticks, debug panel,
speech bubbles) now draws with a black outline behind the fill
(`outlinedText` helper) so text stays legible over any video background
regardless of hue; also bumped the "normal" urgency color from `#4fd1ff`
(reported as too pale to catch) to a more saturated `#1fd8ff`.

## 2026-09-26 — initial scaffold + mock stream (C2)

**Command:**

```bash
node web/dev/mock-ws.mjs      # terminal 1 — mock backend on ws://127.0.0.1:8000/ws
cd web && npm run dev          # terminal 2 — open the printed localhost URL
```

**What was built:** Vite vanilla-ts app (`web/src/`) — WS client with
reconnect/backoff and `?ws=` override, canvas HUD overlay (bearing markers,
edge chevrons, bottom compass strip, speech bubbles, urgency styling +
"urgent displaces everything", debug panel), and MediaPipe FaceLandmarker
wiring for face box + mouth-open detection.

**Evidence (screenshots taken against `web/dev/mock-ws.mjs`'s scripted
stream, in Claude's own sandboxed browser pane — camera blocked there, see
caveat below):**

- Clapping at −40°: rendered as a left-edge chevron (`|-40| > fov/2 = 31°`),
  never clamped onto the visible frame. Confirms the off-FOV rule.
- Speech at +10°: rendered as an in-frame marker + bubble. Confirms the
  bearing→screen-x mapping for an in-FOV angle.
- "Playback" speech at −25°: rendered with a dashed red bubble and a
  "no face — playback?" label, because no face was nearby. This is the
  intended P1 behavior (README §6.3 C6) but **only evidences the no-face
  fallback path**, not real person-vs-playback discrimination — see caveat.
- Ambiguous `Dog` at −100° (`ambiguous:true`): code renders both
  `bearing_deg` and `mirrorBearing(bearing_deg)` (180°−θ, see
  `src/calib.ts`) as two independent markers/compass-ticks. Not caught in a
  screenshot window (short-lived in the mock loop) but the render path is
  identical to the already-verified single-marker path, just called twice.
- Urgent `Alarm` at +120°: pulsing red frame border, right-edge chevron,
  and all non-urgent markers/bubbles hidden — confirms "urgent displaces
  everything" (README §4.5).
- Killing/restarting `mock-ws.mjs` correctly flips the "no backend —
  retrying" banner and reconnects with backoff once the server is back.
- `set_mode` buttons (all/important/quiet): clicking "quiet" hid the
  `normal`-urgency Speech markers *and* their bubbles (bubble visibility
  now follows its parent event's mode-filtered visibility, not just
  existence — see fix below).

**Bug fixed during this pass:** initial version mixed backing-store pixels
(`canvas.width/height`, already `devicePixelRatio`-scaled) with the
`ctx.setTransform(dpr,...)` transform, double-scaling every draw call.
Fixed by drawing exclusively in CSS-pixel space (`canvas.clientWidth/Height`)
everywhere in `src/render.ts`.

## Caveat: what is NOT yet evidenced (needs the human + a real device)

Claude's own browser pane **blocks camera access** ("Permission denied"),
so none of the following were verified and must not be treated as done:

1. **C1** (camera actually opens) — code requests
   `facingMode: {ideal: "environment"}`; untested on real hardware.
2. **C3** — marker landing accuracy for real claps at −40°/0°/+40°. This
   needs the human to clap and report where the marker landed.
3. **C5/C6** — real face detection, bubble anchoring to an actual speaking
   face, and true person-vs-playback discrimination (a real loudspeaker
   playing speech vs. a real person talking). The mock only proves the
   "no face found nearby" fallback renders correctly, not the matching
   logic against live MediaPipe output.
4. **C8** — 60fps + <50ms added latency on a real camera feed. The debug
   panel reports two numbers: `fps` (raf loop rate) and `added latency`
   (canvas-draw-only time, currently sub-millisecond because there's no
   video decode/compositing cost in the mock — real numbers will be
   higher). See open question below on what "added latency" should mean.

## Open questions for D / A (not unilateral changes — README §4 untouched)

- **Front/back mirror formula for `ambiguous:true`.** README §4 doesn't
  specify how to compute the mirrored candidate. Implemented as
  `mirror = sign(bearing)*180 - bearing` (reflection across the
  interaural/left-right axis) in `src/calib.ts::mirrorBearing`. Please
  confirm this matches what `server/doa.py` actually reports, or tell me
  the right formula.
- **What "added latency < 50ms" (C8) should measure.** Right now the debug
  panel shows canvas-draw time only. Candidates: (a) WS ping→pong RTT
  (already measured, labeled `rtt` in the debug panel), (b) video-frame
  timestamp → canvas-draw-complete time (glass-to-glass, needs
  `requestVideoFrameCallback`), or (c) both. Tell me which one the demo
  script/judges care about and I'll make that the headline number.

## Next steps (human-in-the-loop, see README §6.3 build order)

- Open `http://localhost:5173` in a **real** browser (not this sandboxed
  pane) on the laptop, grant camera permission, and confirm the video
  feed + debug panel render (→ ticks C1).
- Clap at −40°/0°/+40° in front of the laptop camera and report where the
  marker lands (→ C3).
- Talk in front of the camera and confirm a bubble anchors to your face;
  then play a recorded voice clip from a phone/speaker and confirm the
  marker shows *without* a face anchor (→ C5/C6).
