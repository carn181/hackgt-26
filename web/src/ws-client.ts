import type { BackendMsg, FrontendMsg } from "./types";
import { validateBackendMsg } from "./validate";

export type ConnState = "connecting" | "open" | "closed";

export interface WsClientOptions {
  url: string;
  onMessage: (msg: BackendMsg) => void;
  onStateChange: (state: ConnState) => void;
  onRttSample?: (rttMs: number) => void;
}

const MAX_BACKOFF_MS = 8000;

export class WsClient {
  private ws: WebSocket | null = null;
  private backoffMs = 500;
  private closedByUser = false;
  private pingTimer: number | null = null;
  private pendingPings = new Map<number, number>(); // t sent -> performance.now()
  private opts: WsClientOptions;

  constructor(opts: WsClientOptions) {
    this.opts = opts;
  }

  start() {
    this.closedByUser = false;
    this.connect();
  }

  stop() {
    this.closedByUser = true;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  send(msg: FrontendMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private connect() {
    this.opts.onStateChange("connecting");
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 500;
      this.opts.onStateChange("open");
      this.pingTimer = window.setInterval(() => {
        const t = performance.now() / 1000;
        this.pendingPings.set(t, performance.now());
        this.send({ type: "ping", t });
      }, 2000);
    };

    ws.onmessage = (ev) => {
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data);
      } catch {
        console.warn("[ws] dropped non-JSON message", ev.data);
        return;
      }
      const validated = validateBackendMsg(raw);
      if (!validated) {
        console.warn("[ws] dropped malformed message (missing/wrong-type field)", raw);
        return;
      }
      if (validated.warnings.length) {
        console.warn("[ws] message had issues, defaulted:", validated.warnings, raw);
      }
      const msg = validated.msg;

      if ((msg as any).type === "pong" && this.opts.onRttSample) {
        const echoed = (msg as any).t_echo;
        const sentAt = this.pendingPings.get(echoed);
        if (sentAt !== undefined) {
          this.opts.onRttSample(performance.now() - sentAt);
          this.pendingPings.delete(echoed);
        }
        return;
      }
      this.opts.onMessage(msg);
    };

    ws.onclose = () => {
      this.opts.onStateChange("closed");
      if (this.pingTimer !== null) clearInterval(this.pingTimer);
      if (!this.closedByUser) {
        setTimeout(() => this.connect(), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      }
    };

    ws.onerror = () => {
      // onclose fires right after; reconnect handled there.
    };
  }
}

export function resolveWsUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  // Default goes through the Vite dev proxy (/ws -> 127.0.0.1:8000).
  return params.get("ws") ?? `${proto}//${window.location.host}/ws`;
}
