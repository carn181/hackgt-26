// aura4.ino -- AuraSound 4-mic live monitor.
//
//   TinyS3 (ESP32-S3) -- 4x ICS-43434 on two I2S buses -- Wi-Fi -- phone browser
//
// What it does:
//   * captures mics 0..3 as two stereo pairs (bus0 = mics 0/1, bus1 = mics 2/3), 16 kHz, 32-bit slots;
//   * frames them exactly like README 4.2 (magic 0xA14D ... channel-major int16) and pushes those bytes
//     over WebSocket :81 -- the same bytes the UDP path will carry, so this is a wiring/A4 test first;
//   * serves esp32/aura4/page.h on :80: per-channel meters, live listening, WAV recording;
//   * prints per-channel RMS on serial at 2 Hz and answers GET /status in JSON.
//
// Wiring (esp32/HAT.md has the full map):
//   bus0  BCLK 7  WS 8  DIN 9   m0 = SEL GND (L), m1 = SEL 3V3 (R)
//   bus1  BCLK 4  WS 5  DIN 6   m2 = SEL GND (L), m3 = SEL 3V3 (R)
// The two buses are independent masters on separate pins, as README section 9 specifies. They run at
// the same nominal rate from the same PLL with identical dividers, so there is no systematic drift --
// only a fixed inter-bus offset, measured once with a clap (README 7.2.2).
//
// Every sample is the top 16 bits of the 24-bit mic word: the ICS-43434 packs 24-bit signed samples
// left-justified in each 32-bit slot, so `raw >> 16` is the int16 (README 9, "do not re-derive").

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include "driver/i2s_std.h"
#include "esp_timer.h"
#include "page.h"

// ---------------------------------------------------------------- configuration

// Phone hotspot (or any 2.4 GHz AP the phone is on). Phone browser then opens http://<ip>/
static const char *WIFI_SSID = "Iphone 19 pro max";
static const char *WIFI_PASSWORD = "12309810";

// If the AP above is not reachable within WIFI_TIMEOUT_MS the board raises its own AP instead, so the
// app is still usable (join AuraSound-4mic, open http://192.168.4.1/). It says which mode it is in.
static const char *AP_SSID = "AuraSound-4mic";
static const char *AP_PASSWORD = "aura1234"; // >= 8 chars or the AP comes up open
static const uint32_t WIFI_TIMEOUT_MS = 20000;

struct BusPins {
  uint8_t bclk, ws, din;
};

// One entry per I2S bus; two mics hang off each (SEL low = left = even mic id).
static const BusPins BUS_PINS[2] = {{7, 8, 9}, {4, 5, 6}};

static const uint32_t SAMPLE_RATE = 16000; // README 4.2
static const int BLOCK_FRAMES = 320;       // 20 ms per packet, 50 packets/s
static const int NCH = 4;
static const int BUSES = 2;
static const int PKT_HEADER = 18;
static const int PKT_SIZE = PKT_HEADER + NCH * BLOCK_FRAMES * sizeof(int16_t);
static const uint16_t PKT_MAGIC = 0xA14D;
static const uint8_t PKT_VERSION = 1;
static const int DMA_DESC = 4;             // 80 ms of DMA slack per bus
static const uint32_t RMS_PRINT_MS = 500;
static const uint32_t TELEMETRY_MS = 2000;
static const int SILENT_LSB = 20;          // README A4: silence is "tens of LSB"
static const uint32_t BUS_STALL_MS = 1000; // a bus that delivers nothing this long sends silence

static const char *FW_VERSION = "0.1";

// ---------------------------------------------------------------- state

struct BusBlock {
  int64_t tUs;                    // esp_timer_get_time() when the block finished reading
  int16_t s[BLOCK_FRAMES * 2];    // interleaved L,R, already scaled to int16
};

