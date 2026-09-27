/*
 * hackgt_hat.ino -- ESP32-S3 4-mic sound-direction hat (debug build)
 *
 * What this does (deliberately simple -- we're just debugging right now):
 *   - Captures all 4 ICS-43434 mics over two I2S buses.
 *   - Every ~20 ms, computes each mic's RMS amplitude, picks the loudest
 *     one, and derives a coarse direction label (LEFT/RIGHT/FRONT/BACK)
 *     from comparing the left/right pair against the front/back pair.
 *   - Tracks a slow-moving room-noise baseline and only calls it a real
 *     "someone is calling you" event -- worth reporting a direction for --
 *     when the loudest mic spikes well above that baseline. A quiet room
 *     reads ~20 (raw RMS units) on these mics; talking/clapping reads
 *     800+. See the "is this a real event" section below to retune.
 *   - Prints a readable line to the Serial Monitor at ~10 Hz -- this is
 *     what you (the friend flashing this) watch to confirm the mics are
 *     alive and something sane is coming out.
 *   - Also broadcasts the same info as a small JSON UDP packet on the
 *     local WiFi network at ~10 Hz, so it can be picked up by a laptop or
 *     phone running the project's web app -- no backend IP address needs
 *     to be configured, it just broadcasts to everyone on the LAN.
 *
 * This intentionally does NOT stream raw audio anywhere -- the mic
 * quality isn't great and 4 channels of 16 kHz audio is a lot of data to
 * push over WiFi/serial for not much benefit right now. Speech-to-text is
 * handled separately by the laptop/phone's own microphone in the web app.
 *
 * ---------------------------------------------------------------------
 * WiFi network: use a PHONE HOTSPOT, not venue/home WiFi.
 *
 * The most common reason this never seems to "connect" is the network,
 * not the code: most venue/home WiFi either isolates clients from each
 * other (so the ESP32 can join fine but its UDP broadcast never reaches
 * anyone) or sits behind a captive portal the ESP32 can't click through.
 * A phone's own mobile hotspot has neither problem and is 2.4 GHz by
 * default (the ESP32 can't join a 5 GHz-only network at all).
 *
 * Turn on your phone's hotspot, point WIFI_SSID/WIFI_PASS below at it,
 * and make sure the laptop running the backend (server/main.py) *and*
 * the phone/laptop running the web app are ALSO connected to that same
 * hotspot -- not to whatever WiFi they were on before.
 * ---------------------------------------------------------------------
 * Setup (Arduino IDE):
 *   1. Tools > Board > Boards Manager: install "esp32 by Espressif
 *      Systems" -- whatever the current default version is (3.x). This
 *      sketch uses the modern `driver/i2s_std.h` API, which needs that
 *      newer core; it does NOT need the old 2.0.x line.
 *   2. Tools > Board: "ESP32S3 Dev Module" (generic is fine -- all the
 *      pins below are plain GPIO numbers, not board-specific labels).
 *   3. Tools > USB CDC On Boot: "Enabled". This makes the same USB cable
 *      you flash with also work as the Serial Monitor port.
 *   4. Edit WIFI_SSID / WIFI_PASS below to your phone's hotspot, then
 *      Upload.
 *   5. Tools > Serial Monitor, baud 115200. You should see boot lines,
 *      a "wifi: connected" line with an IP, then a continuous stream of
 *      "m1=... m2=... m3=... m4=... loudest=.. dir=.. floor=.. active=.." lines.
 * ---------------------------------------------------------------------
 */

#include <WiFi.h>
#include <WiFiUdp.h>
#include "driver/i2s_std.h"

// ==================== EDIT ME before flashing ====================
// Point this at your PHONE'S HOTSPOT (see the note above), not venue/home
// WiFi.
static const char *WIFI_SSID = "your-phone-hotspot-name";
static const char *WIFI_PASS = "your-hotspot-password";
// ===================================================================

