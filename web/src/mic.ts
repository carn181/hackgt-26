// Browser microphone → backend (README §4.6 `audio`).
//
// Why the HUD can be the microphone: the phone in the human's pocket is a better
// sensor than this laptop's DMIC pair, and it is nowhere near the chassis — a clap
// reaches it as airborne sound instead of a structural thump, which is what made
// a clap classify as a low-frequency event. It cannot give a bearing (one capsule
// is not an array), so the camera keeps supplying that.
//
// Processing is switched OFF deliberately (`echoCancellation`, `noiseSuppression`,
// `autoGainControl`): those are tuned for phone calls, and AGC in particular would
// rewrite the levels every measurement depends on.

const TARGET_RATE = 16000;
const CHUNK = 320; // 20 ms at 16 kHz — one backend frame

export type MicState = 'off' | 'starting' | 'running' | 'error';

export interface MicStatus {
  state: MicState
  lastError: string
  /** Frames handed to the socket. */
  frames: number
  /** Audio seconds actually sent. */
  seconds: number
  /** The rate the graph really runs at (16000 when the browser honoured the request). */
  sampleRate: number
  deviceLabel: string
}

export type MicSink = (base64: string, seq: number, rate: number, channels: number) => void

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

/** Linear-interpolation resampler, used only if the graph refuses 16 kHz. */
class Resampler {
  private pos = 0
  private tail = new Float32Array(0)
  private readonly ratio: number

  constructor(ratio: number) {
    this.ratio = ratio
  }

  push(input: Float32Array): Float32Array[] {
    const buf = new Float32Array(this.tail.length + input.length)
    buf.set(this.tail, 0)
    buf.set(input, this.tail.length)
    const out: Float32Array[] = []
    let pos = this.pos
    while (pos + 1 < buf.length) {
      const acc = new Float32Array(CHUNK)
      let k = 0
      let p = pos
      while (k < CHUNK && p + 1 < buf.length) {
        const j = Math.floor(p)
        acc[k++] = buf[j] * (1 - (p - j)) + buf[j + 1] * (p - j)
        p += this.ratio
      }
      if (k < CHUNK) break
      out.push(acc)
      pos = p
    }
    const consumed = Math.floor(pos)
    this.tail = buf.slice(consumed)
    this.pos = pos - consumed
    return out
  }
}

export class MicStream {
  status: MicStatus = {
    state: 'off',
    lastError: '',
    frames: 0,
    seconds: 0,
    sampleRate: 0,
    deviceLabel: '',
  }
  onStatus: (status: MicStatus) => void = () => {}

  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private sink: MicSink | null = null
  private seq = 0
  private resampler: Resampler | null = null

  async start(sink: MicSink): Promise<void> {
    if (this.status.state === 'running' || this.status.state === 'starting') return
    this.sink = sink
    this.setStatus({ state: 'starting', lastError: '' })
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable (needs a secure context)')
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      // Ask for 16 kHz: the browser's own resampler is anti-aliased, ours would
      // not be, and the pipeline is 16 kHz end to end.
      let ctx: AudioContext
      try {
        ctx = new AudioContext({ sampleRate: TARGET_RATE })
      } catch {
        ctx = new AudioContext()
      }
      this.ctx = ctx
      await ctx.audioWorklet.addModule('/mic-worklet.js')
      this.source = ctx.createMediaStreamSource(this.stream)
      this.node = new AudioWorkletNode(ctx, 'mic-tap')
      this.node.port.onmessage = (event: MessageEvent) => this.onChunk(event.data as Float32Array)
      this.source.connect(this.node)
      this.node.connect(ctx.destination) // silent: the processor writes no output
      if (Math.abs(ctx.sampleRate - TARGET_RATE) > 1) {
        this.resampler = new Resampler(ctx.sampleRate / TARGET_RATE)
      }
      const track = this.stream.getAudioTracks()[0]
      this.setStatus({
        state: 'running',
        sampleRate: ctx.sampleRate,
        deviceLabel: track?.label ?? '',
      })
    } catch (err) {
      this.setStatus({ state: 'error', lastError: err instanceof Error ? err.message : String(err) })
    }
  }

  stop(): void {
    this.node?.port.close()
    this.node?.disconnect()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close()
    this.ctx = null
    this.node = null
    this.source = null
    this.stream = null
    this.resampler = null
    this.setStatus({ state: 'off' })
  }

  private onChunk(chunk: Float32Array): void {
    const frames = this.resampler ? this.resampler.push(chunk) : [chunk]
    for (const frame of frames) this.sendFrame(frame)
  }

  private sendFrame(frame: Float32Array): void {
    if (!this.sink) return
    const pcm = new Int16Array(frame.length)
    for (let i = 0; i < frame.length; i++) {
      const v = Math.max(-1, Math.min(1, frame[i]))
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff
    }
    this.sink(toBase64(new Uint8Array(pcm.buffer)), this.seq++, TARGET_RATE, 1)
    this.setStatus({
      frames: this.status.frames + 1,
      seconds: this.status.seconds + frame.length / TARGET_RATE,
    })
  }

  private setStatus(patch: Partial<MicStatus>): void {
    this.status = { ...this.status, ...patch }
    this.onStatus(this.status)
  }
}
