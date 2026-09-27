#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include "driver/i2s_std.h"

// ============================================================
// AuraSound MIC1 LIVE AUDIO TEST
// TinyS3 + ICS-43434
//
// Phone Hotspot
//      ↓
// TinyS3
//      ↓ WebSocket PCM
// Phone Browser
//      ↓
// Live audio
// ============================================================


// ============================================================
// WIFI - CHANGE THESE
// ============================================================

const char* WIFI_SSID =
    "Iphone 19 pro max";

const char* WIFI_PASSWORD =
    "12309810";


// ============================================================
// SERVERS
// ============================================================

WebServer server(80);

// WebSocket runs on port 81
WebSocketsServer webSocket(81);


// ============================================================
// MIC1 / I2S PINS
// ============================================================

#define BCLK_PIN   7
#define WS_PIN     8
#define DATA_PIN   9

#define SAMPLE_RATE 48000

// 10 ms of audio:
// 48000 * 0.010 = 480 samples
#define FRAMES 480


// Stereo input:
// left  = MIC1
// right = MIC2
int32_t i2sBuffer[FRAMES * 2];

// MIC1 mono output
int16_t audioBuffer[FRAMES];


i2s_chan_handle_t rxChannel = NULL;


// ============================================================
// AUDIO SETTINGS
// ============================================================

// Start at 1.
//
// If too quiet:
// try 2.
//
// If distorted:
// keep at 1.
#define AUDIO_GAIN 1


// ============================================================
// MIC1 SAMPLE CONVERSION
// ============================================================

inline int16_t convertMicSample(int32_t raw)
{
    /*
       ICS-43434 outputs 24-bit audio.

       ESP32 is receiving it in a 32-bit I2S slot.

       The useful data is MSB aligned, therefore:

       raw >> 16

       converts it approximately into signed 16-bit PCM.
    */

    int32_t sample =
        raw >> 16;


    sample *= AUDIO_GAIN;


    if (sample > 32767)
    {
        sample = 32767;
    }


    if (sample < -32768)
    {
        sample = -32768;
    }


    return (int16_t)sample;
}


// ============================================================
// SETUP I2S
// ============================================================

bool setupI2S()
{
    Serial.println(
        "Starting MIC1 I2S..."
    );


    i2s_chan_config_t chanConfig =
        I2S_CHANNEL_DEFAULT_CONFIG(
            I2S_NUM_0,
            I2S_ROLE_MASTER
        );


    chanConfig.dma_desc_num =
        8;

    chanConfig.dma_frame_num =
        FRAMES;


    esp_err_t err =
        i2s_new_channel(
            &chanConfig,
            NULL,
            &rxChannel
        );


    if (err != ESP_OK)
    {
        Serial.printf(
            "i2s_new_channel error: %d\n",
            err
        );

        return false;
    }


    i2s_std_config_t config =
    {
        .clk_cfg =
            I2S_STD_CLK_DEFAULT_CONFIG(
                SAMPLE_RATE
            ),

        .slot_cfg =
            I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                I2S_DATA_BIT_WIDTH_32BIT,
                I2S_SLOT_MODE_STEREO
            ),

        .gpio_cfg =
        {
            .mclk =
                I2S_GPIO_UNUSED,

            .bclk =
                (gpio_num_t)BCLK_PIN,

            .ws =
                (gpio_num_t)WS_PIN,

            .dout =
                I2S_GPIO_UNUSED,

            .din =
                (gpio_num_t)DATA_PIN,

            .invert_flags =
            {
                .mclk_inv = false,
                .bclk_inv = false,
                .ws_inv = false
            }
        }
    };


    err =
        i2s_channel_init_std_mode(
            rxChannel,
            &config
        );


    if (err != ESP_OK)
    {
        Serial.printf(
            "I2S init error: %d\n",
            err
        );

        return false;
    }


    err =
        i2s_channel_enable(
            rxChannel
        );


    if (err != ESP_OK)
    {
        Serial.printf(
            "I2S enable error: %d\n",
            err
        );

        return false;
    }


    Serial.println(
        "MIC1 I2S ready."
    );


    return true;
}


// ============================================================
// WEB PAGE
// ============================================================

const char PAGE[] PROGMEM =
R"rawliteral(

<!DOCTYPE html>

<html>

<head>

<meta
    name="viewport"
    content="width=device-width, initial-scale=1">

<title>
AuraSound Live MIC1
</title>