// UDP broadcast -- no backend IP needed, this just goes out to the whole
// LAN. Any laptop/phone on the same WiFi network can listen on this port.
static const uint16_t BROADCAST_PORT = 7010;
static const uint32_t BROADCAST_INTERVAL_MS = 100;  // 10 Hz
static const uint32_t PRINT_INTERVAL_MS = 100;       // 10 Hz on the Serial Monitor

// ---------------------------------------------------------------------
// Wiring. I2S0 is the clock master for bus 0 (MIC1+MIC2); its BCLK/WS
// output pins are physically looped back on the board (GPIO7->GPIO5,
// GPIO8->GPIO4) into I2S1's clock-slave inputs, so bus 1 (MIC3+MIC4) stays
// sample-locked to bus 0 instead of running its own independent clock.
// ---------------------------------------------------------------------

// I2S0 -- master, drives BCLK/WS, captures bus 0 (MIC1 = left, MIC2 = right).
static const int I2S0_BCLK = 7;  // also wired off-board to GPIO5 (I2S1 BCLK_IN)
static const int I2S0_WS = 8;    // also wired off-board to GPIO4 (I2S1 WS_IN)
static const int I2S0_DIN = 9;   // MIC1 DOUT + MIC2 DOUT

// I2S1 -- slave, clocked externally from the I2S0 loopback, captures bus 1
// (MIC3 = front, MIC4 = back).
static const int I2S1_BCLK_IN = 5;
static const int I2S1_WS_IN = 4;
static const int I2S1_DIN = 6;  // MIC3 DOUT + MIC4 DOUT

static const uint32_t SAMPLE_RATE_HZ = 16000;
static const int SAMPLES_PER_BLOCK = 320;  // 20 ms @ 16 kHz

// ---------------------------------------------------------------------
// "Is this a real event, or just room noise?"
// ---------------------------------------------------------------------
// These mics' own self-noise already reads ~20 (raw RMS) in a quiet room --
// direction from *that* would just point wherever the noise floor happened
// to wobble highest. So track a slow-moving baseline of the loudest mic's
// level and only call it an event once the level rises well above it: in
// testing, talking/clapping reads 800+, ~40x the quiet-room baseline, so
// there's a lot of margin. Hysteresis (a lower ratio to stay active than to
// trigger) plus a short hang time stop a continuous sound like speech from
// flickering active/inactive on every natural dip.
static const float MIN_FLOOR = 10.0f;      // baseline never tracked below this
static const float RISE_RATIO = 6.0f;      // level > floor * this -> event starts
static const float RELEASE_RATIO = 3.0f;   // level < floor * this -> event may end
static const uint32_t HANG_MS = 400;       // bridges brief dips (pauses in speech)
static const float FLOOR_ALPHA = 0.01f;    // ~2 s time constant at 50 blocks/s

struct RawBusBlock {
  int32_t slots[SAMPLES_PER_BLOCK * 2];  // interleaved L,R, 32-bit slots
};

static RawBusBlock g_bus0;
static RawBusBlock g_bus1;

static i2s_chan_handle_t g_chanBus0 = nullptr;  // I2S0, master
static i2s_chan_handle_t g_chanBus1 = nullptr;  // I2S1, slave

WiFiUDP udp;
uint32_t g_lastBroadcastMs = 0;
uint32_t g_lastPrintMs = 0;

static float g_floor = MIN_FLOOR;
static bool g_active = false;
static uint32_t g_belowSinceMs = 0;  // 0 = "not currently below release"

