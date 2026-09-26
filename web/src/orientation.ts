// Phone orientation -> a live head_yaw_offset_deg correction (README §3's
// "phone held in front of the face" caveat: a static calibration constant is
// only accurate to ~15 deg and breaks down the moment the phone moves
// independently of the wearer's head, which it naturally does). This tracks
// how much the phone itself has *rotated since a reference moment* and hands
// that delta to calib.ts's existing bearing math -- every marker, bubble and
// the compass nose-marker already recomputes from `calib` every render
// frame, so feeding in a better head_yaw_offset_deg is the entire mechanism;
// nothing downstream needs to know this exists.
//
// Deliberately a *delta since a reference sample*, never an absolute compass
// heading: this device has no gyroscope to test against, and true-north
// referencing is one more thing (magnetometer calibration) that can't be
// verified here. A delta only needs "did the phone turn, and which way and
// how much," which is far more robust to get right blind.
import { normalizeDeg } from "./calib";

// Per the W3C spec, increasing `alpha` is a *counter-clockwise* turn viewed
// from above the device, but on-device behavior (especially iOS's
// webkitCompassHeading, which runs the opposite direction from alpha) is the
// one thing in this file that couldn't be verified without a real phone.
// Confirmed backwards on first real-device test (turning left produced a
// positive delta; markers need the opposite to pan the correct direction) --
// flipped, as flagged as the one line that should need it.
const ROTATION_SIGN = -1;

const SMOOTHING = 0.25; // higher = more responsive, lower = steadier; EMA weight per sample

export type OrientationState = "off" | "starting" | "running" | "error" | "unsupported";
export type OrientationSource = "webkit-compass" | "absolute" | "relative" | "none";

export interface OrientationStatus {
  state: OrientationState;
  lastError: string;
  source: OrientationSource;
  /** Most recent raw reading, whatever its reference frame -- debug only. */
  rawDeg: number;
  /** Smoothed signed change since the last resetReference(), already sign-
   * corrected and ready to add straight into head_yaw_offset_deg. */
  deltaDeg: number;
}

const RANK: Record<OrientationSource, number> = { none: 0, relative: 1, absolute: 2, "webkit-compass": 3 };

export class OrientationTracker {
  status: OrientationStatus = { state: "off", lastError: "", source: "none", rawDeg: 0, deltaDeg: 0 };
  onStatus?: () => void;

  private referenceDeg: number | null = null;
  private smoothedDelta = 0;
  private onOrientation = (e: DeviceOrientationEvent, presumedAbsolute: boolean) => {
    const webkitHeading = (e as unknown as { webkitCompassHeading?: number }).webkitCompassHeading;
    let value: number | null = null;
    let source: OrientationSource = "none";
    if (typeof webkitHeading === "number" && !Number.isNaN(webkitHeading)) {
      value = webkitHeading;
      source = "webkit-compass";
    } else if (e.alpha !== null) {
      value = e.alpha;
      source = e.absolute || presumedAbsolute ? "absolute" : "relative";
    }
    if (value === null || RANK[source] < RANK[this.status.source]) return;

    if (this.referenceDeg === null) this.referenceDeg = value;
    const rawDelta = ROTATION_SIGN * normalizeDeg(value - this.referenceDeg);
    this.smoothedDelta += (rawDelta - this.smoothedDelta) * SMOOTHING;

    this.status = {
      state: "running",
      lastError: "",
      source,
      rawDeg: value,
      deltaDeg: this.smoothedDelta,
    };
    this.onStatus?.();
  };
  private onAbsoluteEvent = (e: Event) => this.onOrientation(e as DeviceOrientationEvent, true);
  private onRelativeEvent = (e: Event) => this.onOrientation(e as DeviceOrientationEvent, false);

  async start(): Promise<void> {
    if (typeof DeviceOrientationEvent === "undefined") {
      this.status = { ...this.status, state: "unsupported", lastError: "no orientation sensor on this device" };
      this.onStatus?.();
      return;
    }
    this.status = { ...this.status, state: "starting" };
    this.onStatus?.();

    const requestPermission = (
      DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<"granted" | "denied"> }
    ).requestPermission;
    if (typeof requestPermission === "function") {
      try {
        const result = await requestPermission();
        if (result !== "granted") {
          this.status = { ...this.status, state: "error", lastError: "permission denied" };
          this.onStatus?.();
          return;
        }
      } catch (err) {
        this.status = { ...this.status, state: "error", lastError: String(err) };
        this.onStatus?.();
        return;
      }
    }

    this.referenceDeg = null;
    this.smoothedDelta = 0;
    window.addEventListener("deviceorientationabsolute", this.onAbsoluteEvent);
    window.addEventListener("deviceorientation", this.onRelativeEvent);
    // If nothing fires at all (sensor exists per feature-detect but is
    // dead/blocked), surface that rather than silently staying at delta 0.
    setTimeout(() => {
      if (this.status.state === "starting") {
        this.status = { ...this.status, state: "error", lastError: "no orientation events received" };
        this.onStatus?.();
      }
    }, 3000);
  }

  stop(): void {
    window.removeEventListener("deviceorientationabsolute", this.onAbsoluteEvent);
    window.removeEventListener("deviceorientation", this.onRelativeEvent);
    this.status = { state: "off", lastError: "", source: "none", rawDeg: 0, deltaDeg: 0 };
    this.onStatus?.();
  }

  /** Re-anchor to zero at the current reading -- call whenever a fresh
   * array_status establishes a new known-good head_yaw_offset_deg, so this
   * only contributes rotation *since* that calibration moment. */
  resetReference(): void {
    this.referenceDeg = this.status.rawDeg;
    this.smoothedDelta = 0;
  }

  yawDeltaDeg(): number {
    return this.status.state === "running" ? this.status.deltaDeg : 0;
  }
}
