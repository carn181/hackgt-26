# Frontend (member C) — dev evidence log

Owner: C. Append entries; don't rewrite history. Raw evidence only — checklist
ticks go in README §0 with the owner+time protocol.

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
