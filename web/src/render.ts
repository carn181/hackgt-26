import type { Calibration, Urgency } from "./types";
import { bearingToScreenX, mirrorBearing, normalizeDeg } from "./calib";
import type { HudState, TrackedEvent } from "./state";
import type { DetectedFace } from "./faces";
import type { ConnState } from "./ws-client";

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

const PIXEL_FONT = '"Pixelify Sans", "Courier New", monospace';
const HORIZON_FRAC = 0.45; // vertical position for in-frame markers
const COMPASS_Y_FRAC = 0.9; // leaves clearance for a phone's home-indicator/safe-area strip
const COMPASS_HEIGHT = 34;

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

export function drawOverlay(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, opts: RenderOptions) {
  const { state, calib } = opts;
  const size: Size = { w: canvas.clientWidth, h: canvas.clientHeight };
  ctx.clearRect(0, 0, size.w, size.h);

  drawFaces(ctx, size, opts.faces, opts.lockedSpeakerTrackId);

  const urgent = state.hasUrgent();
  if (urgent) drawUrgentFrame(ctx, size);

  const visible = state.visibleEvents();
  const visibleIds = new Set(visible.map((ev) => ev.id));
  // Localized events get an arrow at their bearing; the rest get a caption. Two
  // sounds sharing a bearing stack vertically instead of drawing on top of each
  // other, and a sound with no direction (`source: "none"`, ±180°) is never drawn
  // at 0° — on the phone/laptop path most events are unlocalized, which is what
  // made a column of arrows pile up in the middle of the screen.
  const placed: { x: number; stack: number }[] = [];
  const unlocated: TrackedEvent[] = [];
  for (const ev of visible) {
    if (ev.source === "none" || ev.accuracy_deg >= 180) {
      unlocated.push(ev);
      continue;
    }
    const x = bearingToScreenX(ev.renderBearing, calib);
    let stack = 0;
    if (x !== null) {
      const px = x * size.w;
      while (placed.some((p) => Math.abs(p.x - px) < 40 && p.stack === stack)) stack++;
      placed.push({ x: px, stack });
    }
    drawEventMarker(ctx, size, ev, calib, state, stack * 30);
  }
  if (unlocated.length) drawUnlocatedList(ctx, size, unlocated, state);

  // Same stacking idea as markers above: two bubbles that both want to point
  // at nearly the same spot (e.g. one anchored to a face right where an
  // unanchored one's fallback position also lands) otherwise draw on top of
  // each other -- confusing on its own, and easy to misread as one bubble
  // glitching rather than two separate, real utterances.
  const placedBubbles: { x: number; stack: number }[] = [];
  for (const [speechId, s] of state.speech) {
    if (!visibleIds.has(s.parent_event)) continue;
    const ev = state.events.get(s.parent_event);
    const bearingDeg = ev?.renderBearing ?? s.bearing_deg;
    const anchor = opts.faceAnchors.get(speechId) ?? null;
    const { tipX } = resolveBubbleTarget(size, calib, bearingDeg, anchor);
    let stack = 0;
    while (placedBubbles.some((p) => Math.abs(p.x - tipX) < 90 && p.stack === stack)) stack++;
    placedBubbles.push({ x: tipX, stack });
    drawSpeechBubble(ctx, size, s.text, bearingDeg, calib, anchor, state.speechAge(s), stack * 36);
  }

  drawCompass(ctx, size, visible, calib);
  drawDebugPanel(ctx, opts);
}

/**
 * Outlined text: a black backing stroke plus a colored fill on top, so every
 * label stays legible over any patch of video without depending on hue
 * contrast alone (a light, saturated urgency color can still wash out
 * against a bright background otherwise).
 */
function outlinedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fillColor: string,
  lineWidth = 3
) {
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = "#000";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fillColor;
  ctx.fillText(text, x, y);
}