<style>

body
{
    background:#101318;
    color:white;
    font-family:Arial,sans-serif;
    padding:20px;
    margin:0;
}

.container
{
    max-width:520px;
    margin:auto;
}

.card
{
    background:#1b2028;
    padding:22px;
    border-radius:18px;
    margin-top:20px;
}

h1
{
    margin-bottom:5px;
}

.subtitle
{
    color:#929ca8;
}

.status
{
    font-size:20px;
    font-weight:bold;
    margin:20px 0;
}

button
{
    width:100%;
    padding:18px;
    border:0;
    border-radius:12px;
    background:#4bbcff;
    font-size:19px;
    font-weight:bold;
}

.barBackground
{
    height:28px;
    background:#303944;
    border-radius:14px;
    overflow:hidden;
    margin-top:20px;
}

.bar
{
    height:100%;
    width:0%;
    background:#4bbcff;
}

.info
{
    color:#aab3bd;
    margin-top:15px;
    line-height:1.5;
}

</style>

</head>


<body>

<div class="container">

<h1>
AuraSound
</h1>

<div class="subtitle">
MIC1 Live Audio Test
</div>


<div class="card">

<div
    class="status"
    id="status">

Not started

</div>


<button
    id="startButton"
    onclick="startAudio()">

▶ Start Live MIC1

</button>


<div class="barBackground">

<div
    class="bar"
    id="volumeBar">

</div>

</div>


<div
    class="info"
    id="info">

48 kHz / 16-bit / mono

</div>

</div>


<div class="card">

<strong>
What to test
</strong>

<p>
Speak normally near MIC1.
</p>

<p>
Listen for:
</p>

<ul>
<li>clear voice</li>
<li>background hiss</li>
<li>digital crackling</li>
<li>repeating clicks</li>
<li>dropouts</li>
<li>distortion</li>
</ul>

</div>

</div>


<script>

let socket = null;

let audioContext = null;

let nextPlaybackTime = 0;

let started = false;


// ------------------------------------------------------------
// PLAY ONE PCM PACKET
// ------------------------------------------------------------

function playPCM(arrayBuffer)
{
    const pcm =
        new Int16Array(
            arrayBuffer
        );


    const floatData =
        new Float32Array(
            pcm.length
        );


    let peak = 0;


    for (
        let i = 0;
        i < pcm.length;
        i++
    )
    {
        const value =
            pcm[i] /
            32768.0;


        floatData[i] =
            value;


        const abs =
            Math.abs(
                value
            );


        if (
            abs >
            peak
        )
        {
            peak =
                abs;
        }
    }


    // --------------------------------------------------------
    // Volume bar
    // --------------------------------------------------------

    let percent =
        peak *
        100;


    if (
        percent >
        100
    )
    {
        percent =
            100;
    }


    document
        .getElementById(
            "volumeBar"
        )
        .style.width =
            percent +
            "%";


    // --------------------------------------------------------
    // AUDIO BUFFER
    // --------------------------------------------------------

    const buffer =
        audioContext.createBuffer(
            1,
            floatData.length,
            48000
        );


    buffer.copyToChannel(
        floatData,
        0
    );


    const source =
        audioContext.createBufferSource();


    source.buffer =
        buffer;


    source.connect(
        audioContext.destination
    );


    // --------------------------------------------------------
    // Maintain small buffer to prevent Wi-Fi jitter
    // --------------------------------------------------------

    const now =
        audioContext.currentTime;


    if (
        nextPlaybackTime <
        now + 0.08
    )
    {
        nextPlaybackTime =
            now + 0.08;
    }


    source.start(
        nextPlaybackTime
    );


    nextPlaybackTime +=
        buffer.duration;
}


// ------------------------------------------------------------
// START
// ------------------------------------------------------------

async function startAudio()
{
    if (started)
    {
        return;
    }


    started =
        true;


    audioContext =
        new (
            window.AudioContext ||
            window.webkitAudioContext
        )(
            {
                sampleRate:48000
            }
        );


    await audioContext.resume();


    document
        .getElementById(
            "status"
        )
        .innerText =
            "Connecting...";


    socket =
        new WebSocket(
            "ws://" +
            window.location.hostname +
            ":81/"
        );


    socket.binaryType =
        "arraybuffer";


    socket.onopen =
        function()
        {
            document
                .getElementById(
                    "status"
                )
                .innerText =
                    "● LIVE";


            document
                .getElementById(
                    "startButton"
                )
                .innerText =
                    "MIC1 Streaming";
        };


    socket.onmessage =
        function(event)
        {
            if (
                event.data
                instanceof
                ArrayBuffer
            )
            {
                playPCM(
                    event.data
                );
            }
        };


    socket.onerror =
        function()
        {
            document
                .getElementById(
                    "status"
                )
                .innerText =
                    "WebSocket Error";
        };


    socket.onclose =
        function()
        {
            document
                .getElementById(
                    "status"
                )
                .innerText =
                    "Disconnected";


            started =
                false;
        };
}