struct BusRuntime {
  i2s_chan_handle_t rx = nullptr;
  QueueHandle_t queue = nullptr;
  TaskHandle_t task = nullptr;
  // Task-owned counters: each bus task owns its own BusRuntime, so these need no volatile (which is
  // deprecated under C++20 `++`); the loop only reads them for the serial/status line.
  uint32_t blocks = 0;
  uint32_t shortReads = 0;
  uint32_t dropped = 0;
  // Per-bus scratch: two bus tasks used to share one function-local static buffer, which is a race.
  int32_t raw[BLOCK_FRAMES * 2]; // one DMA block: 320 frames x 2 slots x 32 bit
  BusBlock blk;
  uint16_t rmsLsb = 0, rmsLsbR = 0;   // last block, in LSB, for the serial/status line
  int16_t dcL = 0, dcR = 0;
};

static BusRuntime bus[BUSES];

// One §4.2 packet, built once per frame pair and broadcast to every browser.
static uint8_t packet[PKT_SIZE] __attribute__((aligned(4)));
static int16_t *const pktSamples = reinterpret_cast<int16_t *>(packet + PKT_HEADER);

static BusBlock blk[BUSES];
static uint32_t seq = 0;
static uint32_t overflows = 0;       // loops where a bus queue was empty
static uint32_t busStalls = 0;       // times a bus went silent for BUS_STALL_MS and was zero-filled
static uint32_t clientsSeen = 0;
static uint32_t shortReadsTotal = 0; // reads that did not fill a full DMA block
static char fwHash[9] = "00000000";
static bool apMode = false;

WebServer server(80);
WebSocketsServer webSocket(81);

// ---------------------------------------------------------------- helpers

static inline int16_t toInt16(int32_t raw) {
  int32_t s = raw >> 16; // 24-bit word left-justified in a 32-bit slot
  if (s > 32767) s = 32767;
  if (s < -32768) s = -32768;
  return (int16_t)s;
}

// RMS and mean of one channel of a block, in LSB.
static void blockStats(const int16_t *s, int stride, int offset, uint16_t &rms, int16_t &dc) {
  int64_t sumSq = 0, sum = 0;
  for (int i = 0; i < BLOCK_FRAMES; i++) {
    int32_t v = s[i * stride + offset];
    sumSq += (int64_t)v * v;
    sum += v;
  }
  rms = (uint16_t)sqrt((double)sumSq / BLOCK_FRAMES);
  dc = (int16_t)(sum / BLOCK_FRAMES);
}

// FNV-1a over the served page: lets the browser (and you) prove the flashed page is the edited one.
static void computeFwHash() {
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < sizeof(PAGE_HTML) - 1; i++) {
    h ^= pgm_read_byte(PAGE_HTML + i);
    h *= 16777619u;
  }
  snprintf(fwHash, sizeof(fwHash), "%08x", (unsigned)h);
}

// ---------------------------------------------------------------- I2S

static bool setupBus(int b) {
  const BusPins &p = BUS_PINS[b];

  i2s_chan_config_t chanConfig = I2S_CHANNEL_DEFAULT_CONFIG(b == 0 ? I2S_NUM_0 : I2S_NUM_1, I2S_ROLE_MASTER);
  chanConfig.dma_desc_num = DMA_DESC;
  chanConfig.dma_frame_num = BLOCK_FRAMES;

  esp_err_t err = i2s_new_channel(&chanConfig, nullptr, &bus[b].rx);
  if (err != ESP_OK) {
    Serial.printf("bus%d: i2s_new_channel failed: %d\n", b, err);
    return false;
  }

  i2s_std_config_t config = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
      .gpio_cfg = {
          .mclk = I2S_GPIO_UNUSED,
          .bclk = (gpio_num_t)p.bclk,
          .ws = (gpio_num_t)p.ws,
          .dout = I2S_GPIO_UNUSED,
          .din = (gpio_num_t)p.din,
          .invert_flags = {.mclk_inv = false, .bclk_inv = false, .ws_inv = false},
      },
  };

  err = i2s_channel_init_std_mode(bus[b].rx, &config);
  if (err != ESP_OK) {
    Serial.printf("bus%d: init_std_mode failed: %d\n", b, err);
    return false;
  }
  err = i2s_channel_enable(bus[b].rx);
  if (err != ESP_OK) {
    Serial.printf("bus%d: channel_enable failed: %d\n", b, err);
    return false;
  }
  Serial.printf("bus%d ready: BCLK=%u WS=%u DIN=%u -> m%d (L), m%d (R)\n", b, p.bclk, p.ws, p.din, b * 2, b * 2 + 1);
  return true;
}

