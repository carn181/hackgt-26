import type { BackendMsg } from "./types";

// Lightweight, no-schema-library guard against a real (still-in-development)
// backend sending malformed messages -- a missing/wrong-typed field a few
// layers down (e.g. render.ts's `bs.model_sha256.slice(...)`) would otherwise
// throw mid-frame and kill the render loop. Rejects anything missing a field
// its own downstream code actually dereferences; defaults the rest so a
// slightly-off message still renders instead of vanishing entirely.

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isStr(v: unknown): v is string {
  return typeof v === "string";
}

const URGENCIES = new Set(["low", "normal", "high", "urgent"]);
const HAT_DIRS = new Set(["LEFT", "RIGHT", "FRONT", "BACK"]);

export interface ValidationResult {
  msg: BackendMsg;
  warnings: string[];
}

/** Returns null (and the caller should drop the message) when a field its
 * own handler actually reads is missing or the wrong type; otherwise
 * returns the message with any other loose fields defaulted, plus a list of
 * what was defaulted (for a console.warn, not user-facing). */
export function validateBackendMsg(raw: unknown): ValidationResult | null {
  if (!isObj(raw) || !isStr(raw.type)) return null;
  const warnings: string[] = [];

  switch (raw.type) {
    case "sound_event": {
      if (!isStr(raw.id) || !isStr(raw.class) || !isNum(raw.bearing_deg)) return null;
      if (!isNum(raw.confidence)) {
        raw.confidence = 0;
        warnings.push("confidence missing/invalid -> 0");
      }
      if (!isNum(raw.accuracy_deg)) {
        raw.accuracy_deg = 999;
        warnings.push("accuracy_deg missing/invalid -> 999");
      }
      if (typeof raw.ambiguous !== "boolean") raw.ambiguous = false;
      if (!URGENCIES.has(raw.urgency as string)) raw.urgency = "normal";
      if (raw.elevation_deg !== null && !isNum(raw.elevation_deg)) raw.elevation_deg = null;
      if (!isStr(raw.source)) raw.source = "unknown";
      return { msg: raw as unknown as BackendMsg, warnings };
    }
    case "speech": {
      if (!isStr(raw.id) || !isStr(raw.parent_event) || !isNum(raw.bearing_deg) || !isStr(raw.text)) return null;
      if (!isNum(raw.confidence)) raw.confidence = 0;
      if (typeof raw.partial !== "boolean") raw.partial = false;
      return { msg: raw as unknown as BackendMsg, warnings };
    }
    case "array_status": {
      if (!Array.isArray(raw.mics) || !isObj(raw.calibration)) return null;
      const c = raw.calibration;
      if (!isNum(c.camera_fov_deg) || !isNum(c.head_yaw_offset_deg)) return null;
      if (!isNum(c.baseline_m)) c.baseline_m = 0;
      if (!isNum(c.spacing_m)) c.spacing_m = 0;
      if (!isNum(c.audio_delay_ms)) c.audio_delay_ms = 0;
      return { msg: raw as unknown as BackendMsg, warnings };
    }
    case "backend_status": {
      if (!isStr(raw.model_sha256)) {
        raw.model_sha256 = "unknown";
        warnings.push("model_sha256 missing -> 'unknown'");
      }
      if (!isStr(raw.model)) raw.model = "unknown";
      if (!isStr(raw.transport)) raw.transport = "unknown";
      if (!isStr(raw.git_rev)) raw.git_rev = "unknown";
      if (!isNum(raw.classes)) raw.classes = 0;
      if (!isNum(raw.sample_rate)) raw.sample_rate = 0;
      return { msg: raw as unknown as BackendMsg, warnings };
    }
    case "timeline": {
      if (!Array.isArray(raw.events)) return null;
      return { msg: raw as unknown as BackendMsg, warnings };
    }
    case "presence": {
      if (typeof raw.human !== "boolean") raw.human = false;
      if (!isStr(raw.source)) raw.source = "unknown";
      return { msg: raw as unknown as BackendMsg, warnings };
    }
    case "pong": {
      if (!isNum(raw.t_echo)) return null;
      return { msg: raw as unknown as BackendMsg, warnings };
    }
    case "hat_status": {
      if (!isNum(raw.m1) || !isNum(raw.m2) || !isNum(raw.m3) || !isNum(raw.m4) || !isNum(raw.loudest)) return null;
      if (!HAT_DIRS.has(raw.dir as string)) {
        warnings.push(`dir ${JSON.stringify(raw.dir)} invalid -> 'LEFT'`);
        raw.dir = "LEFT";
      }
      if (!isNum(raw.t_ms)) raw.t_ms = 0;
      if (typeof raw.active !== "boolean") raw.active = false;
      if (!isStr(raw.fw)) raw.fw = "unknown";
      return { msg: raw as unknown as BackendMsg, warnings };
    }
    default:
      return null;
  }
}
