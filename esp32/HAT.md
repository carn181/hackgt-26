# esp32/HAT.md — 4-mic capture, live monitoring, wiring map

Owner: **A**. This is the working state of the hat firmware: four ICS-43434 mics on two I2S buses,
streamed over Wi-Fi to a phone browser that can meter, listen to and record all four channels live.

| File | What it is |
|---|---|
| `esp32/aura4/aura4.ino` | Firmware: 2 I2S buses, §4.2 framing on WebSocket `:81`, HTTP `:80`, serial RMS |
| `esp32/aura4/page.h` | The phone app (single page, no build step), served by the hat |
| `esp32/tools/mock_hat.py` | Dev twin: serves the same page and synthesizes 4-channel audio, no hardware needed |

## 1. Wiring map

Two mics per bus; both mics on a bus share BCLK/LRCLK/DOUT and differ only in `SEL`.

| Bus | Signal | ESP32-S3 pin (TinyS3 header) | Mic ids |
|---|---|---|---|
| 0 | BCLK | **7** | |
| 0 | LRCLK (`WS`) | **8** | |
| 0 | DOUT (`DIN`) | **9** | m0 (`SEL`→GND, left), m1 (`SEL`→3V3, right) |
| 1 | BCLK | **4** | |
| 1 | LRCLK (`WS`) | **5** | |
| 1 | DOUT (`DIN`) | **6** | m2 (`SEL`→GND, left), m3 (`SEL`→3V3, right) |

