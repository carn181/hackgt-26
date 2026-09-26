// Backend WebSocket client: reconnect with capped backoff, `?ws=` override,
// 1 Hz `ping` for the latency measurement, and typed ingest of the §4.5 stream.
// Sends only §4.6 messages (`set_mode`, `ping`).

import type { BackendMsg, ClientMsg, Mode } from './types'

export type ConnState = 'connecting' | 'open' | 'closed' | 'blocked' | 'error'

export interface WsStatus {
  state: ConnState
  url: string
  attempt: number
  nextRetryMs: number
  lastOpenedAt: number | null
  received: number
  unknownTypes: number
  malformed: number
  lastError: string
  /** Round-trip time of the last echoed `ping`, ms. */
  latencyMs: number | null
  /** Median of the recent round-trip samples, ms. */
  latencyMedianMs: number | null
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000]

export function resolveWsUrl(override: string | null): { url: string; blockedReason: string } {
  const https = location.protocol === 'https:'
  if (override) {
    if (https && /^ws:\/\//i.test(override)) {
      // Browsers block insecure WebSockets from a secure page — say so instead of
      // failing silently, and point at the same-origin proxy.
      return {
        url: override,
        blockedReason:
          `Insecure ws:// override is blocked from an https:// page (mixed content). ` +
          `Use the same-origin secure proxy instead: wss://${location.host}/ws`,
      }
    }
    return { url: override, blockedReason: '' }
  }
  if (https) return { url: `wss://${location.host}/ws`, blockedReason: '' }
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return { url: 'ws://127.0.0.1:8000/ws', blockedReason: '' }
  }
  // LAN over plain http (phone against Vite on the laptop): same-origin proxy.
  return { url: `ws://${location.host}/ws`, blockedReason: '' }
}

export class WsClient {
  readonly url: string
  status: WsStatus
  onMessage: (msg: BackendMsg) => void = () => {}
  onStatus: (status: WsStatus) => void = () => {}

  private socket: WebSocket | null = null
  private retryTimer: number | null = null
  private pingTimer: number | null = null
  private latencySamples: number[] = []
  private closedByUs = false

  constructor(url: string, blockedReason = '') {
    this.url = url
    this.status = {
      state: blockedReason ? 'blocked' : 'closed',
      url,
      attempt: 0,
      nextRetryMs: 0,
      lastOpenedAt: null,
      received: 0,
      unknownTypes: 0,
      malformed: 0,
      lastError: blockedReason,
      latencyMs: null,
      latencyMedianMs: null,
    }
  }

  connect(): void {
    if (this.status.state === 'blocked') return
    this.closedByUs = false
    this.clearRetry()
    this.setStatus({ state: this.status.attempt === 0 ? 'connecting' : this.status.state })

    let socket: WebSocket
    try {
      socket = new WebSocket(this.url)
    } catch (err) {
      this.fail(`cannot open ${this.url}: ${(err as Error).message}`)
      return
    }
    this.socket = socket

    socket.onopen = () => {
      this.status.attempt = 0
      this.setStatus({ state: 'open', nextRetryMs: 0, lastOpenedAt: performance.now(), lastError: '' })
      this.startPing()
    }

    socket.onmessage = (event) => {
      this.handleRaw(event.data)
    }

    socket.onerror = () => {
      // The close handler owns reconnection; a bare error usually precedes it.
    }

    socket.onclose = () => {
      this.stopPing()
      this.socket = null
      if (this.closedByUs) {
        this.setStatus({ state: 'closed' })
        return
      }
      this.scheduleRetry()
    }
  }

  /** §4.6 `set_mode`. */
  setMode(mode: Mode): void {
    this.raw({ type: 'set_mode', mode })
  }

  /** §4.6 `ping` with the caller's `performance.now() / 1000` stamp. */
  ping(t: number): void {
    this.raw({ type: 'ping', t })
  }

  private raw(msg: ClientMsg): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(msg))
  }

  close(): void {
    this.closedByUs = true
    this.clearRetry()
    this.stopPing()
    this.socket?.close()
    this.socket = null
  }

  private handleRaw(data: unknown): void {
    if (typeof data !== 'string') {
      this.setStatus({ malformed: this.status.malformed + 1, lastError: 'non-text frame ignored' })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      this.setStatus({ malformed: this.status.malformed + 1, lastError: `malformed JSON: ${data.slice(0, 120)}` })
      return
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { type?: unknown }).type !== 'string') {
      this.setStatus({ malformed: this.status.malformed + 1, lastError: `payload without type: ${data.slice(0, 120)}` })
      return
    }
    const raw = parsed as { type: string; t?: unknown }

    // The backend may echo our ping payload; that echo is only used for latency,
    // never as a new contract field (README §4.6).
    if (raw.type === 'ping') {
      if (typeof raw.t === 'number') this.recordLatency((performance.now() / 1000 - raw.t) * 1000)
      return
    }

    const known = ['sound_event', 'speech', 'presence', 'array_status', 'backend_status', 'timeline']
    if (!known.includes(raw.type)) {
      this.setStatus({ unknownTypes: this.status.unknownTypes + 1 })
      return
    }
    const msg = parsed as BackendMsg
    if (typeof msg.t !== 'number' || !Number.isFinite(msg.t)) {
      this.setStatus({ malformed: this.status.malformed + 1, lastError: `${msg.type} without numeric t` })
      return
    }
    this.setStatus({ received: this.status.received + 1 })
    this.onMessage(msg as BackendMsg)
  }

  private recordLatency(rttMs: number): void {
    this.latencySamples.push(rttMs)
    if (this.latencySamples.length > 60) this.latencySamples.shift()
    const sorted = [...this.latencySamples].sort((a, b) => a - b)
    this.setStatus({ latencyMs: rttMs, latencyMedianMs: sorted[Math.floor(sorted.length / 2)] })
  }

  private startPing(): void {
    this.stopPing()
    // §4.6: ping carries `t = performance.now() / 1000`; the echoed value is the
    // measurement path required by the prompt's < 50 ms added-latency criterion.
    this.pingTimer = window.setInterval(() => this.ping(performance.now() / 1000), 1000)
    this.ping(performance.now() / 1000)
  }

  private stopPing(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private scheduleRetry(): void {
    const delay = BACKOFF_MS[Math.min(this.status.attempt, BACKOFF_MS.length - 1)]
    this.status.attempt += 1
    this.setStatus({ state: 'closed', nextRetryMs: delay })
    this.clearRetry()
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private fail(message: string): void {
    this.setStatus({ state: 'error', lastError: message })
    this.scheduleRetry()
  }

  private setStatus(patch: Partial<WsStatus>): void {
    this.status = { ...this.status, ...patch }
    this.onStatus(this.status)
  }
}
