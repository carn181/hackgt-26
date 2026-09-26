import type { Calibration, Urgency } from "./types";
import { bearingToScreenX, mirrorBearing, normalizeDeg } from "./calib";
import type { HudState, TrackedEvent } from "./state";
import type { DetectedFace } from "./faces";
import type { ConnState } from "./ws-client";

const URGENCY_COLOR: Record<Urgency, string> = {
  low: "#8aa0b4",
  normal: "#4fd1ff",
  high: "#ffb454",
  urgent: "#ff3b3b",
};

const HORIZON_FRAC = 0.45; // vertical position for in-frame markers
const COMPASS_Y_FRAC = 0.93;
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

  drawFaces(ctx, size, opts.faces);

  const urgent = state.hasUrgent();
  if (urgent) drawUrgentFrame(ctx, size);

  const visible = state.visibleEvents();
  const visibleIds = new Set(visible.map((ev) => ev.id));
  for (const ev of visible) {
    drawEventMarker(ctx, size, ev, calib, state);
  }

  for (const [speechId, s] of state.speech) {
    if (!visibleIds.has(s.parent_event)) continue;
    const ev = state.events.get(s.parent_event);
    const anchor = opts.faceAnchors.get(speechId) ?? null;
    drawSpeechBubble(ctx, size, s.text, ev?.renderBearing ?? s.bearing_deg, calib, anchor, state.speechAge(s));
  }

  drawCompass(ctx, size, visible, calib);
  drawDebugPanel(ctx, opts);
}

function drawEventMarker(
  ctx: CanvasRenderingContext2D,
  size: Size,
  ev: TrackedEvent,
  calib: Calibration,
  state: HudState
) {
  const age = state.eventAge(ev);
  if (age <= 0) return;
  const color = URGENCY_COLOR[ev.urgency];
  const baseAlpha = age * clamp(ev.confidence, 0.2, 1);

  const bearings = ev.ambiguous ? [ev.renderBearing, mirrorBearing(ev.renderBearing)] : [ev.renderBearing];
  bearings.forEach((bearing, i) => {
    // When both ambiguous candidates fall off the same FOV edge they'd
    // otherwise draw on top of each other; offset the second vertically so
    // "two mirrored candidates" stays visually true even then.
    const edgeOffsetY = ev.ambiguous && i === 1 ? 34 : 0;
    drawOneMarker(ctx, size, bearing, calib, color, baseAlpha, ev, ev.ambiguous, edgeOffsetY);
  });
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
  edgeOffsetY: number
) {
  const xNorm = bearingToScreenX(bearingDeg, calib);
  const y = size.h * HORIZON_FRAC;
  const edgeY = y + edgeOffsetY;
  const label = `${ev.class} ${Math.round(ev.confidence * 100)}%  ±${Math.round(ev.accuracy_deg)}°`;
  const pulse = ev.urgency === "urgent" ? 1 + 0.15 * Math.sin(performance.now() / 120) : 1;
  const radius = 10 * pulse;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = ambiguous ? 1.5 : 2;
  if (ambiguous) ctx.setLineDash([4, 4]);

  if (xNorm === null) {
    // Off-FOV: draw a chevron at the correct screen edge instead of clamping.
    const normBearing = normalizeDeg(bearingDeg - calib.head_yaw_offset_deg);
    const atRightEdge = normBearing > 0;
    drawChevron(ctx, atRightEdge ? size.w - 18 : 18, edgeY, atRightEdge, color);
    ctx.font = "12px monospace";
    ctx.textAlign = atRightEdge ? "right" : "left";
    ctx.fillText(label, atRightEdge ? size.w - 26 : 26, edgeY - 16);
  } else {
    const x = xNorm * size.w;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "12px monospace";
    ctx.textAlign = "center";
    ctx.fillText(label, x, y - radius - 6);
  }
  ctx.restore();
}

function drawChevron(ctx: CanvasRenderingContext2D, x: number, y: number, pointRight: boolean, color: string) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  const dir = pointRight ? 1 : -1;
  ctx.moveTo(x + dir * 10, y);
  ctx.lineTo(x - dir * 6, y - 10);
  ctx.lineTo(x - dir * 6, y + 10);
  ctx.closePath();
  ctx.fill();
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

