# Frontend (member C) — dev evidence log

Owner: C. Append entries; don't rewrite history. Raw evidence only — checklist
ticks go in `docs/SPEC.md` §0 with the owner+time protocol.

## 2026-09-26 — body-detection fallback + camera resolution/focus, on reeves-body-detection

Two problems from live testing at range (~1.5m+): a face too small/far for
FaceLandmarker to resolve fell all the way through to an unanchored,
center-defaulted speech bubble even though a real person was visible and
talking; and the camera image itself looked soft at that same distance.

**Body fallback**: `@mediapipe/tasks-vision` already ships `PoseLandmarker`
(confirmed in the installed package's own type defs, not guessed -- no new
dependency), same `createFromOptions`/`detectForVideo` shape as
`FaceLandmarker`. `faces.ts` now also runs pose detection
(`pose_landmarker_lite`, fetched and committed the same way
`face_landmarker.task` was -- `web/public/models/pose_landmarker_lite.task`,
local-first with the same CDN fallback pattern) and derives an approximate
head/neck bbox per detected body from BlazePose's fixed nose/shoulder
landmarks (indices 0/11/12). `mergeFacesAndBodies()` only adds a body entry
when no real face already covers roughly the same position, so a body
detection can never crowd out or conflict with a real face -- it strictly
fills in people who'd otherwise have no anchor at all. Deliberately
honest about the limit: a body-only entry (`hasFace: false`) carries no
mouth signal whatsoever, so it can never win the speaker lock -- it gives a
real position, not speaker discrimination, exactly the tradeoff named in
the plan. Rendered dashed/dimmer than a real face box, and the debug label
says "body only (no mouth signal)" instead of the usual open/rev numbers.

**Camera fixes**: re-added `width`/`height` *ideal* hints (1920x1080) to
`getUserMedia` -- deliberately still no `aspectRatio`, since that
constraint specifically was what caused the earlier hardware-zoom bug, not
a resolution hint on its own. Also added a feature-detected tap-to-refocus
handler on the video element: checks `track.getCapabilities().focusMode`
before doing anything, and only wires up `pointsOfInterest` if the
capability list actually includes it; where the platform exposes no focus
control at all (researched, not guessed: this is Android-Chrome-only --
explicitly unsupported on iOS Safari and even desktop Chrome), the tap is
a no-op and says so in the console rather than pretending to work.

Verified in this sandbox (no camera, so no real detection or focus
control to exercise): clean build, `window.__hud.posesReady()` true after
a fresh load (the pose model -- local file this time, no CDN round trip --
loads without throwing), no new console errors. **Everything else needs
the phone**: does a body-only anchor actually land a bubble on a distant
talking person instead of center-defaulting; does the resolution bump
alone fix the blur (check this *before* judging tap-to-focus, no point
tuning manual focus against a low-res feed); does tap-to-focus do
anything at all on the test device; and whether two MediaPipe models
running every frame costs enough fps to need the "only run pose when face
count is low" throttle flagged as a follow-up in the plan.

## 2026-09-26 — phone orientation sensor, on the new reeves-imu-orientation branch