// One task per bus. It blocks on its own DMA and never accumulates backlog: the only way two buses
// stay aligned is if each one is drained at exactly its own pace and the pairing is done downstream.
static void busTask(void *arg) {
  BusRuntime *b = (BusRuntime *)arg;
  BusBlock &out = b->blk;

  for (;;) {
    size_t got = 0;
    esp_err_t err = i2s_channel_read(b->rx, b->raw, sizeof(b->raw), &got, 100);
    if (err != ESP_OK && got == 0) {
      vTaskDelay(1);
      continue;
    }
    if (got != sizeof(b->raw)) {
      b->shortReads++;
      if (got == 0 || (got % (sizeof(int32_t) * 2)) != 0) continue; // never misalign a block
    }

    int frames = (int)(got / (sizeof(int32_t) * 2));
    out.tUs = esp_timer_get_time();
    for (int i = 0; i < frames; i++) {
      out.s[i * 2] = toInt16(b->raw[i * 2]);
      out.s[i * 2 + 1] = toInt16(b->raw[i * 2 + 1]);
    }
    for (int i = frames; i < BLOCK_FRAMES; i++) out.s[i * 2] = out.s[i * 2 + 1] = 0;

    b->blocks++;
    if (xQueueSend(b->queue, &out, 0) != pdTRUE) b->dropped++;
  }
}

// ---------------------------------------------------------------- status / telemetry

static String statusJson() {
  String j = "{";
  j += "\"ok\":true";
  j += ",\"fw\":\"" + String(fwHash) + "\"";
  j += ",\"ver\":\"" + String(FW_VERSION) + "\"";
  j += ",\"mode\":\"" + String(apMode ? "ap" : "sta") + "\"";
  j += ",\"ip\":\"" + (apMode ? WiFi.softAPIP().toString() : WiFi.localIP().toString()) + "\"";
  j += ",\"rssi\":" + String(apMode ? 0 : WiFi.RSSI());
  j += ",\"uptime\":" + String((uint32_t)(millis() / 1000));
  j += ",\"rate\":" + String(SAMPLE_RATE);
  j += ",\"nch\":" + String(NCH);
  j += ",\"block\":" + String(BLOCK_FRAMES);
  j += ",\"seq\":" + String(seq);
  j += ",\"clients\":" + String(webSocket.connectedClients());
  j += ",\"clients_seen\":" + String(clientsSeen);
  j += ",\"overflows\":" + String(overflows);
  j += ",\"short_reads\":" + String(shortReadsTotal);
  j += ",\"stalls\":" + String(busStalls);
  j += ",\"pins\":{\"bus0\":[" + String(BUS_PINS[0].bclk) + "," + String(BUS_PINS[0].ws) + "," + String(BUS_PINS[0].din) + "]";
  j += ",\"bus1\":[" + String(BUS_PINS[1].bclk) + "," + String(BUS_PINS[1].ws) + "," + String(BUS_PINS[1].din) + "]}";
  j += ",\"rms_lsb\":[" + String(bus[0].rmsLsb) + "," + String(bus[0].rmsLsbR) + "," + String(bus[1].rmsLsb) + "," + String(bus[1].rmsLsbR) + "]";
  j += ",\"dc_lsb\":[" + String(bus[0].dcL) + "," + String(bus[0].dcR) + "," + String(bus[1].dcL) + "," + String(bus[1].dcR) + "]";
  j += ",\"blocks\":[" + String(bus[0].blocks) + "," + String(bus[1].blocks) + "]";
  j += "}";
  return j;
}