// ---------------------------------------------------------------------
// I2S bring-up (IDF5 `i2s_std` driver)
// ---------------------------------------------------------------------
static bool configureI2S(i2s_port_t port, bool master, int bck, int ws, int din,
                          i2s_chan_handle_t *outHandle) {
  i2s_chan_config_t chanCfg =
      I2S_CHANNEL_DEFAULT_CONFIG(port, master ? I2S_ROLE_MASTER : I2S_ROLE_SLAVE);
  chanCfg.dma_desc_num = 8;
  chanCfg.dma_frame_num = SAMPLES_PER_BLOCK;

  // NULL tx handle: these channels are RX-only (we never drive DOUT to the
  // mics, only BCLK/WS on the master side).
  esp_err_t err = i2s_new_channel(&chanCfg, nullptr, outHandle);
  if (err != ESP_OK) {
    Serial.printf("i2s: new_channel failed on port %d: %d\n", port, err);
    return false;
  }

  i2s_std_config_t stdCfg = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE_HZ),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT,
                                                     I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = static_cast<gpio_num_t>(bck),
      .ws = static_cast<gpio_num_t>(ws),
      .dout = I2S_GPIO_UNUSED,
      .din = static_cast<gpio_num_t>(din),
      .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
    },
  };

  err = i2s_channel_init_std_mode(*outHandle, &stdCfg);
  if (err != ESP_OK) {
    Serial.printf("i2s: init_std_mode failed on port %d: %d\n", port, err);
    return false;
  }

  err = i2s_channel_enable(*outHandle);
  if (err != ESP_OK) {
    Serial.printf("i2s: channel_enable failed on port %d: %d\n", port, err);
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------
// WiFi
// ---------------------------------------------------------------------
static void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("wifi: connecting to %s", WIFI_SSID);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
    Serial.print('.');
    if (millis() - start > 20000) {
      Serial.println("\nwifi: still not connected after 20s, retrying...");
      Serial.println("wifi: is WIFI_SSID/WIFI_PASS actually your phone's hotspot?");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
      start = millis();
    }
  }
  Serial.printf("\nwifi: connected, ip=%s\n", WiFi.localIP().toString().c_str());
}

// Broadcast address = this device's IP with the host bits set to 1.
// Assumes a typical /24 phone-hotspot network -- good enough for this debug
// build. If broadcasts aren't reaching your laptop/phone, double-check
// they're on the same hotspot (not still on their previous WiFi).
static IPAddress broadcastAddress() {
  uint32_t ip = static_cast<uint32_t>(WiFi.localIP());
  uint32_t mask = static_cast<uint32_t>(WiFi.subnetMask());
  return IPAddress(ip | ~mask);
}

// ---------------------------------------------------------------------
// Amplitude
// ---------------------------------------------------------------------
// ICS-43434 packs 24-bit signed samples left-justified in the 32-bit I2S
// slot, so the top 16 bits of each slot are already a signed int16 --
// hence the ">> 16" below. `stride`/`offset` pick one channel (L or R)
// out of the interleaved L,R,L,R,... block.
static float rmsOf(const int32_t *slots, int stride, int offset, int n) {
  double sumSq = 0.0;
  for (int i = 0; i < n; i++) {
    int16_t v = static_cast<int16_t>(slots[i * stride + offset] >> 16);
    sumSq += static_cast<double>(v) * v;
  }
  return sqrtf(static_cast<float>(sumSq / n));
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== hackgt-26 hat (simple direction build) booting ===");

  Serial.println("i2s: bringing up bus0 (master) + bus1 (slave)...");
  if (!configureI2S(I2S_NUM_0, /*master=*/true, I2S0_BCLK, I2S0_WS, I2S0_DIN, &g_chanBus0)) {
    Serial.println("i2s: bus0 FAILED -- halting");
    while (true) delay(1000);
  }
  delay(100);
  if (!configureI2S(I2S_NUM_1, /*master=*/false, I2S1_BCLK_IN, I2S1_WS_IN, I2S1_DIN,
                     &g_chanBus1)) {
    Serial.println("i2s: bus1 FAILED -- halting");
    while (true) delay(1000);
  }
  Serial.println("i2s: ready.");

  connectWiFi();
  Serial.println("Streaming per-mic RMS + coarse direction below.");
}