/**
 * A single triangular arrow glyph, black-backed for contrast, used for both
 * in-frame direction markers (pointing down at the bearing) and off-FOV edge
 * indicators (pointing left/right) -- one shared "arrow style" per the
 * Minecraft-sound-mod reference instead of a circle-plus-chevron mix.
 */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angleRad: number,
  size: number,
  color: string,
  hollow = false
) {
  const path = (scale: number) => {
    ctx.beginPath();
    ctx.moveTo(size * 0.6 * scale, 0);
    ctx.lineTo(-size * 0.4 * scale, -size * 0.5 * scale);
    ctx.lineTo(-size * 0.4 * scale, size * 0.5 * scale);
    ctx.closePath();
  };
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angleRad);
  if (hollow) {
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#000";
    path(1);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    path(1);
    ctx.stroke();
  } else {
    ctx.fillStyle = "#000";
    path(1.3);
    ctx.fill();
    ctx.fillStyle = color;
    path(1);
    ctx.fill();
  }
  ctx.restore();
}

function drawEventMarker(
  ctx: CanvasRenderingContext2D,
  size: Size,
  ev: TrackedEvent,
  calib: Calibration,
  state: HudState,
  stackOffsetY = 0
) {
  const age = state.eventAge(ev);
  if (age <= 0) return;
  const color = URGENCY_COLOR[ev.urgency];
  // Confidence modulates opacity but never below 65%: a low-confidence event is
  // still a real detection, and scaling straight by confidence (as this did) made
  // anything under ~0.3 — most non-speech — effectively invisible.
  const baseAlpha = age * clamp(0.65 + 0.35 * ev.confidence, 0.65, 1);

  const bearings = ev.ambiguous ? [ev.renderBearing, mirrorBearing(ev.renderBearing)] : [ev.renderBearing];
  bearings.forEach((bearing, i) => {
    // When both ambiguous candidates fall off the same FOV edge they'd
    // otherwise draw on top of each other; offset the second vertically so
    // "two mirrored candidates" stays visually true even then.
    const edgeOffsetY = ev.ambiguous && i === 1 ? 34 : 0;
    drawOneMarker(ctx, size, bearing, calib, color, baseAlpha, ev, ev.ambiguous, edgeOffsetY, stackOffsetY);
  });
}

/**
 * Unlocalized events, as a compact stack of captions instead of markers: the
 * class and confidence are real, the direction is unknown, and saying so is the
 * point. Newest at the bottom, capped so the display cannot become a wall.
 */