function drawSpeechBubble(
  ctx: CanvasRenderingContext2D,
  size: Size,
  text: string,
  bearingDeg: number,
  calib: Calibration,
  anchor: FaceAnchor | null,
  age: number
) {
  if (age <= 0) return;
  const xNorm = bearingToScreenX(bearingDeg, calib);
  const px = anchor ? anchor.face.centerXNorm * size.w : xNorm !== null ? xNorm * size.w : null;
  if (px === null) return; // off-frame speech with no face: skip bubble, marker chevron already shown
  const py = anchor ? anchor.face.bboxNorm.y * size.h - 14 : size.h * HORIZON_FRAC - 40;

  ctx.save();
  ctx.globalAlpha = age;
  ctx.font = "13px sans-serif";
  const noFace = !anchor;
  const padding = 8;
  const metrics = ctx.measureText(text);
  const w = metrics.width + padding * 2;
  const h = 26;
  const x = clamp(px - w / 2, 4, size.w - w - 4);
  const y = Math.max(4, py - h);

  ctx.fillStyle = noFace ? "rgba(60,20,20,0.85)" : "rgba(20,30,40,0.85)";
  ctx.strokeStyle = noFace ? "#ff8a8a" : "#4fd1ff";
  ctx.lineWidth = 1.5;
  if (noFace) ctx.setLineDash([3, 3]);
  roundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + padding, y + h / 2);

  if (noFace) {
    ctx.font = "10px monospace";
    ctx.fillStyle = "#ff8a8a";
    ctx.fillText("no face — playback?", x, y - 4);
  }
  ctx.restore();
}

function drawFaces(ctx: CanvasRenderingContext2D, size: Size, faces: DetectedFace[]) {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  for (const f of faces) {
    const x = f.bboxNorm.x * size.w;
    const y = f.bboxNorm.y * size.h;
    const w = f.bboxNorm.w * size.w;
    const h = f.bboxNorm.h * size.h;
    ctx.strokeRect(x, y, w, h);
    if (f.mouthOpen) {
      ctx.fillStyle = "#7CFC9A";
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h + 8, 3, 0, Math.PI * 2);
      ctx.fill();
    }
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
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  for (let deg = -180; deg <= 180; deg += 30) {
    const x = 0.5 * (1 + deg / 180) * size.w;
    const withinFov = Math.abs(deg) <= halfFov;
    ctx.globalAlpha = withinFov ? 0.9 : 0.35;
    ctx.beginPath();
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x, y + 6);
    ctx.stroke();
    ctx.fillText(`${deg}°`, x, y + 18);
  }
  ctx.globalAlpha = 1;

  // Nose marker (0 deg, hat frame, before yaw offset applied to compass mapping below).
  const noseX = 0.5 * (1 - calib.head_yaw_offset_deg / 180) * size.w;
  ctx.fillStyle = "#4fd1ff";
  ctx.beginPath();
  ctx.moveTo(noseX, y - COMPASS_HEIGHT / 2 - 2);
  ctx.lineTo(noseX - 5, y - COMPASS_HEIGHT / 2 - 10);
  ctx.lineTo(noseX + 5, y - COMPASS_HEIGHT / 2 - 10);
  ctx.closePath();
  ctx.fill();

  // Event ticks on the full-range strip (this is what makes off-screen events legible).
  for (const ev of events) {
    if (ev.confidence <= 0) continue;
    const bearings = ev.ambiguous ? [ev.renderBearing, mirrorBearing(ev.renderBearing)] : [ev.renderBearing];
    for (const b of bearings) {
      const x = 0.5 * (1 + normalizeDeg(b) / 180) * size.w;
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
  ctx.font = "11px monospace";
  const pad = 6;
  const lineH = 14;
  const top = 40; // clear of the HTML error banner, which overlays the canvas at y=0
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
  const h = lines.length * lineH + pad * 2;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(8, top, w, h);
  ctx.fillStyle = "#dfffe0";
  lines.forEach((l, i) => ctx.fillText(l, 8 + pad, top + pad + lineH * (i + 1) - 3));
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
