import type { Calibration, Urgency } from "./types";
import { bearingToScreenX, mirrorBearing, normalizeDeg } from "./calib";
import type { HudState, TrackedEvent, TrackedSpeech } from "./state";
import type { DetectedFace } from "./faces";
import type { ConnState } from "./ws-client";
import type { OrientationStatus } from "./orientation";

const URGENCY_COLOR: Record<Urgency, string> = {
  // Low was a dim #8aa0b4, which made non-speech events (footsteps, rustling,
  // anything the classifier is only half-sure of) read as barely-there. The tier
  // order is still obvious against normal/high/urgent, but every tier is legible.
  low: "#b9cbdd",
  normal: "#1fd8ff", // was a pale #4fd1ff -- too low-contrast to read at a glance; this + the
  // black text/icon outlines below (not relying on hue alone) is what actually fixes legibility.
  high: "#ffb454",
  urgent: "#ff3b3b",
};

/**
 * Urgency never rides on hue alone: every tier also has its own glyph (drawn
 * as Capcraft text, so it gets the same black outline as every label), its own
 * size and its own motion -- low sits still, high bobs, urgent pulses and takes
 * over the screen. The hollow set marks a front/back-ambiguous bearing.
 */
const TIER_GLYPH: Record<Urgency, string> = { low: "●", normal: "◆", high: "▲", urgent: "⚠" };
const TIER_HOLLOW: Record<Urgency, string> = { low: "○", normal: "◇", high: "△", urgent: "△" };
/** Chevrons on an off-FOV edge marker: more of them, and marching, for louder tiers. */
const EDGE_ARROWS: Record<Urgency, number> = { low: 1, normal: 1, high: 2, urgent: 3 };

/**
 * Capcraft (web/public/fonts, @font-face in style.css) is an 8-row pixel font
 * traced from Minecraft's. At 8·n px each font pixel is exactly n CSS px, so
 * every size below is a multiple of 8 and text is drawn at whole-pixel positions.
 */
const PIXEL_FONT = '"Capcraft", "Pixelify Sans", "Courier New", monospace';
const HORIZON_FRAC = 0.45; // vertical position for in-frame markers
/** style.css #controls: two 44px rows + a 6px gap, 12px off the bottom. The
 * compass sits just above that stack -- change the two together. */
const CONTROLS_STACK_PX = 12 + 44 + 6 + 44;

// Speech + chrome palette (the urgency colours above are unchanged).
const GLASS = "rgba(14,16,30,0.62)"; // bubble fill: the video stays visible through it
const RING = "#ffffff";
const NEW_WORD = "#ffff55"; // words that just arrived flash this, then settle to white
const LIVE = "#7cfc9a"; // a mouth moving right now
const PLAYBACK = "#d58cff"; // bearing on-screen but no face there: maybe a loudspeaker
const UI_TEXT = "#e0e0e0";
const DIM_TEXT = "#6e6e6e";
const OK = "#55ff55";
const BAD = "#ff5555";
const WARN = "#ffb454";
const PLATE = "rgba(0,0,0,0.4)"; // nametag backing, as in Minecraft
const F3_STRIP = "rgba(80,80,80,0.56)"; // debug-line backing, as in Minecraft's F3 screen
const POP_STEPS = [0.3, 0.75, 1.1, 0.96, 1];

const reducedMotion =
  typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

export interface FaceAnchor {
  face: DetectedFace;
  bearingDeg: number;
}

export interface RenderOptions {
  state: HudState;
  calib: Calibration;
  faces: DetectedFace[];
  faceAnchors: Map<string, FaceAnchor | null>; // speech id -> matched face (or null = no face)
  /** Which face's trackId (faces.ts) the debounced speaker-lock currently
   * holds, if any -- surfaced so the face-box overlay can show it live. */
  lockedSpeakerTrackId: number | null;
  orientationStatus: OrientationStatus;
  wsState: ConnState;
  rttMs: number | null;
  fps: number;
  addedLatencyMs: number | null;
}

/** CSS-pixel size of the canvas. All drawing below is in this space; the
 * caller applies a devicePixelRatio transform on the context, so raw
 * canvas.width/height (backing-store pixels) must never be used here. */
