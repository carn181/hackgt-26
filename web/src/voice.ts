// Hands-free keyword trigger ("connect") via the browser's own speech
// recognizer. The wearer's hands are on a hat and a phone held up as a
// viewfinder, so a spoken word beats a tap -- and this is deliberately a
// tiny keyword spotter, not a transcription path: captions still come from
// the backend's Whisper via mic.ts. The browser recognizer is only good
// enough, and only used, for "did they just say one of these words."

// The Web Speech API's recognition half is real and shipped (Chrome/Edge as
// `webkitSpeechRecognition`, Safari as both names) but isn't in TypeScript's
// bundled DOM lib -- researched, not guessed. Declared here with just the
// fields this file touches, under *Like names so they can't collide with a
// future lib.dom that does add the real ones.
interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}
interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

// One utterance produces a burst of interim results and then a final one,
// all containing the same word; without this the callback fires once per
// result instead of once per time the word was said.
const COOLDOWN_MS = 2500;

export type VoiceState = "off" | "listening" | "unsupported" | "error";

export class VoiceCommandListener {
  state: VoiceState = "off";
  onCommand: ((word: string) => void) | null = null;

  private readonly commands: string[];
  private rec: SpeechRecognitionLike | null = null;
  private cooldownUntilMs = 0;

  constructor(commands: string[]) {
    this.commands = commands.map((c) => c.toLowerCase());
  }

  start(): void {
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      this.state = "unsupported";
      return;
    }
    if (this.state === "listening") return;

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const alt = e.results[i][0];
        if (!alt) continue;
        const text = alt.transcript.toLowerCase();
        for (const word of this.commands) {
          if (!text.includes(word)) continue;
          const nowMs = performance.now();
          if (nowMs < this.cooldownUntilMs) return;
          this.cooldownUntilMs = nowMs + COOLDOWN_MS;
          this.onCommand?.(word);
          return;
        }
      }
    };

    // Browsers end even `continuous` recognition on their own (silence,
    // session length caps); the listener is meant to be always-on, so an end
    // we didn't ask for is just restarted.
    rec.onend = () => {
      if (this.state !== "listening" || this.rec !== rec) return;
      try {
        rec.start();
      } catch (err) {
        this.state = "error";
        console.warn("[voice] restart failed", err);
      }
    };

    rec.onerror = (e) => {
      // Chrome reports a stretch of silence as a "no-speech" error and then
      // ends the session; that's routine for an always-on listener, and
      // onend's restart covers it. Anything else (permission denied, no mic,
      // network for server-side recognizers) won't fix itself by retrying.
      if (e.error === "no-speech") return;
      this.state = "error";
      console.warn("[voice] recognition error:", e.error);
    };

    this.rec = rec;
    this.state = "listening";
    try {
      rec.start();
    } catch (err) {
      this.state = "error";
      this.rec = null;
      console.warn("[voice] start failed", err);
    }
  }

  stop(): void {
    this.state = "off";
    const rec = this.rec;
    this.rec = null;
    rec?.stop();
  }
}
