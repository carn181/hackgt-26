// AudioWorklet tap for the HUD's microphone (README §4.6 `audio`).
//
// Emits one 320-sample (20 ms) mono float32 chunk at a time, which is exactly one
// backend frame at 16 kHz — the AudioContext is created at that rate, so nothing
// resamples and no anti-alias filter of ours can smear a clap's high-frequency
// snap. The node's own output is left silent and it is connected to the
// destination only so the graph keeps pulling it.

const CHUNK = 320;

class MicTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(CHUNK);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === CHUNK) {
          const out = this.buf;
          this.buf = new Float32Array(CHUNK);
          this.n = 0;
          this.port.postMessage(out, [out.buffer]);
        }
      }
    }
    return true; // keep the processor alive even while the mic is silent
  }
}

registerProcessor('mic-tap', MicTap);