static void printRmsLine() {
  Serial.printf("rms lsb  m0=%5u m1=%5u m2=%5u m3=%5u   dc %4d %4d %4d %4d  pkts=%lu ovf=%lu stall=%lu short=%lu %s\n",
                bus[0].rmsLsb, bus[0].rmsLsbR, bus[1].rmsLsb, bus[1].rmsLsbR,
                bus[0].dcL, bus[0].dcR, bus[1].dcL, bus[1].dcR,
                (unsigned long)seq, (unsigned long)overflows, (unsigned long)busStalls, (unsigned long)shortReadsTotal,
                (bus[0].rmsLsb < SILENT_LSB && bus[0].rmsLsbR < SILENT_LSB && bus[1].rmsLsb < SILENT_LSB && bus[1].rmsLsbR < SILENT_LSB) ? "ALL SILENT" : "");
}

// ---------------------------------------------------------------- Wi-Fi

static bool connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false); // sleep costs DMA/i2s timing on some builds; the board is on USB or a bank
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("joining \"%s\"", WIFI_SSID);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_TIMEOUT_MS) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("wifi ok, ip %s rssi %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    return true;
  }
  Serial.printf("wifi failed after %u s -> AP fallback\n", (unsigned)(WIFI_TIMEOUT_MS / 1000));
  WiFi.mode(WIFI_AP);
  apMode = WiFi.softAP(AP_SSID, AP_PASSWORD);
  Serial.printf("ap %s: %s\n", apMode ? "up" : "FAILED", WiFi.softAPIP().toString().c_str());
  return apMode;
}

// ---------------------------------------------------------------- websocket

static void webSocketEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: {
      clientsSeen++;
      IPAddress ip = webSocket.remoteIP(num);
      Serial.printf("ws client %u from %s (%u total)\n", num, ip.toString().c_str(), webSocket.connectedClients());
      String hello = statusJson(); // sendTXT/broadcastTXT take a non-const String&
      webSocket.sendTXT(num, hello);
      break;
    }
    case WStype_DISCONNECTED:
      Serial.printf("ws client %u left (%u left)\n", num, webSocket.connectedClients());
      break;
    case WStype_TEXT:
      // The app is read-only towards the hat; anything else is a protocol error worth seeing.
      Serial.printf("ws client %u sent %u bytes: %.*s\n", num, (unsigned)length, (int)length, (const char *)payload);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- setup

void setup() {
  Serial.begin(115200);
  delay(1500); // USB-CDC needs a moment before the first line survives
  Serial.println();
  Serial.println("=========================================");
  Serial.println("AuraSound 4-mic live monitor");
  Serial.println("=========================================");

  computeFwHash();

  if (!setupBus(0) || !setupBus(1)) {
    Serial.println("I2S failed -- check the wiring map in esp32/HAT.md");
    while (true) delay(1000);
  }

  for (int b = 0; b < BUSES; b++) {
    bus[b].queue = xQueueCreate(2, sizeof(BusBlock));
    if (!bus[b].queue) {
      Serial.printf("bus%d: queue alloc failed\n", b);
      while (true) delay(1000);
    }
    xTaskCreatePinnedToCore(busTask, "i2s-rx", 4096, &bus[b], 3, &bus[b].task, 1);
  }

  connectWiFi();

  server.on("/", HTTP_GET, []() { server.send_P(200, "text/html", PAGE_HTML); });
  server.on("/status", HTTP_GET, []() {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", statusJson());
  });
  server.on("/favicon.ico", HTTP_GET, []() { server.send(204); });
  server.onNotFound([]() { server.send(404, "text/plain", "not found\n"); });
  server.begin();

  webSocket.begin();
  webSocket.onEvent(webSocketEvent);

  Serial.printf("page hash %s, http :80, ws :81\n", fwHash);
  Serial.print("OPEN ON PHONE: http://");
  Serial.println(apMode ? WiFi.softAPIP().toString().c_str() : WiFi.localIP().toString().c_str());
}

