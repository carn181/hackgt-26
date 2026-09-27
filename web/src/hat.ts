// "Is the ESP32 hat actually there?" -- the hat broadcasts `hat_status` over
// UDP at ~10 Hz and the backend relays every packet it hears, so there is no
// handshake to perform and nothing to open or close: connecting just means
// "start paying attention to those messages," and being connected means
// "they're still arriving." A board that browns out, walks off the Wi-Fi or
// was never powered on looks identical from here (silence), which is why
// the only failure state is a timeout rather than a specific error.
import type { HatDirection, HatStatusMsg } from "./types";

// ~30 missed packets at the hat's 10 Hz: long enough to ride out ordinary
// Wi-Fi broadcast loss (broadcast frames get no link-layer retries), short
// enough that a dead hat is flagged before anyone trusts a stale direction.
const TIMEOUT_S = 3.0;
const POLL_MS = 250;

export type HatConnState = "idle" | "connecting" | "connected" | "timeout";

export interface HatStatus {
  state: HatConnState;
  dir: HatDirection | null;
  loudest: number | null;
  /** The hat's own "is this a real event, or just room noise" gate --
   * `dir` is only meaningful while this is true. */
  active: boolean;
  /** Seconds since the last hat_status message; Infinity if none yet. */
  ageS: number;
}

function nowS(): number {
  return performance.now() / 1000;
}

export class HatTracker {
  status: HatStatus = { state: "idle", dir: null, loudest: null, active: false, ageS: Infinity };
  onStatus: (() => void) | null = null;

  private wanted = false;
  private connectS = 0;
  private lastMsgS: number | null = null;
  private timer: number | null = null;

  connect(): void {
    this.wanted = true;
    this.connectS = nowS();
    // A fresh attempt: don't let a message from before a timeout make the
    // first poll think the hat is still alive.
    this.lastMsgS = null;
    this.status = { state: "connecting", dir: null, loudest: null, active: false, ageS: Infinity };
    if (this.timer === null) this.timer = window.setInterval(() => this.poll(), POLL_MS);
    this.onStatus?.();
  }

  disconnect(): void {
    this.wanted = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.lastMsgS = null;
    this.status = { state: "idle", dir: null, loudest: null, active: false, ageS: Infinity };
    this.onStatus?.();
  }

  ingest(msg: HatStatusMsg, now: number): void {
    // The backend relays the broadcast to every client whether or not anyone
    // pressed the button; not wanting it means not showing it.
    if (!this.wanted) return;
    this.lastMsgS = now;
    this.status = {
      state: "connected",
      dir: msg.dir,
      loudest: msg.loudest,
      active: msg.active,
      ageS: 0,
    };
    this.onStatus?.();
  }

  private poll(): void {
    if (!this.wanted) return;
    const now = nowS();
    const ageS = this.lastMsgS === null ? Infinity : now - this.lastMsgS;
    const sinceS = this.lastMsgS === null ? now - this.connectS : ageS;
    // Stays armed through a timeout, so a hat that comes back (rebooted,
    // rejoined Wi-Fi) flips straight back to connected via ingest().
    const state: HatConnState = sinceS > TIMEOUT_S ? "timeout" : this.status.state;
    const changed = state !== this.status.state;
    this.status = { ...this.status, state, ageS };
    if (changed) this.onStatus?.();
  }
}
