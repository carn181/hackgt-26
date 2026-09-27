# HUD visual pass: "Capcraft" (branch `design-exploration`)

Design canvas (8 boards, private until shared): https://claude.ai/artifact/4KstkNwRN5SFYtKWd4qjcP

**Status: implemented** in `web/src/render.ts` and `web/src/style.css`. Nothing is committed yet.

This is a **skin**, not a rewrite. These were not touched: `server/**`, `esp32/**`, `config/**`, the WS message
shapes, `calib.ts`, speaker-lock / mouth-activity (`faces.ts`, `main.ts`), `orientation.ts`, `ws-client.ts`,
and `index.html`. `drawOverlay`'s signature, the debug panel's lines and `window.__hud.*` are unchanged.
Everything below changes how the renderer *draws* a result it already has.

## Where the build differs from the canvas (and why)

- **Controls are two rows, bottom-right.** The top row is mic + imu, the bottom row is the all / important /
  quiet segmented control. The real buttons say `mic 12s` / `imu -14°` (text set in `main.ts`), which is too
  wide for one 390px row. `render.ts` keeps the compass just above that stack (`CONTROLS_STACK_PX`), not at
  `0.9·h`.
- **Edge markers stack in one shared column just under the horizon**, whichever side each is on. Left and right
  labels can't overprint on a narrow phone, and edge rows don't cross the in-frame pins standing on the horizon.
- **"Said once" rule.** When a speech event's bubble is anchored to a face or docked to an edge, its sound marker
  keeps only the pin or edge arrow and drops the label. Playback bubbles keep their marker label, because
  "Speech 81%" is the evidence for the playback question.
- **Bubbles avoid things.** They steer clear of faces, every marker label, the debug panel, the subtitle box
  and the compass band. Tailed bubbles are placed first. Edge-docked ones then slide up or down, whichever is
  the shorter move.
- **Flagged, your call.** The compass no longer draws a glyph for events with no direction (`source: "none"` /
  `accuracy_deg >= 180`). That is the same rule the markers already followed. Before, those events showed up
  at 0°. To undo it, delete the `ev.source === "none" || ev.accuracy_deg >= 180` check in `drawCompass`.