// ---------------------------------------------------------------- loop

void loop() {
  server.handleClient();
  webSocket.loop();

  // One block from each bus -> one 4-channel packet; the queues are the clock (one packet per 20 ms of
  // audio) and the per-bus tasks keep the DMA drained while we wait.
  //
  // A received block is never discarded for want of its partner: pairing bus0[k] with bus1[k] for the
  // whole run is what keeps the inter-bus offset a *constant* the clap test can measure. Throwing away
  // a lone block would shift the pairing by 20 ms for the rest of the session.
  static bool pending[BUSES] = {false, false};
  static uint32_t waitingSince[BUSES] = {0, 0};

  for (int b = 0; b < BUSES; b++) {
    if (pending[b]) continue;
    if (xQueueReceive(bus[b].queue, &blk[b], pdMS_TO_TICKS(25)) == pdTRUE) {
      pending[b] = true;
      waitingSince[b] = 0;
      continue;
    }
    if (waitingSince[b] == 0) {
      waitingSince[b] = millis();
    } else if (millis() - waitingSince[b] > BUS_STALL_MS) {
      // A dead or mis-wired bus must not freeze the other one: send silence for it, keep counting it,
      // and let the app show three live channels plus one silent one instead of nothing at all.
      memset(blk[b].s, 0, sizeof(blk[b].s));
      blk[b].tUs = esp_timer_get_time();
      pending[b] = true;
      busStalls++;
    }
  }
  if (!pending[0] || !pending[1]) {
    overflows++;
    return;
  }
  pending[0] = pending[1] = false;

  // Channel-major output: m0 = bus0 L, m1 = bus0 R, m2 = bus1 L, m3 = bus1 R (README 4.2).
  for (int b = 0; b < BUSES; b++) {
    int16_t *left = pktSamples + (b * 2) * BLOCK_FRAMES;
    int16_t *right = left + BLOCK_FRAMES;
    for (int i = 0; i < BLOCK_FRAMES; i++) {
      left[i] = blk[b].s[i * 2];
      right[i] = blk[b].s[i * 2 + 1];
    }
  }

  // Header. t_us is the oldest sample in the packet: the earlier bus's read time minus one block.
  int64_t tStart = (blk[0].tUs < blk[1].tUs ? blk[0].tUs : blk[1].tUs) - (int64_t)(BLOCK_FRAMES * 1000000LL / SAMPLE_RATE);
  uint16_t magic = PKT_MAGIC;
  memcpy(packet + 0, &magic, 2);
  packet[2] = PKT_VERSION;
  packet[3] = NCH;
  memcpy(packet + 4, &seq, 4);
  memcpy(packet + 8, &tStart, 8);
  uint16_t nsamp = BLOCK_FRAMES;
  memcpy(packet + 16, &nsamp, 2);
  seq++;

  for (int b = 0; b < BUSES; b++) {
    blockStats(blk[b].s, 2, 0, bus[b].rmsLsb, bus[b].dcL);
    blockStats(blk[b].s, 2, 1, bus[b].rmsLsbR, bus[b].dcR);
    shortReadsTotal += bus[b].shortReads;
    bus[b].shortReads = 0;
  }

  if (webSocket.connectedClients() > 0) webSocket.broadcastBIN(packet, PKT_SIZE);

  static uint32_t lastRmsMs = 0, lastTelemetryMs = 0;
  uint32_t nowMs = millis();
  if (nowMs - lastRmsMs >= RMS_PRINT_MS) {
    lastRmsMs = nowMs;
    printRmsLine();
  }
  if (nowMs - lastTelemetryMs >= TELEMETRY_MS) {
    lastTelemetryMs = nowMs;
    if (webSocket.connectedClients() > 0) {
      String telemetry = statusJson();
      webSocket.broadcastTXT(telemetry);
    }
  }
}