interface Size {
  w: number;
  h: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Type scale, all multiples of 8: phones 8/16/24/40, wide screens 16/24/32/48. */
interface Scale {
  S: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
}

/** What every draw call needs for this frame. */
interface Frame {
  ctx: CanvasRenderingContext2D;
  size: Size;
  sc: Scale;
  now: number;
  /** False when the OS asks for reduced motion: no bob, march, pop or hop.
   * The urgent pulse stays -- it is the alarm. */
  motion: boolean;
}

/** One coloured run of text; `alpha` scales whatever alpha is already set. */
type Run = [text: string, color: string, alpha?: number];
type Align = "left" | "center" | "right";

export function drawOverlay(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, opts: RenderOptions) {
  const { state, calib } = opts;
  const size: Size = { w: canvas.clientWidth, h: canvas.clientHeight };
  const f: Frame = {
    ctx,
    size,
    sc: typeScale(size),
    now: performance.now(),
    motion: !(reducedMotion?.matches ?? false),
  };
  ctx.clearRect(0, 0, size.w, size.h);

  const urgent = state.hasUrgent();
  if (urgent) drawUrgentFrame(f);

  const visible = state.visibleEvents();
  const visibleIds = new Set(visible.map((ev) => ev.id));

  // Said once, on the bubble: a face that speaks through an anchored bubble
  // drops its nametag, and a sound whose bubble is anchored or docked to an
  // edge drops its marker label (the pin / edge arrow itself stays).
  const anchoredTracks = new Set<number>();
  const bubbledEvents = new Set<string>();
  for (const [speechId, s] of state.speech) {
    if (!visibleIds.has(s.parent_event)) continue;
    const anchor = opts.faceAnchors.get(speechId);
    if (anchor) {
      anchoredTracks.add(anchor.face.trackId);
      bubbledEvents.add(s.parent_event);
    } else if (bearingToScreenX(state.events.get(s.parent_event)?.renderBearing ?? s.bearing_deg, calib) === null) {
      bubbledEvents.add(s.parent_event);
    }
  }

  drawFaces(f, opts.faces, opts.lockedSpeakerTrackId, anchoredTracks, urgent ? 0.4 : 1);

  // Bubbles steer clear of faces (lip-reading) and of every marker label.
  const obstacles: Rect[] = opts.faces.map((face) => ({
    x: face.bboxNorm.x * size.w,
    y: face.bboxNorm.y * size.h,
    w: face.bboxNorm.w * size.w,
    h: face.bboxNorm.h * size.h,
  }));

  // Localized events get a marker at their bearing; the rest get a caption. Two
  // sounds sharing a bearing stack vertically instead of drawing on top of each
  // other, and a sound with no direction (`source: "none"`, ±180°) is never drawn
  // at 0° — on the phone/laptop path most events are unlocalized, which is what
  // made a column of arrows pile up in the middle of the screen.
  const placed: { x: number; stack: number }[] = [];
  const unlocated: TrackedEvent[] = [];
  const edgeRows = { next: 0 };
  const pinSpan = pinHeight(f.sc);
  for (const ev of visible) {
    if (ev.source === "none" || ev.accuracy_deg >= 180) {
      unlocated.push(ev);
      continue;
    }
    const x = bearingToScreenX(ev.renderBearing, calib);
    let stack = 0;
    if (x !== null) {
      const px = x * size.w;
      while (placed.some((p) => Math.abs(p.x - px) < f.sc.md * 5.5 && p.stack === stack)) stack++;
      placed.push({ x: px, stack });
    }
    obstacles.push(...drawEventMarker(f, ev, calib, state, stack * pinSpan, edgeRows, bubbledEvents.has(ev.id)));
  }
  const compassY = compassCenterY(f);
  if (unlocated.length) {
    const box = drawUnlocatedList(f, unlocated, state, compassY);
    if (box) obstacles.push(box);
  }
  const debugLines = buildDebugLines(opts);
  obstacles.push(debugPanelRect(f, debugLines));
  const compassTop = compassY - 2 * f.sc.S - 5 * f.sc.S - 6; // nose marker included
  obstacles.push({ x: 0, y: compassTop, w: size.w, h: size.h - compassTop });

  // Every bubble is laid out first, then pushed clear of the markers and of
  // each other: two bubbles that want the same spot (e.g. one anchored to a
  // face right where an unanchored one's fallback position also lands) are
  // confusing on their own, and easy to misread as one bubble glitching rather
  // than two separate, real utterances.
  const bubbles: BubbleLayout[] = [];
  for (const [speechId, s] of state.speech) {
    if (!visibleIds.has(s.parent_event)) continue;
    const ev = state.events.get(s.parent_event);
    const bearingDeg = ev?.renderBearing ?? s.bearing_deg;
    const anchor = opts.faceAnchors.get(speechId) ?? null;
    const layout = layoutBubble(f, speechId, s, state.speechAge(s), bearingDeg, calib, anchor);
    if (layout) bubbles.push(layout);
  }
  // Tailed bubbles (pinned to a face or a marker) claim their spot first; the
  // edge-docked ones can go up or down, so they fit around them.
  bubbles.sort((a, b) => Number(a.tail.kind === "side") - Number(b.tail.kind === "side"));
  for (const layout of bubbles) {
    pushClear(layout, obstacles, size);
    obstacles.push(bubbleRect(layout));
  }
  for (const id of bubbleAnim.keys()) if (!state.speech.has(id)) bubbleAnim.delete(id);
  for (const b of bubbles) drawBubble(f, b);

  if (urgent) {
    let loudest: TrackedEvent | null = null;
    for (const ev of visible) if (ev.urgency === "urgent" && (!loudest || ev.confidence > loudest.confidence)) loudest = ev;
    if (loudest) drawUrgentCallout(f, loudest, calib);
  }

  drawCompass(f, visible, calib, compassY);
  drawDebugPanel(f, debugLines);
}

function typeScale(size: Size): Scale {
  const S = size.w >= 900 ? 3 : 2;
  return { S, sm: 8 * (S - 1), md: 8 * S, lg: 8 * (S + 1), xl: 8 * (S + 3) };
}

/** True on the second half of every `periodMs`. All motion is built from this:
 * stepped, pixel-art frames rather than eased tweens, and nearly free to draw. */
function beat(f: Frame, periodMs: number): boolean {
  return Math.floor(f.now / (periodMs / 2)) % 2 === 1;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function setFont(ctx: CanvasRenderingContext2D, px: number) {
  ctx.font = `${px}px ${PIXEL_FONT}`;
}

function runsWidth(ctx: CanvasRenderingContext2D, runs: Run[], px: number): number {
  setFont(ctx, px);
  let w = 0;
  for (const [text] of runs) w += ctx.measureText(text).width;
  return w;
}

/** Minecraft's text-shadow colour: the fill at a quarter brightness. */
function mcShadow(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${((n >> 16) & 255) >> 2},${((n >> 8) & 255) >> 2},${(n & 255) >> 2})`;
}

/**
 * Outlined text: a black backing stroke plus a colored fill on top, so every
 * label stays legible over any patch of video without depending on hue
 * contrast alone (a light, saturated urgency color can still wash out
 * against a bright background otherwise). Miter joins keep the 1px outline on
 * the font's pixel grid; `drop` adds Minecraft's one-font-pixel drop shadow
 * for the big sizes. `y` is the top of the capitals and the left edge snaps to
 * a whole pixel. Returns the advance width.
 */
function pixelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  px: number,
  fill: string,
  align: Align = "left",
  drop = false
): number {
  setFont(ctx, px);
  const w = ctx.measureText(text).width;
  const ink = w - px / 8; // the advance includes one font pixel of trailing letter-space
  const left = Math.round(align === "left" ? x : align === "center" ? x - ink / 2 : x - ink);
  const top = Math.round(y);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  if (drop) {
    ctx.fillStyle = mcShadow(fill);
    ctx.fillText(text, left + px / 8, top + px / 8);
  }
  ctx.lineJoin = "miter";
  ctx.miterLimit = 2;
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#000";
  ctx.strokeText(text, left, top);
  ctx.fillStyle = fill;
  ctx.fillText(text, left, top);
  return w;
}

function pixelRuns(
  ctx: CanvasRenderingContext2D,
  runs: Run[],
  x: number,
  y: number,
  px: number,
  align: Align = "left",
  drop = false
): number {
  const w = runsWidth(ctx, runs, px);
  const ink = w - px / 8;
  let cx = Math.round(align === "left" ? x : align === "center" ? x - ink / 2 : x - ink);
  const base = ctx.globalAlpha;
  for (const [text, color, alpha] of runs) {
    if (alpha !== undefined) ctx.globalAlpha = base * alpha;
    cx += pixelText(ctx, text, cx, y, px, color, "left", drop);
    ctx.globalAlpha = base;
  }
  return w;
}

/** Solid pixel blocks with the same 1px black outline as the text. */
function outlinedRects(ctx: CanvasRenderingContext2D, rects: Rect[], fill: string) {
  ctx.fillStyle = "#000";
  for (const r of rects) ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
  ctx.fillStyle = fill;
  for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
}

/** Minecraft-style nametag plate centred under (cx, y); returns its bottom edge. */
function drawPlate(f: Frame, runs: Run[], cx: number, y: number, px: number, alpha: number): number {
  const { ctx, size } = f;
  const u = px / 8;
  const padX = px / 4;
  const w = Math.round(runsWidth(ctx, runs, px) - u + 2 * padX);
  const h = px + px / 4;
  const x = clamp(Math.round(cx - w / 2), 4, size.w - 4 - w);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = PLATE;
  ctx.fillRect(x, y, w, h);
  pixelRuns(ctx, runs, x + padX, y + Math.round((h - 7 * u) / 2), px);
  ctx.restore();
  return y + h;
}

// ---------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------

let lastLockedTrackId: number | null = null;
let lockChangedMs = 0;

/**
 * Face reticles plus a live readout of the numbers the speaker-lock actually
 * decides on (jawOpen score, its recent swing, and which face -- if any --
 * currently holds the lock). Added specifically to stop guessing at
 * mouth-activity thresholds blind: this makes the real per-face numbers
 * visible during a live test instead of only inferring them from bubble
 * behavior after the fact.
 */
function drawFaces(
  f: Frame,
  faces: DetectedFace[],
  lockedSpeakerTrackId: number | null,
  anchoredTracks: Set<number>,
  dim: number
) {
  const { ctx, size, sc } = f;
  const u = sc.S;
  if (lockedSpeakerTrackId !== lastLockedTrackId) {
    lastLockedTrackId = lockedSpeakerTrackId;
    lockChangedMs = f.now;
  }
  for (const face of faces) {
    const x = Math.round(face.bboxNorm.x * size.w);
    const y = Math.round(face.bboxNorm.y * size.h);
    const w = Math.round(face.bboxNorm.w * size.w);
    const h = Math.round(face.bboxNorm.h * size.h);
    const isLocked = face.trackId === lockedSpeakerTrackId;

    ctx.save();
    // A body-only fallback (too far for a face) has no mouth signal at all,
    // so it can never hold the speaker lock -- dotted and dimmer marks it as
    // "a person, position only" rather than a real face detection.
    ctx.globalAlpha = dim * (isLocked ? 1 : face.hasFace ? 0.8 : 0.55);
    // Lock-on: the corners snap in from three units out when the lock lands here.
    const since = f.now - lockChangedMs;
    const out = isLocked && f.motion && since < 180 ? (3 - Math.floor(since / 60)) * u : 0;
    drawReticle(ctx, x - out, y - out, w + 2 * out, h + 2 * out, u, isLocked ? 2 : 1, isLocked ? 7 : 6, !face.hasFace);
    ctx.restore();

    if (face.mouthActive) drawSparkles(f, x + Math.round(w * 0.85), y + Math.round(h * 0.7), dim);

    // Nametag under the box -- state only (SPEAKING / body only), no per-track
    // id: it's an ever-incrementing internal counter (faces.ts's nextTrackId/
    // nextBodyTrackId), not a person count, and climbs every time the same
    // person's track drops and gets re-acquired (stepping out of frame and
    // back), so showing it just reads as a confusing, always-growing number.
    const anchored = anchoredTracks.has(face.trackId);
    const cx = x + w / 2;
    let ty = y + h + 6;
    if (!anchored) {
      const name: Run[] = face.hasFace
        ? isLocked
          ? [["SPEAKING", LIVE]]
          : []
        : [["body only", "#ffffff"]];
      if (name.length > 0) ty = drawPlate(f, name, cx, ty, sc.md, dim) + 2;
    }
    const numbers = face.hasFace
      ? `open:${face.mouthOpenScore.toFixed(2)} rev:${face.mouthActivity}`
      : "(no mouth signal)";
    drawPlate(f, [[numbers, "#c6c6c6"]], cx, ty, sc.sm, dim);
  }
}

/** Corner brackets, game target-lock style; `dotted` for a body-only box. */
function drawReticle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  u: number,
  thick: number,
  len: number,
  dotted: boolean
) {
  const L = Math.max(2, Math.min(len, Math.floor(w / u / 2) - 1, Math.floor(h / u / 2) - 1));
  const rects: Rect[] = [];
  const corners: [number, number, number, number][] = [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x, y + h, 1, -1],
    [x + w, y + h, -1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    const hy = sy > 0 ? cy : cy - thick * u;
    const vx = sx > 0 ? cx : cx - thick * u;
    const n = dotted ? 1 : L;
    for (let i = 0; i < L; i += dotted ? 2 : L) {
      const hx = sx > 0 ? cx + i * u : cx - (i + n) * u;
      const vy = sy > 0 ? cy + i * u : cy - (i + n) * u;
      rects.push({ x: hx, y: hy, w: n * u, h: thick * u }, { x: vx, y: vy, w: thick * u, h: n * u });
    }
  }
  outlinedRects(ctx, rects, "#ffffff");
}

/** Mouth moving: three green "+" sparkles drifting up past the jaw. */
function drawSparkles(f: Frame, x: number, y: number, alpha: number) {
  const { ctx } = f;
  const u = f.sc.S;
  ctx.save();
  ctx.globalAlpha = alpha;
  for (const [dx, dy, phase] of [
    [0, 0, 0],
    [5, -4, 0.33],
    [2, -8, 0.66],
  ]) {
    const p = f.motion ? (f.now / 1350 + phase) % 1 : 0.25;
    if (p > 0.85) continue; // a beat of nothing before each one respawns
    const sx = x + dx * u;
    const sy = y + dy * u - Math.floor(p * 9) * u;
    outlinedRects(ctx, [{ x: sx + u, y: sy, w: u, h: 3 * u }, { x: sx, y: sy + u, w: 3 * u, h: u }], LIVE);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Sound markers
// ---------------------------------------------------------------------------

/** Height of an in-frame pin, label to foot -- also its vertical stacking step. */
function pinHeight(sc: Scale): number {
  return 7 * sc.S + 6 + 7 * (sc.S + 1) + 6 * sc.S + 5;
}

function drawEventMarker(
  f: Frame,
  ev: TrackedEvent,
  calib: Calibration,
  state: HudState,
  stackOffsetY: number,
  edgeRows: { next: number },
  compact: boolean
): Rect[] {
  const age = state.eventAge(ev);
  if (age <= 0) return [];
  // Confidence modulates opacity but never below 65%: a low-confidence event is
  // still a real detection, and scaling straight by confidence (as this did) made
  // anything under ~0.3 — most non-speech — effectively invisible.
  const alpha = age * clamp(0.65 + 0.35 * ev.confidence, 0.65, 1);
  const bearings = ev.ambiguous ? [ev.renderBearing, mirrorBearing(ev.renderBearing)] : [ev.renderBearing];
  return bearings.map((bearing) => drawOneMarker(f, bearing, calib, ev, alpha, stackOffsetY, edgeRows, compact));
}

/**
 * Unlocalized events, as a Minecraft-style subtitle box instead of markers:
 * the class and confidence are real, the direction is unknown, and saying so
 * is the point -- hence the "?" where Minecraft puts its < and > arrows.
 * Newest at the bottom, older rows greying out, capped so the display cannot
 * become a wall.
 */
function drawUnlocatedList(f: Frame, events: TrackedEvent[], state: HudState, compassY: number): Rect | null {
  const { ctx, size, sc } = f;
  const MAX_ROWS = 8;
  const rows = events.slice(-MAX_ROWS).filter((ev) => state.eventAge(ev) > 0);
  if (!rows.length) return null;
  const hidden = events.length - Math.min(events.length, MAX_ROWS);
  const px = sc.md;
  const u = px / 8;
  const rowH = px + px / 4;
  const pad = 6;
  const label = (ev: TrackedEvent) => `${ev.class} ${Math.round(ev.confidence * 100)}%`;

  let widest = hidden > 0 ? runsWidth(ctx, [[`+${hidden} more`, ""]], px) : 0;
  for (const ev of rows) widest = Math.max(widest, runsWidth(ctx, [[`${TIER_GLYPH[ev.urgency]} ${label(ev)}`, ""]], px));
  const qw = runsWidth(ctx, [["?", ""]], px);
  const boxW = Math.round(widest + 2 * qw + 4 * pad);
  const boxH = (rows.length + (hidden > 0 ? 1 : 0)) * rowH + 8;
  const x0 = size.w - 8 - boxW;
  const bottom = compassY - 2 * sc.S - 1 - 5 * sc.S - 10; // clear of the compass nose marker
  const y0 = bottom - boxH;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(x0, y0, boxW, boxH);
  let ry = y0 + 4 + Math.round((rowH - 7 * u) / 2);
  if (hidden > 0) {
    pixelText(ctx, `+${hidden} more`, x0 + boxW / 2, ry, px, "#b9cbdd", "center");
    ry += rowH;
  }
  for (const ev of rows) {
    const age = state.eventAge(ev);
    ctx.globalAlpha = clamp(0.65 + 0.35 * ev.confidence, 0.65, 1) * Math.min(1, age / 0.1);
    const shade = Math.round(0x55 + (0xff - 0x55) * age);
    const glyphColor = age > 0.4 ? URGENCY_COLOR[ev.urgency] : DIM_TEXT;
    pixelText(ctx, "?", x0 + pad, ry, px, DIM_TEXT);
    pixelText(ctx, "?", x0 + boxW - pad, ry, px, DIM_TEXT, "right");
    pixelRuns(
      ctx,
      [
        [`${TIER_GLYPH[ev.urgency]} `, glyphColor],
        [label(ev), `rgb(${shade},${shade},${shade})`],
      ],
      x0 + boxW / 2,
      ry,
      px,
      "center"
    );
    ry += rowH;
  }
  ctx.restore();
  return { x: x0, y: y0, w: boxW, h: boxH };
}

function drawOneMarker(
  f: Frame,
  bearingDeg: number,
  calib: Calibration,
  ev: TrackedEvent,
  alpha: number,
  stackOffsetY: number,
  edgeRows: { next: number },
  compact: boolean
): Rect {
  const { ctx, size, sc } = f;
  const xNorm = bearingToScreenX(bearingDeg, calib);
  const y = Math.round(size.h * HORIZON_FRAC - stackOffsetY);
  const color = URGENCY_COLOR[ev.urgency];
  const glyph = (ev.ambiguous ? TIER_HOLLOW : TIER_GLYPH)[ev.urgency];
  const label: Run[] = [
    [ev.class, color],
    [` ${Math.round(ev.confidence * 100)}%`, UI_TEXT],
    [` ±${Math.round(ev.accuracy_deg)}°`, UI_TEXT],
  ];
  if (ev.ambiguous) label.push([" ?", color]);

  ctx.save();
  ctx.globalAlpha = alpha;
  let rect: Rect;
  if (xNorm === null) {
    // Off-FOV: glue the marker to the correct screen edge instead of clamping.
    // Edge rows stack just under the horizon (clear of the in-frame pins
    // standing on it), one row per marker whichever side it is on, so two
    // sounds -- or both mirrored candidates of an ambiguous one -- never
    // overprint, not even left label against right label on a narrow phone.
    const normBearing = normalizeDeg(bearingDeg - calib.head_yaw_offset_deg);
    const atRightEdge = normBearing > 0;
    const rowY = y + sc.lg / 2 + 8 + edgeRows.next++ * (sc.lg + 8);
    rect = drawEdgeMarker(f, atRightEdge, rowY, ev.urgency, glyph, compact ? null : label);
  } else {
    rect = drawPin(f, Math.round(xNorm * size.w), y, ev.urgency, glyph, ev.ambiguous, compact ? null : label);
  }
  ctx.restore();
  return rect;
}

/**
 * In-frame "quest marker": the tier glyph on a short stem whose foot stands on
 * the horizon at the sound's bearing, with class / confidence / accuracy above.
 * `label` null = the bare pin (its speech bubble already says the rest).
 */
function drawPin(
  f: Frame,
  x: number,
  y: number,
  tier: Urgency,
  glyph: string,
  ambiguous: boolean,
  label: Run[] | null
): Rect {
  const { ctx, sc } = f;
  const u = sc.S;
  const color = URGENCY_COLOR[tier];
  const stemW = sc.lg / 8;
  const stemH = 6 * u;
  const lift = tier === "high" && f.motion && beat(f, 500) ? u : 0;
  const foot = y - lift;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(x - 3 * u, y - 1, 6 * u, stemW);
  outlinedRects(ctx, [{ x: x - Math.floor(stemW / 2), y: foot - stemH, w: stemW, h: stemH }], color);

  const gpx = tier === "urgent" ? sc.lg + (beat(f, 500) ? 16 : 8) : sc.lg;
  const gu = gpx / 8;
  // ●/○ stop a row short of the baseline; seat every glyph right on the stem.
  const bottomRow = glyph === "●" || glyph === "○" ? 5 : 6;
  const gTop = foot - stemH - (bottomRow + 1) * gu;
  pixelText(ctx, glyph, x + 0.5, gTop, gpx, color, "center");

  let top = gTop;
  if (ambiguous) {
    // Dotted ring: "one of two candidates" (its mirror is drawn too).
    const r = 5.2 * gu;
    const cy = gTop + 3.5 * gu;
    const dots: Rect[] = [];
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      dots.push({
        x: Math.round(x + r * Math.cos(a) - stemW / 2),
        y: Math.round(cy + r * Math.sin(a) - stemW / 2),
        w: stemW,
        h: stemW,
      });
    }
    outlinedRects(ctx, dots, color);
    top = Math.round(cy - r - stemW);
  }
  let w = 8 * gu;
  let left = x - w / 2;
  if (label) {
    top -= 6 + 7 * u;
    w = runsWidth(ctx, label, sc.md);
    left = clamp(x - (w - u) / 2, 4, f.size.w - 4 - (w - u)); // keep it on screen near an edge
    pixelRuns(ctx, label, left, top, sc.md);
  }
  return { x: left, y: top, w, h: y + stemW - top };
}

/** Off-FOV marker glued to a screen edge: chevrons (marching for high/urgent),
 * then the tier glyph, then the label, all centred on row `y`. */
function drawEdgeMarker(f: Frame, right: boolean, y: number, tier: Urgency, glyph: string, label: Run[] | null): Rect {
  const { ctx, size, sc } = f;
  const color = URGENCY_COLOR[tier];
  const apx = sc.lg;
  const au = apx / 8;
  const n = EDGE_ARROWS[tier];
  const arrow = right ? "▶" : "◀";
  setFont(ctx, apx);
  const step = ctx.measureText(arrow).width - au;
  // The lit chevron walks out toward the edge, one step every 200ms.
  const lit = f.motion && n > 1 ? n - 1 - (Math.floor(f.now / 200) % n) : -1;
  const arrowTop = y - Math.round(3.5 * au);
  const base = ctx.globalAlpha;
  let x = right ? size.w - 4 : 4;
  for (let i = 0; i < n; i++) {
    // i = 0 sits on the edge itself
    ctx.globalAlpha = base * (lit < 0 || i === lit ? 1 : 0.35);
    pixelText(ctx, arrow, x, arrowTop, apx, color, right ? "right" : "left");
    x += right ? -step : step;
  }
  ctx.globalAlpha = base;

  const gpx = tier === "urgent" ? apx + (beat(f, 500) ? 8 : 0) : apx;
  const gu = gpx / 8;
  setFont(ctx, gpx);
  const gInk = ctx.measureText(glyph).width - gu;
  const gTop = y - Math.round(3.5 * gu);
  const labelTop = y - Math.round(3.5 * sc.S);
  if (!right) {
    const gx = x + 8;
    pixelText(ctx, glyph, gx, gTop, gpx, color);
    const lw = label ? pixelRuns(ctx, label, gx + gInk + 7, labelTop, sc.md) : -7;
    return { x: 4, y: gTop, w: gx + gInk + 7 + lw - 4, h: 7 * gu + 2 };
  }
  const gx = x - 8;
  pixelText(ctx, glyph, gx, gTop, gpx, color, "right");
  const lw = label ? pixelRuns(ctx, label, gx - gInk - 7, labelTop, sc.md, "right") : -7;
  const left = gx - gInk - 7 - lw;
  return { x: left, y: gTop, w: size.w - 4 - left, h: 7 * gu + 2 };
}

// ---------------------------------------------------------------------------
// Urgent takeover
// ---------------------------------------------------------------------------

let vignette: { w: number; h: number; g: CanvasGradient } | null = null;

/**
 * Urgent visually dominates everything else (SoundWatch: overload is the
 * failure mode): the video dims, the screen edges pulse red like Minecraft's
 * damage flash, and a hard red frame steps between two thicknesses. The pulse
 * ignores reduced-motion on purpose -- it is the alarm.
 */
function drawUrgentFrame(f: Frame) {
  const { ctx, size } = f;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.fillRect(0, 0, size.w, size.h);
  if (!vignette || vignette.w !== size.w || vignette.h !== size.h) {
    const cx = size.w / 2;
    const cy = size.h * 0.48;
    const r = Math.hypot(size.w, size.h) / 2;
    const g = ctx.createRadialGradient(cx, cy, r * 0.45, cx, cy, r);
    g.addColorStop(0, "rgba(255,40,40,0)");
    g.addColorStop(1, "rgba(255,30,30,0.6)");
    vignette = { w: size.w, h: size.h, g };
  }
  ctx.globalAlpha = beat(f, 900) ? 1 : 0.55;
  ctx.fillStyle = vignette.g;
  ctx.fillRect(0, 0, size.w, size.h);
  ctx.globalAlpha = 1;
  const t = beat(f, 500) ? 10 : 6;
  ctx.fillStyle = "#000";
  frameBars(ctx, size, 3, t + 2);
  ctx.fillStyle = URGENCY_COLOR.urgent;
  frameBars(ctx, size, 4, t);
  ctx.restore();
}

function frameBars(ctx: CanvasRenderingContext2D, size: Size, inset: number, t: number) {
  const w = size.w - 2 * inset;
  const h = size.h - 2 * inset;
  ctx.fillRect(inset, inset, w, t);
  ctx.fillRect(inset, size.h - inset - t, w, t);
  ctx.fillRect(inset, inset + t, t, h - 2 * t);
  ctx.fillRect(size.w - inset - t, inset + t, t, h - 2 * t);
}

/** Minecraft "/title"-style callout for the loudest urgent sound: what it is,
 * where it is, and a boss bar filled to the classifier's confidence. */
function drawUrgentCallout(f: Frame, ev: TrackedEvent, calib: Calibration) {
  const { ctx, size, sc } = f;
  const title = `⚠ ${ev.class.toUpperCase()} ⚠`;
  let px = sc.xl + (beat(f, 500) ? 8 : 0);
  while (px > sc.md && runsWidth(ctx, [[title, ""]], px) > size.w - 24) px -= 8; // long class names
  const top = Math.round(size.h * 0.27);
  pixelText(ctx, title, size.w / 2, top - (px - sc.xl) * 0.4, px, URGENCY_COLOR.urgent, "center", true);

  let where = "direction unknown";
  if (!(ev.source === "none" || ev.accuracy_deg >= 180)) {
    const rel = normalizeDeg(ev.renderBearing - calib.head_yaw_offset_deg);
    const deg = Math.round(Math.abs(rel));
    const side = rel > 0 ? "RIGHT" : "LEFT";
    const word = deg > 90 ? `BEHIND-${side}` : deg <= calib.camera_fov_deg / 2 ? "AHEAD" : side;
    where = `${rel > 0 ? "▸" : "◂"} ${deg}° ${word}${ev.ambiguous ? " ?" : ""}`;
  }
  const subY = top + sc.xl + Math.round(sc.xl * 0.35);
  pixelRuns(ctx, [[`${Math.round(ev.confidence * 100)}%  ${where}`, "#ffffff"]], size.w / 2, subY, sc.md, "center");

  const bw = Math.min(300, size.w - 60);
  const bh = 5 * sc.S;
  const bx = Math.round((size.w - bw) / 2);
  const by = subY + 7 * sc.S + 12;
  const fill = Math.round(bw * clamp(ev.confidence, 0, 1));
  ctx.fillStyle = "#000";
  ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
  ctx.fillStyle = "#4a0d0d";
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = URGENCY_COLOR.urgent;
  ctx.fillRect(bx, by, fill, bh);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fillRect(bx, by, fill, sc.S);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  for (let k = 1; k < 10; k++) ctx.fillRect(bx + Math.round((k * bw) / 10), by, 2, bh);
}

// ---------------------------------------------------------------------------
// Speech bubbles
// ---------------------------------------------------------------------------

type BubbleStyle = "anchored" | "directional" | "maybePlayback";

interface BubbleAnim {
  bornMs: number;
  text: string;
  /** Start of the words that arrived in the latest update (they flash). */
  newFrom: number;
  changedMs: number;
}

/** Per-utterance animation state (when it popped in, what just changed), by speech id. */
const bubbleAnim = new Map<string, BubbleAnim>();

type BubbleTail = { kind: "down"; tipX: number; tipY: number } | { kind: "side"; dir: -1 | 1 };

interface BubbleLayout {
  style: BubbleStyle;
  lines: string[];
  partial: boolean;
  /** How many trailing words are still flashing as new. */
  newWords: number;
  u: number;
  // body frame, CSS px
  x: number;
  y: number;
  w: number;
  h: number;
  tab: { runs: Run[]; x0: number; w: number; h: number };
  tail: BubbleTail;
  /** Screen edge to glow for a speaker off that side (0 = none). */
  glow: -1 | 0 | 1;
  alpha: number;
  anim: BubbleAnim;
}

function bubbleAnimFor(id: string, text: string, now: number): BubbleAnim {
  let a = bubbleAnim.get(id);
  if (!a) {
    a = { bornMs: now, text, newFrom: text.length, changedMs: -Infinity };
    bubbleAnim.set(id, a);
  } else if (a.text !== text) {
    let i = 0;
    const n = Math.min(a.text.length, text.length);
    while (i < n && a.text[i] === text[i]) i++;
    // Flash whole words: back up only if the change landed mid-word.
    if (i < text.length && text[i] !== " ") while (i > 0 && text[i - 1] !== " ") i--;
    a.newFrom = i;
    a.text = text;
    a.changedMs = now;
  }
  return a;
}

const wrapCache = new Map<string, string[]>();

/** Word-wrap to `maxW`, at most three lines; a longer transcript keeps its
 * newest words and leads with "…". Cached, so steady text costs nothing. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, px: number, maxW: number): string[] {
  const key = `${px}|${Math.round(maxW)}|${text}`;
  const hit = wrapCache.get(key);
  if (hit) return hit;
  setFont(ctx, px);
  const u = px / 8;
  const wrap = (words: string[]) => {
    const lines: string[] = [];
    let cur = "";
    for (const word of words) {
      const next = cur ? `${cur} ${word}` : word;
      if (!cur || ctx.measureText(next).width - u <= maxW) cur = next;
      else {
        lines.push(cur);
        cur = word;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  };
  let words = text.trim().split(/\s+/);
  let lines = wrap(words);
  while (lines.length > 3 && words.length > 1) {
    words = words.slice(1);
    lines = wrap(["…", ...words]);
  }
  if (wrapCache.size > 256) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}

function measureBubble(
  ctx: CanvasRenderingContext2D,
  s: TrackedSpeech,
  sc: Scale,
  maxW: number,
  tabRuns: Run[]
): { lines: string[]; w: number; h: number; tabW: number; tabH: number } {
  const px = sc.lg;
  const u = px / 8;
  const lines = wrapLines(ctx, s.text, px, maxW);
  setFont(ctx, px);
  let widest = 0;
  lines.forEach((l, i) => {
    let lw = ctx.measureText(l).width;
    if (i === lines.length - 1) lw += ctx.measureText(s.partial ? "_" : " ▼").width;
    widest = Math.max(widest, lw);
  });
  const tabU = Math.ceil((runsWidth(ctx, tabRuns, sc.md) + 8) / u) + 2;
  const wU = Math.max(7 + Math.ceil(widest / u), tabU + 4);
  return {
    lines,
    w: wU * u,
    h: (4 + 10 * lines.length) * u,
    tabW: tabU * u,
    tabH: (Math.ceil((sc.md + 2) / u) + 1) * u,
  };
}

/**
 * Where a bubble goes and what its tab says. The style decision is the same as
 * before: on a matched face = anchored; bearing on screen but no face =
 * maybePlayback (the loudspeaker-vs-person case, README §6.3 C6); otherwise the
 * speaker is off-screen = directional, docked to the edge they are on.
 */
function layoutBubble(
  f: Frame,
  id: string,
  s: TrackedSpeech,
  age: number,
  bearingDeg: number,
  calib: Calibration,
  anchor: FaceAnchor | null
): BubbleLayout | null {
  if (age <= 0 || !s.text.trim()) return null;
  const { ctx, size, sc } = f;
  const u = sc.lg / 8;
  const anim = bubbleAnimFor(id, s.text, f.now);
  const xNorm = anchor ? null : bearingToScreenX(bearingDeg, calib);
  const style: BubbleStyle = anchor ? "anchored" : xNorm !== null ? "maybePlayback" : "directional";
  const maxW = Math.min(size.w * 0.7, 200 * sc.S);
  // Clear of an in-frame marker's own label (and level with it for edge docking).
  const markerTop = Math.round(size.h * HORIZON_FRAC) - pinHeight(sc) - 2;

  let runs: Run[];
  let side: -1 | 1 = 1;
  if (anchor) {
    // No id here either (see drawFaces) -- just the mouth-active note, if any.
    runs = anchor.face.mouthActive ? [["♪", LIVE, f.motion && !beat(f, 600) ? 0.3 : 1]] : [];
  } else if (style === "maybePlayback") {
    runs = [["\uE000 NO FACE · PLAYBACK?", PLAYBACK]];
  } else {
    const rel = normalizeDeg(bearingDeg - calib.head_yaw_offset_deg);
    side = rel > 0 ? 1 : -1;
    const deg = Math.round(Math.abs(rel));
    const where = deg > 90 ? "BEHIND" : side > 0 ? "RIGHT" : "LEFT";
    // Two chevrons pointing off-screen; the lit one walks toward the edge.
    const phase = f.motion ? Math.floor(f.now / 200) % 2 : -1;
    const lit = (i: number) => (phase < 0 || i === phase ? 1 : 0.35);
    runs =
      side < 0
        ? [["◂", "#ffffff", lit(1)], ["◂", "#ffffff", lit(0)], [` ${where} ${deg}°`, "#ffffff"]]
        : [[`${where} ${deg}° `, "#ffffff"], ["▸", "#ffffff", lit(0)], ["▸", "#ffffff", lit(1)]];
  }

  let g = measureBubble(ctx, s, sc, maxW, runs);
  let x: number;
  let y: number;
  let tail: BubbleTail;
  if (anchor || xNorm !== null) {
    let tipX: number;
    let tipY: number;
    if (anchor) {
      // Above the head, tail to the top of the face box: the bubble never
      // covers the mouth -- d/Deaf users lip-read.
      const b = anchor.face.bboxNorm;
      tipX = Math.round((b.x + b.w / 2) * size.w);
      tipY = Math.round(b.y * size.h) - 4;
      if (tipY - 4 * u - g.h - g.tabH < 4) {
        // No room above: beside the face on the roomier side, arrow at the jaw.
        const fx = b.x * size.w;
        const fw = b.w * size.w;
        const onLeft = fx >= size.w - (fx + fw);
        const room = (onLeft ? fx : size.w - (fx + fw)) - 12 - 4 * u - 7 * u;
        if (room >= 6 * sc.lg) {
          g = measureBubble(ctx, s, sc, Math.min(maxW, room), runs);
          const mid = Math.floor(g.h / u / 2);
          x = onLeft ? Math.round(fx - 4 - 4 * u - g.w) : Math.round(fx + fw + 4 + 4 * u);
          y = Math.max(4 + g.tabH, Math.round((b.y + b.h * 0.72) * size.h - (mid + 0.5) * u));
          const tab = { runs, x0: x + 2 * u, w: g.tabW, h: g.tabH };
          return finish({ style, g, x, y, tab, tail: { kind: "side", dir: onLeft ? 1 : -1 }, glow: 0 });
        }
      }
    } else {
      tipX = Math.round((xNorm as number) * size.w);
      tipY = markerTop;
    }
    x = clamp(Math.round(tipX - g.w / 2), 4, size.w - 4 - g.w);
    y = Math.max(4 + g.tabH, tipY - 4 * u - g.h);
    tail = { kind: "down", tipX, tipY };
  } else {
    // Speaker off-screen: dock to their side, arrow tail pointing out of the edge.
    const mid = Math.floor(g.h / u / 2);
    x = side < 0 ? 4 + 4 * u : size.w - 4 - 4 * u - g.w;
    y = Math.round(markerTop - (mid + 0.5) * u);
    tail = { kind: "side", dir: side };
  }
  const tabX0 = style === "directional" && side > 0 ? x + g.w - 2 * u - g.tabW : x + 2 * u;
  return finish({
    style,
    g,
    x,
    y,
    tab: { runs, x0: tabX0, w: g.tabW, h: g.tabH },
    tail,
    glow: style === "directional" ? side : 0,
  });

  function finish(p: {
    style: BubbleStyle;
    g: ReturnType<typeof measureBubble>;
    x: number;
    y: number;
    tab: BubbleLayout["tab"];
    tail: BubbleTail;
    glow: -1 | 0 | 1;
  }): BubbleLayout {
    const flashing = f.now - anim.changedMs < 300 && anim.newFrom < s.text.length;
    return {
      style: p.style,
      lines: p.g.lines,
      partial: s.partial,
      newWords: flashing ? s.text.slice(anim.newFrom).trim().split(/\s+/).filter(Boolean).length : 0,
      u,
      x: p.x,
      y: p.y,
      w: p.g.w,
      h: p.g.h,
      tab: p.tab,
      tail: p.tail,
      glow: p.glow,
      // Full strength for the whole TTL, then a stepped exit over the last 300ms.
      alpha: age > 0.05 ? 1 : Math.ceil((age / 0.05) * 3) / 3,
      anim,
    };
  }
}

function bubbleRect(b: BubbleLayout): Rect {
  const arrow = b.tail.kind === "side" ? 4 * b.u : 0;
  const x = b.tail.kind === "side" && b.tail.dir < 0 ? b.x - arrow : b.x;
  return { x, y: b.y - b.tab.h, w: b.w + arrow, h: b.h + b.tab.h };
}

/** Slide a bubble clear of every marker label, face and earlier bubble:
 * edge-docked ones take whichever way (up or down) is the shorter move, one
 * with a tail below only moves up (the tail grows, its tip stays put). */
function pushClear(b: BubbleLayout, obstacles: Rect[], size: Size) {
  const start = b.y;
  const slide = (dir: -1 | 1): number | null => {
    b.y = start;
    for (let i = 0; i < 12; i++) {
      const r = bubbleRect(b);
      const hit = obstacles.find(
        (o) => r.x < o.x + o.w + 4 && o.x < r.x + r.w + 4 && r.y < o.y + o.h + 4 && o.y < r.y + r.h + 4
      );
      if (!hit) return b.y - start;
      const dy = dir < 0 ? hit.y - 4 - (r.y + r.h) : hit.y + hit.h + 4 - r.y;
      if (r.y + dy < 4 || r.y + r.h + dy > size.h - 4) return null;
      b.y += dy;
    }
    return null;
  };
  const up = slide(-1);
  const down = b.tail.kind === "down" ? null : slide(1);
  const best = up === null ? down : down === null ? up : Math.abs(down) < Math.abs(up) ? down : up;
  b.y = start + (best ?? 0); // nowhere clear: stay put and accept the overlap
}

function tailTip(b: BubbleLayout): [number, number] {
  if (b.tail.kind === "down") return [b.tail.tipX, b.tail.tipY];
  const midY = b.y + (Math.floor(b.h / b.u / 2) + 0.5) * b.u;
  return [b.tail.dir > 0 ? b.x + b.w + 4 * b.u : b.x - 4 * b.u, midY];
}

/**
 * The bubble silhouette as one closed polygon: a body with two-step pixel
 * corners, a folder tab on top, and either a stepped tail below or an arrow
 * out of one side. One polygon (no overlapping pieces) so the ring and outline
 * strokes never draw seams inside it.
 */
function bubblePath(b: BubbleLayout): Path2D {
  const { x, y, w, h, u } = b;
  const pts: [number, number][] = [];
  const add = (px: number, py: number) => pts.push([px, py]);
  const mid = Math.floor(h / u / 2);
  const DEPTH = 4;
  const HALF = 4;

  add(x + 2 * u, y);
  const { x0, w: tw, h: th } = b.tab;
  const x1 = x0 + tw;
  add(x0, y);
  add(x0, y - th + u);
  add(x0 + u, y - th + u);
  add(x0 + u, y - th);
  add(x1 - u, y - th);
  add(x1 - u, y - th + u);
  add(x1, y - th + u);
  add(x1, y);
  add(x + w - 2 * u, y);
  add(x + w - 2 * u, y + u);
  add(x + w - u, y + u);
  add(x + w - u, y + 2 * u);
  add(x + w, y + 2 * u);
  if (b.tail.kind === "side" && b.tail.dir > 0) {
    // down the right edge: step out along the arrow's top, back in along its bottom
    for (let k = 1; k <= DEPTH; k++) {
      const top = y + (mid - (HALF - k + 1)) * u;
      add(x + w + (k - 1) * u, top);
      add(x + w + k * u, top);
    }
    for (let k = DEPTH; k >= 1; k--) {
      const bot = y + (mid + (HALF - k + 1) + 1) * u;
      add(x + w + k * u, bot);
      add(x + w + (k - 1) * u, bot);
    }
  }
  add(x + w, y + h - 2 * u);
  add(x + w - u, y + h - 2 * u);
  add(x + w - u, y + h - u);
  add(x + w - 2 * u, y + h - u);
  add(x + w - 2 * u, y + h);
  if (b.tail.kind === "down") {
    // Stepped tail: rows narrowing from a 6-unit base to a 1-unit tip.
    const yb = y + h;
    const n = Math.max(2, Math.round((b.tail.tipY - yb) / u));
    const wU = Math.round(w / u);
    const tipC = Math.round((b.tail.tipX - x) / u - 0.5);
    const baseL = clamp(tipC - 3, 2, wU - 8);
    const L: number[] = [];
    const R: number[] = [];
    for (let r = 0; r < n; r++) {
      const t = (r + 1) / n;
      const l = Math.round(baseL + (tipC - baseL) * t);
      L.push(l);
      R.push(Math.max(l + 1, Math.round(baseL + 6 + (tipC + 1 - (baseL + 6)) * t)));
    }
    // The first row joins the body: keep it off the corner steps even when
    // the tip is far to one side (a face near the screen edge).
    L[0] = clamp(L[0], 2, wU - 3);
    R[0] = clamp(R[0], L[0] + 1, wU - 2);
    add(x + R[0] * u, yb);
    add(x + R[0] * u, yb + u);
    for (let r = 1; r < n; r++) {
      add(x + R[r] * u, yb + r * u);
      add(x + R[r] * u, yb + (r + 1) * u);
    }
    add(x + L[n - 1] * u, yb + n * u);
    for (let r = n - 1; r >= 1; r--) {
      add(x + L[r] * u, yb + r * u);
      add(x + L[r - 1] * u, yb + r * u);
    }
    add(x + L[0] * u, yb);
  }
  add(x + 2 * u, y + h);
  add(x + 2 * u, y + h - u);
  add(x + u, y + h - u);
  add(x + u, y + h - 2 * u);
  add(x, y + h - 2 * u);
  if (b.tail.kind === "side" && b.tail.dir < 0) {
    // up the left edge: step out along the arrow's bottom, back in along its top
    for (let k = 1; k <= DEPTH; k++) {
      const bot = y + (mid + (HALF - k + 1) + 1) * u;
      add(x - (k - 1) * u, bot);
      add(x - k * u, bot);
    }
    for (let k = DEPTH; k >= 1; k--) {
      const top = y + (mid - (HALF - k + 1)) * u;
      add(x - k * u, top);
      add(x - (k - 1) * u, top);
    }
  }
  add(x, y + 2 * u);
  add(x + u, y + 2 * u);
  add(x + u, y + u);
  add(x + 2 * u, y + u);

  const p = new Path2D();
  p.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
  p.closePath();
  return p;
}

function clipOutside(ctx: CanvasRenderingContext2D, path: Path2D, size: Size) {
  const outside = new Path2D();
  outside.rect(-10, -10, size.w + 20, size.h + 20);
  outside.addPath(path);
  ctx.clip(outside, "evenodd");
}

/** Stepped glow on the side of the screen a voice is coming from. */
function drawEdgeGlow(f: Frame, right: boolean, cy: number, height: number) {
  const { ctx, size } = f;
  const pulse = f.motion ? (beat(f, 1200) ? 1 : 0.55) : 0.8;
  const bands: [number, number][] = [
    [0.7, 0],
    [0.4, 12],
    [0.18, 24],
  ];
  bands.forEach(([a, inset], i) => {
    ctx.fillStyle = `rgba(255,255,255,${a * pulse})`;
    ctx.fillRect(right ? size.w - 3 - 3 * i : 3 * i, Math.round(cy - height / 2 + inset), 3, height - 2 * inset);
  });
}

/**
 * A pixel dialogue box: translucent glass, a one-font-pixel white ring (dashed
 * violet for maybe-playback), the same 1px black outline as the text, and a
 * one-unit drop shadow. It pops in from its tail tip, flashes new words, hops
 * when they land, shows Minecraft's chat cursor while the transcript is still
 * partial and a bobbing ▼ once it is final.
 */
function drawBubble(f: Frame, b: BubbleLayout) {
  const { ctx, size, sc } = f;
  const { u } = b;
  ctx.save();
  ctx.globalAlpha = b.alpha;
  if (b.glow) drawEdgeGlow(f, b.glow > 0, b.y + b.h / 2, Math.max(180, b.h + 60));
  const born = f.now - b.anim.bornMs;
  if (f.motion && born < POP_STEPS.length * 45) {
    const k = POP_STEPS[Math.floor(born / 45)];
    const [ox, oy] = tailTip(b);
    ctx.translate(ox, oy);
    ctx.scale(k, k);
    ctx.translate(-ox, -oy);
  }
  if (f.motion && f.now - b.anim.changedMs < 90) ctx.translate(0, -u);

  const path = bubblePath(b);
  ctx.save();
  clipOutside(ctx, path, size);
  ctx.translate(u, u);
  ctx.fillStyle = "rgba(0,0,0,0.38)";
  ctx.fill(path);
  ctx.restore();

  ctx.fillStyle = GLASS;
  ctx.fill(path);

  ctx.save();
  ctx.clip(path); // inner half of a 2u stroke = a 1u ring inside the edge
  ctx.lineJoin = "miter";
  ctx.miterLimit = 2;
  ctx.lineWidth = 2 * u;
  if (b.style === "maybePlayback") {
    ctx.strokeStyle = PLAYBACK;
    ctx.setLineDash([2 * u, 2 * u]);
  } else {
    ctx.strokeStyle = RING;
  }
  ctx.stroke(path);
  ctx.restore();

  ctx.save();
  clipOutside(ctx, path, size); // outer half of a 2px stroke = the 1px outline
  ctx.lineJoin = "miter";
  ctx.miterLimit = 2;
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#000";
  ctx.stroke(path);
  ctx.restore();

  pixelRuns(ctx, b.tab.runs, b.tab.x0 + u + 4, b.y - b.tab.h + u + 2, sc.md);

  // New words (the trailing `newWords`) flash yellow for a moment.
  const split: [string, string][] = [];
  let fresh = b.newWords;
  for (let i = b.lines.length - 1; i >= 0; i--) {
    const words = b.lines[i].split(" ");
    const keep = Math.max(0, words.length - fresh);
    fresh -= words.length - keep;
    split[i] = [words.slice(0, keep).join(" "), words.slice(keep).join(" ")];
  }
  const px = sc.lg;
  const tx = b.x + 4 * u;
  for (let i = 0; i < b.lines.length; i++) {
    const [oldPart, newPart] = split[i];
    const runs: Run[] = [];
    if (oldPart) runs.push([newPart ? `${oldPart} ` : oldPart, "#ffffff"]);
    if (newPart) runs.push([newPart, NEW_WORD]);
    const ty = b.y + 3 * u + i * 10 * u;
    const w = pixelRuns(ctx, runs, tx, ty, px, "left", true);
    if (i < b.lines.length - 1) continue;
    if (b.partial) {
      if (!f.motion || !beat(f, 1000)) pixelText(ctx, "_", tx + w, ty, px, "#ffffff", "left", true);
    } else {
      setFont(ctx, px);
      const space = ctx.measureText(" ").width;
      pixelText(ctx, "▼", tx + w + space, ty + (f.motion && beat(f, 800) ? u : 0), px, "#ffffff", "left", true);
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Compass + debug panel
// ---------------------------------------------------------------------------

function compassCenterY(f: Frame): number {
  // The L/R/B letters under the bar end 6px above the DOM control stack.
  return Math.round(f.size.h - CONTROLS_STACK_PX - 10 - 9 * f.sc.S);
}

/**
 * Minecraft-XP-bar compass: the full −180…+180 range, the camera's field of
 * view as a bright bracketed window around the nose marker, and a tier glyph
 * at every localized event's bearing (hollow pairs for front/back-ambiguous
 * ones) -- this is what makes off-screen sound legible. An event with no
 * direction gets no glyph here either, the same rule as the markers.
 */
function drawCompass(f: Frame, events: TrackedEvent[], calib: Calibration, yc: number) {
  const { ctx, size, sc } = f;
  const S = sc.S;
  const barH = 4 * S;
  const top = Math.round(yc - barH / 2);
  const bx = (deg: number) => 0.5 * (1 + deg / 180) * size.w;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, top, size.w, barH);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, top - 1, size.w, 1);
  ctx.fillRect(0, top + barH, size.w, 1);

  // Nose marker (0 deg, hat frame, before yaw offset applied to compass mapping below).
  const noseDeg = -calib.head_yaw_offset_deg;
  const halfFov = calib.camera_fov_deg / 2;
  const x0 = bx(normalizeDeg(noseDeg - halfFov));
  const x1 = bx(normalizeDeg(noseDeg + halfFov));
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  if (x0 <= x1) ctx.fillRect(x0, top, x1 - x0, barH);
  else {
    ctx.fillRect(x0, top, size.w - x0, barH);
    ctx.fillRect(0, top, x1, barH);
  }
  for (let deg = -150; deg <= 150; deg += 30) {
    ctx.fillStyle = deg % 90 === 0 ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.35)";
    ctx.fillRect(Math.round(bx(deg)) - 1, top, 2, barH);
  }
  for (const [x, inward] of [
    [x0, 1],
    [x1, -1],
  ]) {
    const vx = inward > 0 ? Math.round(x) : Math.round(x) - S;
    const tx = inward > 0 ? vx : vx + S - 3 * S;
    outlinedRects(
      ctx,
      [
        { x: vx, y: top - 3, w: S, h: barH + 6 },
        { x: tx, y: top - 3, w: 3 * S, h: S },
        { x: tx, y: top + barH + 3 - S, w: 3 * S, h: S },
      ],
      "#ffffff"
    );
  }
  pixelText(ctx, "▾", bx(noseDeg), top - 5 * S - 3, sc.md, "#ffffff", "center");

  const ly = top + barH + 4;
  pixelText(ctx, "L", bx(-90), ly, sc.md, UI_TEXT, "center");
  pixelText(ctx, "R", bx(90), ly, sc.md, UI_TEXT, "center");
  pixelText(ctx, "B", 4, ly, sc.md, UI_TEXT);
  pixelText(ctx, "B", size.w - 4, ly, sc.md, UI_TEXT, "right");

  // Event glyphs on the full-range strip (this is what makes off-screen events legible).
  for (const ev of events) {
    if (ev.confidence <= 0 || ev.source === "none" || ev.accuracy_deg >= 180) continue;
    const glyph = (ev.ambiguous ? TIER_HOLLOW : TIER_GLYPH)[ev.urgency];
    const px = ev.urgency === "urgent" && beat(f, 500) ? sc.md + 8 : sc.md;
    const bearings = ev.ambiguous ? [ev.renderBearing, mirrorBearing(ev.renderBearing)] : [ev.renderBearing];
    for (const b of bearings) {
      pixelText(ctx, glyph, bx(normalizeDeg(b)), yc - Math.round((3.5 * px) / 8), px, URGENCY_COLOR[ev.urgency], "center");
    }
  }
  ctx.restore();
}

const DEBUG_TOP = 40; // clear of the HTML error banner, which overlays the canvas at the top

/** The same diagnostics as always, as coloured runs (ok green, missing amber, bad red). */
function buildDebugLines(opts: RenderOptions): Run[][] {
  const lines: Run[][] = [];
  const bs = opts.state.backendStatus;
  const as = opts.state.arrayStatus;
  const wsColor = opts.wsState === "open" ? OK : opts.wsState === "connecting" ? WARN : BAD;
  lines.push([
    ["ws: ", UI_TEXT],
    [opts.wsState, wsColor],
    [opts.rttMs !== null ? `  rtt ${opts.rttMs.toFixed(0)}ms` : "", UI_TEXT],
  ]);
  lines.push([[`mode: ${opts.state.mode}   fps: ${opts.fps.toFixed(0)}`, UI_TEXT]]);
  lines.push([[`fov: ${opts.calib.camera_fov_deg.toFixed(1)}° (effective, post-crop)`, UI_TEXT]]);
  if (opts.addedLatencyMs !== null) lines.push([[`added latency: ${opts.addedLatencyMs.toFixed(1)}ms`, UI_TEXT]]);
  if (bs) {
    lines.push([[`model: ${bs.model} sha:${bs.model_sha256.slice(0, 8)} (${bs.classes} cls)`, UI_TEXT]]);
    lines.push([[`transport: ${bs.transport}  rev:${bs.git_rev}`, UI_TEXT]]);
  } else {
    lines.push([["model: (no backend_status yet)", WARN]]);
  }
  if (as) {
    const mics: Run[] = [["mics:", UI_TEXT]];
    for (const m of as.mics) mics.push([` ${m.id}:`, UI_TEXT], [m.ok ? "ok" : "X", m.ok ? OK : BAD]);
    mics.push([`  yaw_off:${as.calibration.head_yaw_offset_deg}°`, UI_TEXT]);
    lines.push(mics);
  } else {
    lines.push([["mics: (no array_status yet)", WARN]]);
  }
  const o = opts.orientationStatus;
  if (o.state === "running") {
    lines.push([[`imu: ${o.source} raw:${o.rawDeg.toFixed(1)}° delta:${o.deltaDeg.toFixed(1)}°`, UI_TEXT]]);
  } else if (o.state !== "off") {
    lines.push([[`imu: ${o.state}${o.lastError ? ` (${o.lastError})` : ""}`, o.state === "error" ? BAD : WARN]]);
  }
  return lines;
}

function debugPanelRect(f: Frame, lines: Run[][]): Rect {
  const px = f.sc.sm;
  let w = 0;
  for (const runs of lines) w = Math.max(w, runsWidth(f.ctx, runs, px));
  return { x: 8, y: DEBUG_TOP, w: w + 3 * (px / 8), h: lines.length * (px + px / 4) };
}

/** Minecraft F3-style: each diagnostics line on its own translucent strip. */
function drawDebugPanel(f: Frame, lines: Run[][]) {
  const { ctx, sc } = f;
  const px = sc.sm;
  const u = px / 8;
  const lineH = px + 2 * u;
  ctx.save();
  lines.forEach((runs, i) => {
    const y = DEBUG_TOP + i * lineH;
    ctx.fillStyle = F3_STRIP;
    ctx.fillRect(8, y, Math.round(runsWidth(ctx, runs, px) + 3 * u), lineH);
    pixelRuns(ctx, runs, 8 + 2 * u, y + u, px);
  });
  ctx.restore();
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