- **Optional follow-up** (not done, it's `index.html`): swap the Google Fonts `Pixelify Sans` link for
  `<link rel="preload" href="/fonts/capcraft.woff2" as="font" type="font/woff2" crossorigin>`. The Google link
  currently still loads Pixelify as the fallback font.

## 1. Font

- `web/public/fonts/capcraft.woff2`: 2.8 KB, 127 glyphs, proportional, 8-row grid. 26 glyphs (24 letters plus
  `<` `>`) are traced pixel-for-pixel from the Minecraft subtitle reference; the rest are drawn to match.
  To rebuild, edit `web/fonts-src/capcraft/glyphs.py`, then run `build.py` (needs `fonttools brotli`).
- `style.css` has the `@font-face` with `font-display: swap`. `PIXEL_FONT = '"Capcraft", "Pixelify Sans", ...'`.
- **Sizes are 8·n px only**, so every font pixel is a whole number of CSS px and stays crisp:

  | token | phone | `w >= 900` | use |
  |---|---|---|---|
  | sm | 8 | 16 | F3 debug lines |
  | md | 16 | 24 | marker labels, nametags, tabs, compass letters |
  | lg | 24 | 32 | speech bubble text, edge arrows, pin glyphs |
  | xl | 40 | 48 | urgent title |

- `pixelText` uses the same outline technique as the old `outlinedText`, with square joins so the 1px outline
  follows the pixel grid: `lineJoin = "miter"; miterLimit = 2; lineWidth = 2; strokeStyle = "#000"`, then
  `strokeText`, then `fillText`. For big text, draw Minecraft's drop shadow first: `fillText` in
  `mcShadow(fill)` (each channel ÷ 4) at `(x+u, y+u)`. Text is measured and its left edge snapped to a
  whole pixel.
- Icons live in the font, so they get the same outline: tiers `● ◆ ▲ ⚠`, hollow `○ ◇ △`, arrows
  `◀ ▶ ◂ ▸ ▾ ▼`, and private-use icons speaker ``, mic ``, rotate/IMU ``. `style.css` adds
  the mic and rotate icons to the two buttons with `::before`.

## 2. Tokens

```ts
// URGENCY_COLOR unchanged: low #b9cbdd, normal #1fd8ff, high #ffb454, urgent #ff3b3b
const TIER_GLYPH  = { low: "●", normal: "◆", high: "▲", urgent: "⚠" };   // shape carries the tier
const TIER_HOLLOW = { low: "○", normal: "◇", high: "△", urgent: "△" };   // front/back ambiguous
const GLASS = "rgba(14,16,30,0.62)", RING = "#ffffff", NEW_WORD = "#ffff55",
      LIVE = "#7cfc9a", PLAYBACK = "#d58cff";
const F3_STRIP = "rgba(80,80,80,0.56)", UI_TEXT = "#e0e0e0", OK = "#55ff55", BAD = "#ff5555";
```

Motion is **stepped**: `beat(f, periodMs)` flips every half period, with no eased tweens. `prefers-reduced-motion`
turns off bob, march, pop, hop and sparkles. The urgent pulse stays on, since it is the alarm.

## 3. Per element (`render.ts`)

- **Faces** (`drawFaces`): corner reticles.
  - Tracked: white at 80%, 1-unit arms.
  - Locked: 2-unit arms that snap in over 180ms when the lock lands.
  - Body-only: dotted at 55%.
  - Nametag plate below the box, then an sm line with `open:0.42 rev:6`. When the face owns an anchored bubble,
    the line reads `#2 open:... rev:...` and the name moves to the bubble's tab.
  - A moving mouth gets three green `+` sparkles instead of the dot.
  - Everything is drawn at 40% during urgent.
- **Markers** (`drawEventMarker` / `drawOneMarker`): quest-marker pins.
  - In frame: tier glyph on a stem standing on the horizon. Label above: class in the tier color, numbers in
    UI_TEXT, clamped on screen.
  - Off-FOV: the edge row gets arrows (×1 low/normal, ×2 high, ×3 urgent, marching), then the glyph, then the
    label.
  - Ambiguous: hollow glyph, a ring of 12 dots, ` ?`, and both mirrored candidates as before.
  - High bobs. Urgent's glyph pulses between two crisp sizes.
- **No-direction list** (`drawUnlocatedList`): Minecraft subtitle box, bottom-right above the compass.
  - Each row: `? <glyph> Class NN% ?`, newest at the bottom, max 8 rows plus `+N more`.
  - Text greys toward #555 with age; alpha still follows confidence.
- **Speech bubbles** (`layoutBubble` / `drawBubble`): the style decision is unchanged (anchored / maybePlayback /
  directional).
  - Frame: pixel body with 2-step corners, a folder tab, and a stepped tail or a side arrow, built as one
    polygon. It gets glass fill, a white ring (dashed violet for playback), a 1px black outline and a
    one-unit drop shadow.
  - Text: lg size, wrapped at `min(0.7·w, 200·S)`, max 3 lines. A longer transcript keeps its newest words
    behind a leading `…`.
  - Tabs: `#id ♪` (♪ blinks while the mouth moves), `◂◂ LEFT 60°` / `BEHIND 140° ▸▸`, or
    ` NO FACE · PLAYBACK?`.
  - Placement: anchored goes above the head, falling back to beside the face; it never covers the mouth.
    Playback goes above its marker. Directional docks to its edge with an arrow tail and a stepped edge glow.
  - States: partial shows a blinking `_`; final shows a bobbing `▼`; new words flash yellow for 300ms with a
    1-unit hop. No typewriter, so reading latency doesn't go up.
  - Life: pops in from the tail tip (.3 → .75 → 1.1 → .96 → 1, 45ms steps). Full opacity for the TTL, then a
    stepped exit over the last 300ms.
- **Urgent** (`drawUrgentFrame` + `drawUrgentCallout`):
  - Dimmed video, pulsing red edge vignette, and a hard red frame stepping between 6px and 10px.
  - A Minecraft `/title` callout `⚠ CLASS ⚠`, which shrinks to fit long class names.
  - Below it: `94%  ▸ 120° BEHIND-RIGHT` (or `direction unknown`) and a boss bar filled to confidence.
- **Compass** (`drawCompass`): Minecraft XP bar. The mapping `x = 0.5·(1 + deg/180)·w` is unchanged.
  - FOV window around the nose `▾`.
  - Ticks every 30°. `L R B` letters below the bar.
  - Tier glyphs at each localized bearing; hollow pairs for ambiguous events.
- **Debug panel** (`buildDebugLines` / `drawDebugPanel`): Minecraft F3 screen.
  - Same lines, same order, `top = 40`. Each line sits on its own strip.
  - open/ok in green, X in red, missing status in amber.

## 4. `style.css`

- Minecraft buttons: 44px tall, bevelled translucent glass, 1px black ring, 16px Capcraft with the 8 × 1px
  black text-shadow outline.
- Selected mode: pressed bevel, white inner frame, `#ffff55` text.
- mic/imu running: green frame. Error: amber frame.
- `#controls` spans the bottom with `pointer-events: none`, so taps between buttons still reach the video for
  tap-to-focus. A `::before` flex item forces the row break.
- `.banner` is a top toast: dark plate, red pixel frame, ending at y = 40 where the debug panel starts.

## 5. Off-screen speakers (side bubble): what it depends on

- The drawing is pure render work. It consumes `bearingToScreenX` / `normalizeDeg` output unchanged.
- It needs a real bearing (mic array or camera fusion). On the phone-mic-only path, speech arrives with
  `source: "none"` and `accuracy_deg: 180`, so there is no left or right to show.
- **Logic caveat, outside this pass:** `computeFaceAnchors` falls back to the locked face (or the only visible
  face) even when the speech has a *trusted* off-screen bearing. With anyone on screen, an off-screen voice
  gets pinned to the visible person and the side bubble never appears. Changing that is a `main.ts`
  speaker-lock decision for its owner, not part of the skin.