function drawUnlocatedList(
  ctx: CanvasRenderingContext2D,
  size: Size,
  events: TrackedEvent[],
  state: HudState
) {
  const MAX_ROWS = 8;
  const rows = events.slice(-MAX_ROWS);
  const hidden = events.length - rows.length;
  const lineH = 22;
  const x = size.w - 14;
  let y = size.h * HORIZON_FRAC - 24;

  ctx.save();
  ctx.font = `bold 15px ${PIXEL_FONT}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  for (let i = rows.length - 1; i >= 0; i--) {
    const ev = rows[i];
    const age = state.eventAge(ev);
    if (age <= 0) continue;
    ctx.globalAlpha = age * clamp(0.65 + 0.35 * ev.confidence, 0.65, 1);
    outlinedText(
      ctx,
      `${ev.class} ${Math.round(ev.confidence * 100)}%`,
      x,
      y,
      URGENCY_COLOR[ev.urgency]
    );
    y -= lineH;
  }
  if (hidden > 0) {
    ctx.globalAlpha = 0.85;
    outlinedText(ctx, `+${hidden} more`, x, y, "#b9cbdd");
  }
  ctx.restore();
}

function drawOneMarker(
  ctx: CanvasRenderingContext2D,
  size: Size,
  bearingDeg: number,
  calib: Calibration,
  color: string,
  alpha: number,
  ev: TrackedEvent,
  ambiguous: boolean,
  edgeOffsetY: number,
  stackOffsetY = 0
) {
  const xNorm = bearingToScreenX(bearingDeg, calib);
  const y = size.h * HORIZON_FRAC - stackOffsetY;
  const edgeY = y + edgeOffsetY;
  const label = `${ev.class} ${Math.round(ev.confidence * 100)}%  ±${Math.round(ev.accuracy_deg)}°`;
  const pulse = ev.urgency === "urgent" ? 1 + 0.15 * Math.sin(performance.now() / 120) : 1;
  const arrowSize = 22 * pulse;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `bold 13px ${PIXEL_FONT}`;

  if (xNorm === null) {
    // Off-FOV: point an arrow at the correct screen edge instead of clamping.
    const normBearing = normalizeDeg(bearingDeg - calib.head_yaw_offset_deg);
    const atRightEdge = normBearing > 0;
    const arrowX = atRightEdge ? size.w - 20 : 20;
    drawArrow(ctx, arrowX, edgeY, atRightEdge ? 0 : Math.PI, arrowSize, color, ambiguous);
    if (ambiguous) drawDashedRing(ctx, arrowX, edgeY, arrowSize * 0.9, color);
    ctx.textAlign = atRightEdge ? "right" : "left";
    ctx.textBaseline = "alphabetic";
    outlinedText(ctx, label, atRightEdge ? size.w - 34 : 34, edgeY - 20, color);
  } else {
    const x = xNorm * size.w;
    drawArrow(ctx, x, y, Math.PI / 2, arrowSize, color, ambiguous);
    if (ambiguous) drawDashedRing(ctx, x, y, arrowSize * 0.9, color);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    outlinedText(ctx, label, x, y - arrowSize - 8, color);
  }
  ctx.restore();
}

/** Subtle dashed ring marking a bearing as one of two ambiguous candidates. */
function drawDashedRing(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string) {
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawUrgentFrame(ctx: CanvasRenderingContext2D, size: Size) {
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 150);
  ctx.save();
  ctx.strokeStyle = URGENCY_COLOR.urgent;
  ctx.lineWidth = 8 + 6 * pulse;
  ctx.globalAlpha = 0.6;
  ctx.strokeRect(4, 4, size.w - 8, size.h - 8);
  ctx.restore();
}

type BubbleStyle = "anchored" | "directional" | "maybePlayback";

const BUBBLE_PALETTE: Record<BubbleStyle, { fill: string; stroke: string; dashed: boolean }> = {
  // Locked onto a real, currently-visible speaking face.
  anchored: { fill: "rgba(20,30,40,0.55)", stroke: URGENCY_COLOR.normal, dashed: false },
  // Speaker isn't in frame (or camera hasn't turned to them yet) -- purely
  // directional, not a claim about what's making the sound.
  directional: { fill: "rgba(20,32,40,0.5)", stroke: "rgba(255,255,255,0.85)", dashed: false },
  // Bearing IS on-screen but no face was found nearby -- the actual
  // person-vs-playback ambiguity (README §6.3 C6).
  maybePlayback: { fill: "rgba(60,20,20,0.55)", stroke: "#ff8a8a", dashed: true },
};

/** Where a bubble wants to point, before any stacking offset -- pulled out
 * of drawSpeechBubble so the caller can pre-compute every active bubble's
 * target position in one pass and detect collisions before drawing any of
 * them (two bubbles landing on the same spot otherwise just draw on top of
 * each other). */
function resolveBubbleTarget(
  size: Size,
  calib: Calibration,
  bearingDeg: number,
  anchor: FaceAnchor | null
): { tipX: number; tipY: number; style: BubbleStyle } {
  if (anchor) {
    return {
      tipX: anchor.face.centerXNorm * size.w,
      tipY: (anchor.face.bboxNorm.y + anchor.face.bboxNorm.h * 0.85) * size.h, // ~mouth height
      style: "anchored",
    };
  }
  const xNorm = bearingToScreenX(bearingDeg, calib);
  const tipY = size.h * HORIZON_FRAC - 46; // clear of that marker's own class/confidence label above it
  if (xNorm !== null) {
    return { tipX: xNorm * size.w, tipY, style: "maybePlayback" };
  }
  const normBearing = normalizeDeg(bearingDeg - calib.head_yaw_offset_deg);
  return { tipX: normBearing > 0 ? size.w - 20 : 20, tipY, style: "directional" };
}

/**
 * Speech bubble that always sits near wherever the sound actually is: right
 * on the speaking face's mouth when anchored, otherwise near that event's own
 * arrow marker (in-frame or off-FOV edge) so turning toward the speaker is
 * what carries the bubble onto their face, not a separate lookup.
 */
function drawSpeechBubble(
  ctx: CanvasRenderingContext2D,
  size: Size,
  text: string,
  bearingDeg: number,
  calib: Calibration,
  anchor: FaceAnchor | null,
  age: number,
  stackOffsetY = 0
) {
  if (age <= 0) return;

  const { tipX, tipY: rawTipY, style } = resolveBubbleTarget(size, calib, bearingDeg, anchor);
  const tipY = rawTipY - stackOffsetY;

  ctx.save();
  ctx.globalAlpha = age;
  ctx.font = `13px ${PIXEL_FONT}`;
  const padding = 8;
  const tailLen = 10;
  const metrics = ctx.measureText(text);
  const bw = metrics.width + padding * 2;
  const bh = 26;
  const bodyX = clamp(tipX - bw / 2, 4, size.w - bw - 4);
  const bodyY = Math.max(4, tipY - tailLen - bh);

  const palette = BUBBLE_PALETTE[style];
  drawTailedBubble(ctx, bodyX, bodyY, bw, bh, tipX, tipY, palette.fill, palette.stroke, palette.dashed);

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  outlinedText(ctx, text, bodyX + padding, bodyY + bh / 2, "#fff", 2.5);

  if (style === "maybePlayback") {
    ctx.font = `10px ${PIXEL_FONT}`;
    ctx.textBaseline = "alphabetic";
    outlinedText(ctx, "no face — playback?", bodyX, bodyY - 4, "#ff8a8a", 2);
  }
  ctx.restore();
}

/** Rounded-rect bubble body with a small triangular tail pointing at (tipX, tipY). */
function drawTailedBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  tipX: number,
  tipY: number,
  fill: string,
  stroke: string,
  dashed: boolean
) {
  const r = 8;
  ctx.save();
  ctx.setLineDash(dashed ? [3, 3] : []);
  ctx.lineWidth = 1.5;
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.stroke();

  const tailBaseX = clamp(tipX, x + r + 4, x + w - r - 4);
  const tailHalf = 7;
  ctx.beginPath();
  ctx.moveTo(tailBaseX - tailHalf, y + h - 1);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(tailBaseX + tailHalf, y + h - 1);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(tailBaseX - tailHalf, y + h - 2);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(tailBaseX + tailHalf, y + h - 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * Face boxes plus a live readout of the numbers the speaker-lock actually
 * decides on (jawOpen score, its recent swing, and which face -- if any --
 * currently holds the lock). Added specifically to stop guessing at
 * mouth-activity thresholds blind: this makes the real per-face numbers
 * visible during a live test instead of only inferring them from bubble
 * behavior after the fact.
 */
function drawFaces(
  ctx: CanvasRenderingContext2D,
  size: Size,
  faces: DetectedFace[],
  lockedSpeakerTrackId: number | null
) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.font = `10px ${PIXEL_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  for (const f of faces) {
    const x = f.bboxNorm.x * size.w;
    const y = f.bboxNorm.y * size.h;
    const w = f.bboxNorm.w * size.w;
    const h = f.bboxNorm.h * size.h;
    const isLocked = f.trackId === lockedSpeakerTrackId;

    ctx.strokeStyle = isLocked ? URGENCY_COLOR.normal : "rgba(255,255,255,0.35)";
    ctx.lineWidth = isLocked ? 2.5 : 1;
    ctx.strokeRect(x, y, w, h);

    if (f.mouthActive) {
      ctx.fillStyle = "#7CFC9A";
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h + 8, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    const label = `#${f.trackId} open:${f.mouthOpenScore.toFixed(2)} rev:${f.mouthActivity}${isLocked ? " SPEAKING" : ""}`;
    outlinedText(ctx, label, x, y - 4, isLocked ? URGENCY_COLOR.normal : "#fff", 2);
  }
  ctx.restore();
}

function drawCompass(ctx: CanvasRenderingContext2D, size: Size, events: TrackedEvent[], calib: Calibration) {
  const y = size.h * COMPASS_Y_FRAC;
  const halfFov = calib.camera_fov_deg / 2;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, y - COMPASS_HEIGHT / 2, size.w, COMPASS_HEIGHT);

  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.font = `10px ${PIXEL_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  for (let deg = -180; deg <= 180; deg += 30) {
    const x = 0.5 * (1 + deg / 180) * size.w;
    const withinFov = Math.abs(deg) <= halfFov;
    ctx.globalAlpha = withinFov ? 0.9 : 0.35;
    ctx.beginPath();
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x, y + 6);
    ctx.stroke();
    outlinedText(ctx, `${deg}°`, x, y + 18, "#fff", 2.5);
  }
  ctx.globalAlpha = 1;

  // Nose marker (0 deg, hat frame, before yaw offset applied to compass mapping below).
  const noseX = 0.5 * (1 - calib.head_yaw_offset_deg / 180) * size.w;
  drawArrow(ctx, noseX, y - COMPASS_HEIGHT / 2 - 8, -Math.PI / 2, 14, URGENCY_COLOR.normal);

  // Event ticks on the full-range strip (this is what makes off-screen events legible).
  for (const ev of events) {
    if (ev.confidence <= 0) continue;
    const bearings = ev.ambiguous ? [ev.renderBearing, mirrorBearing(ev.renderBearing)] : [ev.renderBearing];
    for (const b of bearings) {
      const x = 0.5 * (1 + normalizeDeg(b) / 180) * size.w;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = URGENCY_COLOR[ev.urgency];
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawDebugPanel(ctx: CanvasRenderingContext2D, opts: RenderOptions) {
  const lines: string[] = [];
  const bs = opts.state.backendStatus;
  const as = opts.state.arrayStatus;
  lines.push(`ws: ${opts.wsState}${opts.rttMs !== null ? `  rtt ${opts.rttMs.toFixed(0)}ms` : ""}`);
  lines.push(`mode: ${opts.state.mode}   fps: ${opts.fps.toFixed(0)}`);
  lines.push(`fov: ${opts.calib.camera_fov_deg.toFixed(1)}° (effective, post-crop)`);
  if (opts.addedLatencyMs !== null) lines.push(`added latency: ${opts.addedLatencyMs.toFixed(1)}ms`);
  if (bs) {
    lines.push(`model: ${bs.model} sha:${bs.model_sha256.slice(0, 8)} (${bs.classes} cls)`);
    lines.push(`transport: ${bs.transport}  rev:${bs.git_rev}`);
  } else {
    lines.push("model: (no backend_status yet)");
  }
  if (as) {
    const mics = as.mics.map((m) => `${m.id}:${m.ok ? "ok" : "X"}`).join(" ");
    lines.push(`mics: ${mics}  yaw_off:${as.calibration.head_yaw_offset_deg}°`);
  } else {
    lines.push("mics: (no array_status yet)");
  }

  ctx.save();
  ctx.font = `11px ${PIXEL_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const pad = 6;
  const lineH = 14;
  const top = 40; // clear of the HTML error banner, which overlays the canvas at y=0
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
  const h = lines.length * lineH + pad * 2;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(8, top, w, h);
  lines.forEach((l, i) => outlinedText(ctx, l, 8 + pad, top + pad + lineH * (i + 1) - 3, "#dfffe0", 2));
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