Channel order off the wire is **bus-major, L then R**: m0 = bus0-L, m1 = bus0-R, m2 = bus1-L,
m3 = bus1-R — the same ids and positions as `config/array.json`
(x = −120, −40, +40, +120 mm in the hat frame, `−x` = wearer's left). The app labels each channel with
its bus, L/R and x, so a swap is visible without a scope.

Why those pins: 4–9 are on the TinyS3's safe set (no strapping, no flash, no PSRAM duties). Its flash
and PSRAM sit on GPIO26–32, and GPIO10/17/18/33 are VBAT_SENSE / RGB_PWR / RGB_DATA / VBUS_SENSE on
this board — do not move a bus onto them. Everything is 3.3 V logic; **never 5 V on a mic**.

Per mic: `3V`, `GND`, `BCLK`, `LRCLK`, `DOUT`, plus `SEL` tied to GND or 3V3. Bottom-ported: the
acoustic hole faces away from the head/pads, with ≥5 mm standoff and a foam windscreen.

## 2. Build and flash (Arduino IDE)

1. Open `esp32/aura4/aura4.ino` (Arduino IDE 2.x wants the folder name to match the sketch — it does).
2. **Tools → Board: "ESP32S3 Dev Module"**, `USB CDC On Boot: Enabled`, `Flash Size: 8MB`, `Upload
   Speed: 921600`. Leave PSRAM alone; this sketch does not use it.
3. **Tools → Manage Libraries →** install **"WebSockets" by Markus Sattler** (the `ws://<hat>:81/`
   server the page talks to). The core must be **esp32 by Espressif 3.x** — the sketch uses the IDF
   `i2s_std` driver, which 2.x does not have.
4. Upload, then open the printed URL on the phone.

Same thing headless, which is also how the preview build was checked:

```sh
arduino-cli core install esp32:esp32 \
  --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli lib install WebSockets
arduino-cli compile --fqbn esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=8M,UploadSpeed=921600 esp32/aura4
arduino-cli upload -p /dev/ttyACM0 --fqbn esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=8M,UploadSpeed=921600 esp32/aura4
arduino-cli monitor -p /dev/ttyACM0 -c baudrate=115200
```

Verified against **esp32:esp32 3.3.12** + WebSockets 2.7.2: builds clean (`--warnings all`), **972 145
bytes of program space (74 %)** and **60 824 bytes of globals (18 %)**, no warnings.

NixOS quirk: arduino-cli finishes a build with a hardcoded `/bin/cp`, which NixOS does not have — the
build fails *after* the image is written (`aura4.ino.merged.bin ready to flash`) with
`fork/exec /bin/cp: no such file or directory`. The image is fine; either upload from the IDE or give
the CLI a `/bin/cp` (e.g. `unshare -rm` + a tmpfs `/bin`).

## 3. Run it

- Wi-Fi credentials are the two constants at the top of `aura4.ino` (currently the phone hotspot).
  The phone must be on that network; the board prints its IP.
- If that AP is not reachable within 20 s the board raises its own **`AuraSound-4mic` / `aura1234`**
  AP instead and prints `http://192.168.4.1/`, so the app stays usable with no hotspot at all.
- Serial at 115200 prints, once: the bus→pin→mic map, the page hash, the URL. Then every 500 ms:

  `rms lsb  m0= 5792 m1= 4178 m2=    3 m3=    2   dc    0    0    0    0  pkts=412 ovf=0 short=0`

  Silence is tens of LSB, speech in a quiet room is hundreds to thousands (README §6.1/A4). `ALL
  SILENT` is appended when all four are under 20 LSB.
- `GET http://<hat>/status` returns the same numbers as JSON (rssi, seq, blocks, per-channel
  `rms_lsb`/`dc_lsb`, `overflows`, `short_reads`, pins) — the read-only probe for a laptop.

## 4. The app

Open `http://<hat>/` on the phone.

- **Listen** starts live playback (needs the tap: browsers require a user gesture for audio). Pick
  which mics you hear: mix of all four, one mic, or left/right pair; per-channel mute/solo and gain
  are applied to both the monitor mix and `mix.wav`.
- **Record** captures every channel; **Stop** produces downloads: `mix.wav`, `4ch.wav` (one channel
  per mic) and `mic0..mic3.wav`, 16-bit PCM at the stream rate. The capture is held in phone memory, so
  it auto-stops at 120 s.
- Per-channel strip: dBFS, peak LSB, and three flags — `silent` (<20 LSB), `dc` (mean offset in LSB;
  a real DC ramp/drift flags at >100), `clips`.
- Stream panel: rate, block size, firmware hash, **pins** (proves the flashed pin map), rssi, uptime,
  packets, `seq gaps (lost)`, bad frames, playback buffer ms, underruns/resyncs, and a dominant-tone
  readout of whatever you are monitoring. A hat reboot restarts `seq` at 0 and is reported as
  `restart`, never as four billion lost packets.

Which acceptance item each readout settles:

| Check (§0) | How to see it here |
|---|---|
| A2/A3 all four channels non-zero | four dBFS bars move; no `silent` flag on a live mic |
| A4 scaling (`>>16`), no DC ramp | speech lands in the hundreds–thousands LSB; `dc` stays near 0 |
| A5 `seq` gaps < 0.1 % | `seq gaps (lost)` on the stream panel (over WS; UDP output is not implemented yet) |
| A12 wiring map | this file + the `pins` line in the app |

## 5. Limits and open work

- **No UDP yet.** The WebSocket payload is the §4.2 packet byte-for-byte (magic `0xA14D`, version,
  `nch=4`, `seq`, `t_us`, `nsamp=320`, channel-major int16) so the UDP/USB transports are a send-path
  change only. §4.3 telemetry, §4.4 commands and the WS2812 strip are still open.
- **16 kHz, fixed.** Matches §4.2; there is no runtime rate switch.
- **Two independent I2S masters.** Both run 16 kHz from the same PLL with identical dividers, so there
  is no systematic drift between the buses — but their phase is arbitrary, i.e. a *fixed* inter-bus
  offset. Measure it with the clap at 0° (README §7.2.2) before trusting any TDOA number.
- Monitoring latency is a conversation-grade ~150–250 ms (DMA + one Wi-Fi hop + the app's 120 ms
  playback lead). It is for checking that a mic works, not for assessment.
- The page is plain HTTP because it only plays audio (no `getUserMedia`): no certificate needed on the
  phone. `?ws=ws://host:port/` overrides the socket if you want to point the page at something else.

## 6. Working on the app with no hardware

`mock_hat.py` parses `page.h`, serves it, and streams synthetic 4-channel audio in the same framing —
one tone per channel, so a swap or a dead input is obvious and measurable.

```sh
.venv/bin/python esp32/tools/mock_hat.py                 # http://127.0.0.1:8080/
.venv/bin/python esp32/tools/mock_hat.py --silent 2,3    # dead m2/m3: the app must flag them
.venv/bin/python esp32/tools/mock_hat.py --dc 0,0,0,300  # a DC offset on m3
.venv/bin/python esp32/tools/mock_hat.py --drop 5        # lose every 5th packet: gap counter
.venv/bin/python esp32/tools/mock_hat.py --restart-every 40  # seq resets in-band: a reboot the app never saw close
.venv/bin/python esp32/tools/mock_hat.py --tone 440,880,1320,1760 --level 0.25,0.18,0.12,0.08
```

Defaults: m0 440 Hz, m1 880, m2 1320, m3 1760, levels −12/−15/−18/−22 dBFS. The served page is the
real one from `page.h`, with its default socket port pointed at the mock's WS port; `?ws=` still wins.
`http://<laptop-ip>:8080/` also works from the phone on the same network.