</script>

</body>

</html>

)rawliteral";


// ============================================================
// WIFI
// ============================================================

void connectWiFi()
{
    Serial.print(
        "Connecting to phone hotspot"
    );


    WiFi.mode(
        WIFI_STA
    );


    WiFi.begin(
        WIFI_SSID,
        WIFI_PASSWORD
    );


    while (
        WiFi.status() !=
        WL_CONNECTED
    )
    {
        delay(500);

        Serial.print(".");
    }


    Serial.println();

    Serial.println(
        "WiFi connected!"
    );


    Serial.print(
        "TinyS3 IP: "
    );


    Serial.println(
        WiFi.localIP()
    );


    Serial.print(
        "RSSI: "
    );


    Serial.print(
        WiFi.RSSI()
    );


    Serial.println(
        " dBm"
    );
}


// ============================================================
// WEBSOCKET EVENT
// ============================================================

void webSocketEvent(
    uint8_t num,
    WStype_t type,
    uint8_t* payload,
    size_t length)
{
    switch (type)
    {
        case WStype_CONNECTED:

            Serial.printf(
                "WebSocket client connected: %u\n",
                num
            );

            break;


        case WStype_DISCONNECTED:

            Serial.printf(
                "WebSocket client disconnected: %u\n",
                num
            );

            break;


        default:

            break;
    }
}


// ============================================================
// SETUP
// ============================================================

void setup()
{
    Serial.begin(
        115200
    );


    delay(
        2000
    );


    Serial.println();

    Serial.println(
        "=================================="
    );


    Serial.println(
        "AuraSound MIC1 Live Audio"
    );


    Serial.println(
        "=================================="
    );


    if (
        !setupI2S()
    )
    {
        Serial.println(
            "I2S FAILED"
        );


        while (true)
        {
            delay(1000);
        }
    }


    connectWiFi();


    // --------------------------------------------------------
    // HTTP
    // --------------------------------------------------------

    server.on(
        "/",
        HTTP_GET,
        []()
        {
            server.send(
                200,
                "text/html",
                PAGE
            );
        }
    );


    server.begin();


    // --------------------------------------------------------
    // WebSocket
    // --------------------------------------------------------

    webSocket.begin();


    webSocket.onEvent(
        webSocketEvent
    );


    Serial.println();

    Serial.println(
        "HTTP server started."
    );


    Serial.println(
        "WebSocket server started."
    );


    Serial.println();

    Serial.print(
        "OPEN ON PHONE: http://"
    );


    Serial.println(
        WiFi.localIP()
    );
}


// ============================================================
// LOOP
// ============================================================

void loop()
{
    server.handleClient();

    webSocket.loop();


    // --------------------------------------------------------
    // READ I2S
    // --------------------------------------------------------

    size_t bytesRead =
        0;


    esp_err_t err =
        i2s_channel_read(
            rxChannel,
            i2sBuffer,
            sizeof(i2sBuffer),
            &bytesRead,
            100
        );


    if (
        err != ESP_OK
    )
    {
        return;
    }


    int frames =
        bytesRead /
        (
            sizeof(int32_t) *
            2
        );


    if (
        frames <= 0
    )
    {
        return;
    }


    // --------------------------------------------------------
    // EXTRACT MIC1 ONLY
    //
    // LEFT I2S SLOT
    // --------------------------------------------------------

    for (
        int i = 0;
        i < frames;
        i++
    )
    {
        int32_t rawMic1 =
            i2sBuffer[
                i * 2
            ];


        audioBuffer[i] =
            convertMicSample(
                rawMic1
            );
    }


    // --------------------------------------------------------
    // Send binary PCM to every connected browser
    // --------------------------------------------------------

    webSocket.broadcastBIN(
        (uint8_t*)audioBuffer,
        frames *
        sizeof(int16_t)
    );
}
