import type { ArrayStatus, BackendStatus, Mode, SoundEvent, SpeechMsg, Urgency } from "./types";

const URGENCY_RANK: Record<Urgency, number> = { low: 0, normal: 1, high: 2, urgent: 3 };
const EVENT_TTL_S = 4.5;
const SPEECH_TTL_S = 6;
const POSITION_LERP_PER_S = 10; // higher = snappier interpolation, lower = smoother

export interface TrackedEvent extends SoundEvent {
  firstSeenT: number;
  lastSeenT: number;
  /** Smoothed bearing used for rendering; chases bearing_deg each frame. */
  renderBearing: number;
}

export interface TrackedSpeech extends SpeechMsg {
  firstSeenT: number;
}

export class HudState {
  events = new Map<string, TrackedEvent>();
  speech = new Map<string, TrackedSpeech>();
  backendStatus: BackendStatus | null = null;
  arrayStatus: ArrayStatus | null = null;
  mode: Mode = "all";

  private clockNow = 0; // seconds, monotonic local clock (performance.now()/1000)

  ingestSoundEvent(ev: SoundEvent, nowS: number) {
    const existing = this.events.get(ev.id);
    this.events.set(ev.id, {
      ...ev,
      firstSeenT: existing?.firstSeenT ?? nowS,
      lastSeenT: nowS,
      renderBearing: existing?.renderBearing ?? ev.bearing_deg,
    });
  }

  ingestSpeech(msg: SpeechMsg, nowS: number) {
    const existing = this.speech.get(msg.id);
    this.speech.set(msg.id, { ...msg, firstSeenT: existing?.firstSeenT ?? nowS });
  }

  ingestBackendStatus(msg: BackendStatus) {
    this.backendStatus = msg;
  }

  ingestArrayStatus(msg: ArrayStatus) {
    this.arrayStatus = msg;
  }

  setMode(mode: Mode) {
    this.mode = mode;
  }

  /** Advance interpolation and drop aged-out events/speech. Call once per render frame. */
  tick(nowS: number, dtS: number) {
    this.clockNow = nowS;
    const lerpT = Math.min(1, POSITION_LERP_PER_S * dtS);

    for (const [id, ev] of this.events) {
      if (nowS - ev.lastSeenT > EVENT_TTL_S) {
        this.events.delete(id);
        continue;
      }
      let delta = ev.bearing_deg - ev.renderBearing;
      // Shortest angular path.
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      ev.renderBearing += delta * lerpT;
    }

    for (const [id, s] of this.speech) {
      if (nowS - s.firstSeenT > SPEECH_TTL_S) {
        this.speech.delete(id);
      }
    }
  }

  /** Age in [0,1], 1 = just arrived, 0 = about to expire. Drives fade-out. */
  eventAge(ev: TrackedEvent): number {
    return Math.max(0, 1 - (this.clockNow - ev.lastSeenT) / EVENT_TTL_S);
  }

  speechAge(s: TrackedSpeech): number {
    return Math.max(0, 1 - (this.clockNow - s.firstSeenT) / SPEECH_TTL_S);
  }

  /** Whether the current mode should render this event at all. */
  passesMode(ev: SoundEvent): boolean {
    if (this.mode === "all") return true;
    if (this.mode === "important") return URGENCY_RANK[ev.urgency] >= URGENCY_RANK.normal;
    if (this.mode === "quiet") return URGENCY_RANK[ev.urgency] >= URGENCY_RANK.high;
    return true;
  }

  hasUrgent(): boolean {
    for (const ev of this.events.values()) {
      if (ev.urgency === "urgent" && this.eventAge(ev) > 0) return true;
    }
    return false;
  }

  visibleEvents(): TrackedEvent[] {
    const urgent = this.hasUrgent();
    const list = [...this.events.values()].filter((ev) => this.passesMode(ev));
    if (!urgent) return list;
    // Urgent event displaces everything else per README §4.5.
    return list.filter((ev) => ev.urgency === "urgent");
  }

  speechForEvent(eventId: string): TrackedSpeech | null {
    let best: TrackedSpeech | null = null;
    for (const s of this.speech.values()) {
      if (s.parent_event === eventId) {
        if (!best || s.firstSeenT > best.firstSeenT) best = s;
      }
    }
    return best;
  }
}
