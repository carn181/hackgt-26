# ESP32-S3 hat firmware (debug build)

Single Arduino sketch: [`hackgt_hat/hackgt_hat.ino`](hackgt_hat/hackgt_hat.ino). Flash it with
the Arduino IDE (setup instructions are in the sketch's header comment) -- no PlatformIO, no
extra libraries to install beyond the built-in ESP32 board package (current/default version,
3.x -- the sketch uses the modern `driver/i2s_std.h` API, not the old legacy I2S driver).

This supersedes the earlier raw-audio-streaming design: the mic quality isn't good enough and
4 channels of 16 kHz audio is too much data to push over WiFi/serial for what we actually need
right now. Instead, **the hat does the direction-finding itself** and only reports a small
result.

## WiFi network: use a phone hotspot

Point the sketch's `WIFI_SSID`/`WIFI_PASS` at a **phone's mobile hotspot**, not venue/home WiFi.
Venue/home networks commonly either isolate clients from each other (the ESP32 joins fine, but
its UDP broadcast never reaches anyone else) or sit behind a captive portal the ESP32 can't
click through -- both look like "it's just not connecting" from the outside. A phone hotspot has
neither problem and is always 2.4 GHz (the ESP32 can't join a 5 GHz-only network at all).

**Everything needs to be on that same hotspot**: the ESP32, the laptop running
`server/main.py`, and whichever phone/laptop has the web app open.

## Wiring

| Mic | Position | Bus | L/R | SEL | DOUT shared with |
|---|---|---|---|---|---|
| MIC1 | left  | I2S0 (bus 0) | L | GND  | MIC2 |
| MIC2 | right | I2S0 (bus 0) | R | 3.3V | MIC1 |
| MIC3 | front | I2S1 (bus 1) | L | GND  | MIC4 |
| MIC4 | back  | I2S1 (bus 1) | R | 3.3V | MIC3 |

I2S0 (GPIO7 BCLK, GPIO8 WS, GPIO9 DIN) is the clock master; those same BCLK/WS lines are
physically looped back (7->5, 8->4) into I2S1 (GPIO5 BCLK, GPIO4 WS, GPIO6 DIN) so bus 1 stays
sample-locked to bus 0 instead of running its own free clock. 3.3V logic only on every mic pin.
Never tie all four DOUT lines together -- only MIC1+MIC2 share GPIO9, only MIC3+MIC4 share GPIO6.

## What it sends

**Serial (USB-CDC, 115200 baud):** a human-readable line at ~10 Hz --

```
m1=812 m2=45 m3=120 m4=58  loudest=M1  dir=LEFT  floor=22  active=1
```

This is what you watch in the Arduino IDE's Serial Monitor to confirm the mics are alive.

**WiFi (UDP broadcast, port 7010, ~10 Hz):** the same info as JSON, broadcast to the whole LAN
(no backend IP needs to be configured):

```json
{"type":"hat_status","t_ms":123456,"m1":812,"m2":45,"m3":120,"m4":58,"loudest":1,"dir":"LEFT","active":true,"floor":22,"fw":"hat-simple-0.1"}
```

- `m1`..`m4`: RMS amplitude (raw LSB units) for MIC1(left)/MIC2(right)/MIC3(front)/MIC4(back).
- `loudest`: 1-4, index of the loudest mic this window.
- `dir`: `"LEFT" | "RIGHT" | "FRONT" | "BACK"` -- coarse heuristic (biggest imbalance between the
  left/right pair vs. the front/back pair), not true TDOA. Good enough to point someone roughly
  the right way while debugging.
- `active`: **the important one.** The mics' own self-noise reads ~20 in a quiet room, so `dir`
  is updating constantly even when nothing is happening -- it's just noise chasing noise. `active`
  is true only when the loudest mic spikes well above a slow-moving baseline (talking/clapping
  reads 800+ in testing, ~40x the quiet-room baseline). Treat `dir` as meaningful ("someone is
  calling") only while `active` is true; ignore it otherwise. See `RISE_RATIO`/`RELEASE_RATIO`/
  `HANG_MS` near the top of the `.ino` to retune -- for the demo, err on the loud side (a real
  clap/shout, not a conversational tone) so it triggers reliably.
- `floor`: the current baseline the hat is comparing against -- handy for watching it settle in
  the Serial Monitor while tuning.
- `t_ms`: the hat's own `millis()` at send time.

Any laptop or phone on the same hotspot can pick this up. The project's backend
(`server/main.py`) listens for it and relays it to the web app over the existing WebSocket as a
`hat_status` message. The web app's "connect" button shows `hat: listening` while connected but
quiet, and only shows a direction (`hat: LEFT` etc.) while `active` is true.

## Known limits (intentional, for now)

- No raw audio leaves the hat -- direction-finding happens on-device. Speech-to-text uses the
  laptop/phone's own microphone in the web app instead of these 4 mics.
- No WS2812/PIR/sonar handling -- nothing is wired for those yet.
- The broadcast address is computed from the hat's own IP + subnet mask, so it assumes a normal
  /24 network (a phone hotspot is). If a laptop/phone isn't seeing packets, double-check it's
  actually joined the same hotspot and not still on its previous WiFi.