void loop() {
  size_t bytesRead0 = 0, bytesRead1 = 0;
  i2s_channel_read(g_chanBus0, g_bus0.slots, sizeof(g_bus0.slots), &bytesRead0, 1000);
  i2s_channel_read(g_chanBus1, g_bus1.slots, sizeof(g_bus1.slots), &bytesRead1, 1000);

  float m1 = rmsOf(g_bus0.slots, 2, 0, SAMPLES_PER_BLOCK);  // MIC1 = left
  float m2 = rmsOf(g_bus0.slots, 2, 1, SAMPLES_PER_BLOCK);  // MIC2 = right
  float m3 = rmsOf(g_bus1.slots, 2, 0, SAMPLES_PER_BLOCK);  // MIC3 = front
  float m4 = rmsOf(g_bus1.slots, 2, 1, SAMPLES_PER_BLOCK);  // MIC4 = back

  int loudest = 1;
  float best = m1;
  if (m2 > best) { best = m2; loudest = 2; }
  if (m3 > best) { best = m3; loudest = 3; }
  if (m4 > best) { best = m4; loudest = 4; }

  // Coarse direction: compare the left/right imbalance against the
  // front/back imbalance and report whichever axis is stronger. This is
  // the "which mic has the biggest value" heuristic, not true TDOA -- good
  // enough to point someone roughly the right way while debugging.
  float lr = m1 - m2;  // > 0 => left louder
  float fb = m3 - m4;  // > 0 => front louder
  const char *dir;
  if (fabsf(lr) >= fabsf(fb)) {
    dir = (lr >= 0) ? "LEFT" : "RIGHT";
  } else {
    dir = (fb >= 0) ? "FRONT" : "BACK";
  }

  uint32_t now = millis();

  // Only drift the baseline while nothing is happening -- otherwise a loud,
  // sustained event would slowly convince the detector it's the new normal.
  if (!g_active) {
    g_floor += FLOOR_ALPHA * (best - g_floor);
    if (g_floor < MIN_FLOOR) g_floor = MIN_FLOOR;
  }

  float riseThresh = g_floor * RISE_RATIO;
  float releaseThresh = g_floor * RELEASE_RATIO;

  if (!g_active && best > riseThresh) {
    g_active = true;
    g_belowSinceMs = 0;
  } else if (g_active) {
    if (best < releaseThresh) {
      if (g_belowSinceMs == 0) g_belowSinceMs = now;
      if (now - g_belowSinceMs > HANG_MS) g_active = false;
    } else {
      g_belowSinceMs = 0;  // still loud enough -- cancel the hang timer
    }
  }

  if (now - g_lastPrintMs >= PRINT_INTERVAL_MS) {
    g_lastPrintMs = now;
    Serial.printf("m1=%.0f m2=%.0f m3=%.0f m4=%.0f  loudest=M%d  dir=%s  floor=%.0f  active=%d\n",
                  m1, m2, m3, m4, loudest, dir, g_floor, g_active ? 1 : 0);
  }

  // A phone hotspot can drop out (screen-lock power saving, walking out of
  // range of the hat) more often than a router -- reconnect instead of just
  // going silent on the broadcast forever.
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("wifi: disconnected, reconnecting...");
    connectWiFi();
  }

  if (WiFi.status() == WL_CONNECTED && now - g_lastBroadcastMs >= BROADCAST_INTERVAL_MS) {
    g_lastBroadcastMs = now;
    char json[224];
    int n = snprintf(json, sizeof(json),
                      "{\"type\":\"hat_status\",\"t_ms\":%lu,\"m1\":%.0f,\"m2\":%.0f,\"m3\":%.0f,"
                      "\"m4\":%.0f,\"loudest\":%d,\"dir\":\"%s\",\"active\":%s,\"floor\":%.0f,"
                      "\"fw\":\"hat-simple-0.1\"}",
                      static_cast<unsigned long>(now), m1, m2, m3, m4, loudest, dir,
                      g_active ? "true" : "false", g_floor);
    if (n > 0) {
      IPAddress bcast = broadcastAddress();
      udp.beginPacket(bcast, BROADCAST_PORT);
      udp.write(reinterpret_cast<const uint8_t *>(json), n);
      udp.endPacket();
    }
  }
}