New feature (README §3's "phone held in front of the face" caveat: a static
`head_yaw_offset_deg` is only accurate to ~15° and breaks down as soon as
the phone moves independently of the wearer's head). `src/orientation.ts`
tracks the phone's own rotation via `DeviceOrientationEvent`/
`deviceorientationabsolute` (preferring iOS's `webkitCompassHeading` when
present) as a **delta since a reference sample**, never an absolute
heading -- deliberately, since neither true-north referencing nor the
rotation-sign convention can be verified without a real device. Feeds
straight into `head_yaw_offset_deg` in `main.ts`'s existing per-frame
`renderCalib` (same spot `effectiveFovDeg` already lives), so markers,
bubbles, face-anchor matching and the compass nose-marker all pick it up
for free -- no rendering changes needed anywhere else.

Gated behind a new `#orient-btn` (mirrors the mic button), off by default,
and verified in this sandbox (no real gyroscope, but a real permission
flow) that the degraded path is completely safe: this environment exposes
`DeviceOrientationEvent.requestPermission` and denies it, and the tracker
cleanly reports `state: "error", lastError: "permission denied"` with zero
effect on anything else (`window.__hud.orientation()` confirmed via direct
JS eval after a fresh page load and after clicking the button -- no
exceptions, fov/yaw_off/markers/bubbles all rendered exactly as before).
Also added a debug-panel line (`imu: <source> raw:X° delta:Y°`) so the
first real-device test gives numbers immediately instead of needing
another guess-and-check round like mouth-activity did.

**Needs the user's actual phone for**: whether requesting
`deviceorientationabsolute`/`webkitCompassHeading` actually fires on their
device, and — the one thing flagged in the plan as unverifiable here at
all — whether the pan direction is correct or needs the `ROTATION_SIGN`
constant in `orientation.ts` flipped.

## 2026-09-26 — back to `cover`, correctly this time (full-screen, no bars)

Human tested the `contain` fix: zoom was gone, but now wanted the video to
fill the whole screen edge-to-edge ("as per the camera's ratio") rather
than show letterbox bars. Fair -- `contain` trades screen coverage for
zero cropping, and that trade wasn't what was wanted; a normal camera
app's full-bleed, gently-cropped viewfinder was. Switched back to
`object-fit: cover`, but this time keeping the actually-important fix from
the previous pass (the unconstrained `getUserMedia` call, no
width/height/aspectRatio) and properly compensating for `cover`'s crop
instead of avoiding it:

- `computeCoverCrop` (`calib.ts`) computes the visible video-normalized
  window once per frame from `video.videoWidth/Height` vs canvas size.
- `effectiveFovDeg` is back (derived directly from that crop's width now,
  rather than recomputing scale internally) and feeds a corrected
  `camera_fov_deg` into a per-frame `renderCalib` -- same approach as the
  very first viewport-fix pass.
- New this time: raw face-detection coordinates are normalized to the
  *full* video frame, not the visible cropped portion of it. Realized
  partway through that this means the original pass's `computeFaceAnchors`
  call was *always* subtly wrong under any real `cover` crop (feeding a
  full-video-space `centerXNorm` into bearing math that expects
  crop-space), just never caught because it hadn't been tested against
  real cropping + real faces together yet. Fixed by remapping
  `latestFaces` from full-video-normalized to crop-normalized exactly once
  per frame in `main.ts` (`videoNormToCropNorm`), before either the
  face->bearing matching or any drawing sees them -- so `render.ts` needed
  no rect-awareness at all and reverted cleanly to its pre-`contain` form
  (plain `xNorm * canvasSize` math throughout).

Bonus: a face whose remapped coordinate falls outside [0,1] (i.e. it was
cropped out of the visible frame) now naturally lands off-canvas instead
of needing an explicit visibility check -- verified this and the crop/FOV
math by hand (portrait-phone case: heavy horizontal crop, FOV correctly
reduced to ~19° same as the original pass's numbers; landscape-laptop
case: vertical crop only, FOV unchanged at 62°; a face 0.05 from the video
edge under heavy crop maps to a negative, correctly off-screen, coordinate).
Real on-phone confirmation that it now fills the screen without the
earlier hardware-zoom problem still needs the human's camera.

## 2026-09-26 — real fix for phone camera zoom: contain, not a crop correction

Human re-test on the phone (two people, multi-speaker) confirmed the
viewport clipping fix worked (compass/axis fully visible), but called out
that the camera itself was still "way too zoomed in, should be natural
1x" -- and looking at the earlier screenshot, that's a fair diagnosis of
my previous fix (the `aspectRatio: {ideal: ...}` request from the
viewport-clipping pass): asking a phone camera for an extreme portrait
aspect ratio can push it into a hardware-level crop/zoom to manufacture
that ratio, which is worse than the plain `object-fit: cover` crop I was
originally correcting for, not better.

Replaced that whole approach:

- `getUserMedia` now requests only `facingMode: {ideal: "environment"}` --
  no width/height/aspectRatio constraints at all, so the camera gives its
  plain default (true 1x) mode.
- `#cam`'s `object-fit` changed from `cover` to `contain` (`style.css`):
  shows the *entire* camera feed, never crops/magnifies, at the cost of
  letterbox bars when the video and screen aspect ratios don't match. This
  is what "natural 1x" actually requires -- cover fundamentally can't
  provide it when a landscape sensor is shown on a portrait screen, no
  matter how well-matched the requested aspect ratio is.
- Removed `effectiveFovDeg` (the previous pass's crop-correction math --
  dead now, since `contain` never crops, so nothing to correct for) and
  replaced it with `computeContainRect` (`calib.ts`), which instead
  computes *where* the video actually sits within the canvas (contain's
  letterbox rect). Bearing math itself needed zero changes (it's already
  video-relative, self-consistent regardless of display letterboxing) --
  only code that converts a video-normalized coordinate into an actual
  canvas pixel for drawing (face boxes, bubble anchors, in-frame markers)
  needed to go through this rect instead of the raw canvas size, via new
  `videoXToCanvasX`/`videoYToCanvasY` helpers. Off-FOV edge arrows and the
  full-width compass strip are deliberately unaffected -- they're
  schematic HUD affordances, not tied to video content.

Verified the rect math by hand for both letterbox directions: a portrait
canvas with a landscape video correctly gets vertical bars with the video
spanning the full canvas *width* (so old marker math would've stayed
correct there, by luck); a landscape canvas with a taller-relative video
gets horizontal bars instead (where old marker math *would* have broken --
now correctly offset via the rect either way). Full visual confirmation
of the letterboxing + un-zoomed feed still needs the real phone camera
(this sandbox has none) -- flagged back to the human.

## 2026-09-26 — multi-speaker mock test + WS message hardening

Added a second, simultaneous off-FOV speaker to `web/dev/mock-ws.mjs`'s
demo loop (bearing -60, overlapping the existing bearing-10 speaker's
lifetime). Confirmed both events render independently -- neither replaces
or hides the other, and the "directional" vs "anchored/maybe-playback"
bubble styles both render correctly at the same time. Did find a real, if
minor, issue: when two *different* events' class/confidence labels land
close together in screen space (here: the earlier "playback" event fading
out near the new one's edge arrow), their text can visually overlap --
there's no cross-event collision layout, each marker draws independently.
Not fixing now (would need a real layout pass, out of scope for this
pass) but flagging it since it'll get worse with more simultaneous real
sound sources.

Added `src/validate.ts`: a small no-schema-library guard now sitting in
front of `ws-client.ts`'s message dispatch. Rejects a message outright
only when a field its own downstream handler actually dereferences is
missing/wrong-typed (e.g. a `sound_event` with no `bearing_deg`); defaults
everything else so a slightly-off message still renders instead of
vanishing. `main.ts`'s `timeline` handler now re-validates each entry in
its `events` array too, since the top-level check only confirms it's an
array. Verified live: temporarily sent a `sound_event` missing
`bearing_deg` (dropped, logged, no crash) and a `backend_status` missing
`model_sha256` (defaulted to `"unknown"`, rendered fine -- this one would
have thrown inside `render.ts`'s `bs.model_sha256.slice(0, 8)` pre-fix,
a real crash risk against B's early backend bugs). Reverted the temporary
malformed sends afterward; `git diff` confirmed only the permanent
dual-speaker addition remains in `mock-ws.mjs`.

## 2026-09-26 — attempted: face detection in a Web Worker (reverted)

Tried moving `FaceLandmarker` off the main thread (`vision.worker.ts` +
a `faces.ts` host wrapper posting transferred `ImageBitmap`s, capped at one
in flight), mirroring the pattern `origin/ryan-frontend` uses. Wired up
correctly (Vite split it into its own chunk; main bundle dropped from
~168KB to ~13KB as expected) and the GPU→CPU delegate fallback triggered
correctly, but *both* delegates failed identically with `Error: ModuleFactory
not set` from inside the worker -- a WASM-loader-internal error, not a
network/CORS one. Confirmed this is not a Vite dev-server quirk (identical
failure against a real `vite build` + `vite preview` production build).
Tried shimming `self.window = self` before touching the library (a known
workaround for libraries that do `typeof window` environment detection and
silently pick a broken loading path in a worker) -- no change.

Given main-thread detection is already proven at 100+ fps on the actual
phone (see below), and this is a perf nice-to-have rather than a P0/P1
item, spent a fixed amount of time on it and then **reverted** rather than
keep digging with an open-ended time cost — `git checkout` on `faces.ts`/
`main.ts`, deleted `vision.worker.ts`. If someone wants to pick this back
up: the failure is almost certainly inside the WASM glue file that
`FilesetResolver.forVisionTasks` fetches at runtime from the CDN
(`.../wasm/*_internal.js`), not in anything local to this repo -- worth
trying a different `@mediapipe/tasks-vision` version, or Ryan's exact
worker setup on `origin/ryan-frontend` (`web/src/vision.worker.ts`, `web/src/vision.ts`)
since his apparently does work, to see what he did differently.

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
