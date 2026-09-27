// AuraSound 4-mic monitor -- the phone-facing app, served by aura4.ino over HTTP :80.
//
// One file, no build step, no dependencies. It speaks the same framing the hat will send over
// UDP (README 4.2), so what you hear here is byte-for-byte what the backend will later ingest:
//
//   u16 magic 0xA14D | u8 version | u8 nch | u32 seq | u64 t_us | u16 nsamp | i16 samples[nch][nsamp]
//
// Edit this file freely: it is a C++ raw string literal, so no escaping is needed anywhere except
// the literal's own terminator, which must never appear in the page.
#pragma once

static const char PAGE_HTML[] PROGMEM = R"rawliteral(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AuraSound 4-mic monitor</title>
<style>
  :root {
    --bg: #101318; --card: #1b2028; --card2: #222833; --line: #303944;
    --fg: #eef2f7; --dim: #929ca8; --accent: #4bbcff; --warn: #ffb340; --bad: #ff5f56;
    --ok: #46d17f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    padding: 12px 12px 40px;
  }
  .wrap { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 19px; margin: 4px 0 2px; }
  h1 span { color: var(--dim); font-weight: 400; font-size: 14px; }
  .card { background: var(--card); border-radius: 14px; padding: 14px; margin-top: 12px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .07em; color: var(--dim); margin: 0 0 10px; }
  .row { display: flex; gap: 8px; align-items: center; }
  .grow { flex: 1; min-width: 0; }
  button {
    font: inherit; font-weight: 600; color: #04121c; background: var(--accent);
    border: 0; border-radius: 10px; padding: 12px 14px; min-width: 92px;
  }
  button.ghost { background: var(--card2); color: var(--fg); border: 1px solid var(--line); }
  button.on { background: var(--bad); color: #fff; }
  button.live { background: var(--ok); }
  button:disabled { opacity: .45; }
  select, input[type=range] { font: inherit; color: var(--fg); background: var(--card2);
    border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
  input[type=range] { padding: 0; height: 28px; width: 100%; }
  .pill { display: inline-block; font-size: 12px; font-weight: 700; padding: 3px 9px; border-radius: 999px;
    background: var(--card2); color: var(--dim); border: 1px solid var(--line); }
  .pill.ok { color: #04121c; background: var(--ok); border-color: var(--ok); }
  .pill.bad { color: #fff; background: var(--bad); border-color: var(--bad); }
  .pill.warn { color: #241703; background: var(--warn); border-color: var(--warn); }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 6px 10px;
    font-size: 12px; color: var(--dim); margin-top: 10px; }
  .stats b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
  .ch { border-top: 1px solid var(--line); padding-top: 10px; margin-top: 10px; }
  .ch:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
  .chhead { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
  .chhead .name { font-weight: 700; letter-spacing: .02em; }
  .chhead .geo { color: var(--dim); font-size: 11px; }
  .chhead .val { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--dim); }
  .bar { position: relative; height: 14px; background: var(--line); border-radius: 7px; overflow: hidden; margin: 6px 0; }
  .bar .fill { height: 100%; width: 0%; background: linear-gradient(90deg, var(--ok), var(--accent)); transition: width .06s linear; }
  .bar .hold { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; left: 0; opacity: .8; }
  .bar.hot .fill { background: linear-gradient(90deg, var(--warn), var(--bad)); }
  .ctrls { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--dim); }
  .ctrls label { display: flex; align-items: center; gap: 4px; }
  .ctrls .gain { flex: 1; min-width: 70px; }
  .flags { display: flex; gap: 6px; flex-wrap: wrap; font-size: 11px; margin-top: 2px; }
  .flag { padding: 2px 7px; border-radius: 6px; background: var(--card2); color: var(--dim); }
  .flag.hot { background: var(--warn); color: #241703; }
  .flag.bad { background: var(--bad); color: #fff; }
  .legend { color: var(--dim); font-size: 11px; margin-top: 10px; }
  .files a { display: block; color: var(--accent); font-size: 13px; padding: 7px 0; text-decoration: none;
    border-top: 1px solid var(--line); }
  .files a:first-child { border-top: 0; }
  .files a b { color: var(--fg); }
  .log { font: 11px/1.5 ui-monospace, Menlo, Consolas, monospace; color: var(--dim); max-height: 108px;
    overflow-y: auto; white-space: pre-wrap; }
  .msg { color: var(--warn); font-size: 12px; margin-top: 8px; }
  .hidden { display: none; }
</style>
</head>
<body>
<div class="wrap">

  <h1>AuraSound <span>4-mic live monitor</span></h1>
  <div class="row">
    <span class="pill" id="linkPill">connecting</span>
    <span class="pill" id="recPill">idle</span>
    <span class="grow"></span>
    <button id="listenBtn" class="ghost">Listen</button>
    <button id="recBtn">Record</button>
  </div>
  <div class="msg hidden" id="msg"></div>

  <div class="card">
    <h2>Stream</h2>
    <div class="stats" id="streamStats"></div>
    <div class="stats" id="fwStats"></div>
  </div>

  <div class="card">
    <h2>Channels</h2>
    <div id="channels"></div>
    <div class="legend" id="legend"></div>
  </div>

  <div class="card">
    <h2>Monitor</h2>
    <div class="row">
      <label class="grow" style="font-size:12px;color:var(--dim)">
        Listen to
        <select id="mode" style="width:100%;margin-top:4px">
          <option value="mix">Mix of all four</option>
          <option value="m0">m0 only</option>
          <option value="m1">m1 only</option>
          <option value="m2">m2 only</option>
          <option value="m3">m3 only</option>
          <option value="left">Left pair (m0 + m2)</option>
          <option value="right">Right pair (m1 + m3)</option>
        </select>
      </label>
    </div>
    <div class="row" style="margin-top:10px">
      <span style="font-size:12px;color:var(--dim)">Volume</span>
      <input id="vol" type="range" min="0" max="150" value="100" class="grow">
      <span id="volVal" style="font-size:12px;width:38px;text-align:right">100%</span>
    </div>
    <div class="stats" id="monStats"></div>
  </div>

  <div class="card">
    <h2>Recording</h2>
    <div class="stats" id="recStats"></div>
    <div class="files" id="files"></div>
    <div class="legend">
      Stop a recording to get the files. The 4-channel WAV and one mono WAV per mic are raw
      captures; mix.wav is the average of the four with the channel gains above applied.
    </div>
  </div>

  <div class="card">
    <h2>Log</h2>
    <div class="log" id="log"></div>
  </div>

</div>

<script>
"use strict";

// ---------------------------------------------------------------- constants / helpers

var PARAMS = new URLSearchParams(location.search);
// ?ws= overrides where the socket points, exactly as the HUD does (README section "Different socket").
var WS_URL = PARAMS.get("ws") || ((location.protocol === "https:" ? "wss://" : "ws://") + location.hostname + ":81/");

var PKT_MAGIC = 0xA14D, PKT_HEADER = 18, NCH = 4;
var RING_SECONDS = 3, MAX_REC_SECONDS = 120; // the capture lives in memory: 120 s x 4 ch = 15 MB of PCM
var LEAD_S = 0.12;                 // playback lead: absorbs Wi-Fi jitter, ~1 block of margin
// If the hat's 16 kHz clock runs even 100 ppm fast, the scheduled buffer creeps up for the whole
// session. Cap it and jump forward: latency matters more than a click nobody can hear.
var MAX_BUFFER_S = 0.35;
var SILENT_LSB = 20;               // README 7/A4: silence is "tens of LSB"
var DC_LSB = 100;                  // a real DC ramp is far above this
var CLIP_LSB = 32760;
// A backwards or absurdly large seq step is a hat that rebooted (seq restarts at 0), not 4 billion lost
// packets: a real gap is at most a few packets, so anything past 5 s of audio is a new session.
var MAX_PLAUSIBLE_GAP = 250;
var RECONNECT_MS = [500, 1000, 2000, 4000, 8000];

// config/array.json, hat frame: -x is the wearer's left. Channel order off the wire is bus-major,
// L then R, i.e. mic0 = bus0 L ... mic3 = bus1 R.
var MICS = [
  { id: 0, bus: 0, lr: "L", x_mm: -120 },
  { id: 1, bus: 0, lr: "R", x_mm: -40 },
  { id: 2, bus: 1, lr: "L", x_mm: 40 },
  { id: 3, bus: 1, lr: "R", x_mm: 120 }
];
var MODES = {
  mix:   [1, 1, 1, 1],
  m0:    [1, 0, 0, 0], m1: [0, 1, 0, 0], m2: [0, 0, 1, 0], m3: [0, 0, 0, 1],
  left:  [1, 0, 1, 0], right: [0, 1, 0, 1]
};

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function dbfs(lsb) { return lsb <= 0.5 ? -Infinity : 20 * Math.log10(lsb / 32768); }
function dbfsText(db) { return db === -Infinity ? "-inf" : db.toFixed(1); }
function pct(lsb) { return clamp((dbfs(lsb) + 60) / 60 * 100, 0, 100); }
function nowS() { return performance.now() / 1000; }

// ---------------------------------------------------------------- state

var st = {
  link: {
    url: WS_URL, state: "connecting", hello: null, packets: 0, bytes: 0, seqGaps: 0, lost: 0,
    bad: 0, lastSeq: null, rateHz: 16000, trunc: 0, errors: [], pps: 0, kbps: 0, lastCount: 0,
    dupes: 0, restarts: 0
  },
  ch: MICS.map(function (m) {
    return {
      mic: m, rms: 0, peak: 0, dc: 0, clips: 0, silent: true, mute: false, solo: false, gain: 1,
      updatedMs: 0
    };
  }),
  mon: {
    listening: false, mode: "mix", volume: 1, bufferMs: 0, underruns: 0, resyncs: 0,
    scheduledFrames: 0, dominantHz: 0, dominantDb: -Infinity, playedBlocks: 0
  },
  rec: { armed: false, frames: 0, startedS: 0, chunks: [], files: [], autoStopped: false }
};

var ctx = null, master = null, analyser = null, freqData = null;
var nextPlaybackTime = 0, lastLevelMs = 0;
var ring = [], ringCount = 0, ringPos = 0;

function initRing(rate) {
  var n = Math.round(RING_SECONDS * rate);
  ring = [];
  for (var c = 0; c < NCH; c++) ring.push(new Int16Array(n));
  ringCount = 0; ringPos = 0;
}
initRing(st.link.rateHz);

function note(msg) {
  st.link.errors.push({ t: nowS(), msg: msg });
  if (st.link.errors.length > 40) st.link.errors.shift();
  renderLog();
}

// ---------------------------------------------------------------- websocket

var ws = null, reconnectTries = 0, reconnectTimer = null;

function connect() {
  clearTimeout(reconnectTimer);
  st.link.state = "connecting";
  renderPills();
  try {
    ws = new WebSocket(st.link.url);
  } catch (e) {
    note("cannot open " + st.link.url + ": " + e.message);
    st.link.state = "error";
    scheduleReconnect();
    return;
  }
  ws.binaryType = "arraybuffer";
  ws.onopen = function () {
    st.link.state = "open"; reconnectTries = 0;
    st.link.lastSeq = null; // a new session: the hat may have rebooted and restarted its seq
    renderPills();
    note("connected " + st.link.url);
  };
  ws.onclose = function () {
    if (st.link.state !== "closed") note("socket closed");
    st.link.state = "closed";
    renderPills();
    scheduleReconnect();
  };
  ws.onerror = function () { note("socket error"); };
  ws.onmessage = function (ev) {
    if (typeof ev.data === "string") { onText(ev.data); return; }
    onPacket(ev.data);
  };
}

function scheduleReconnect() {
  var ms = RECONNECT_MS[Math.min(reconnectTries, RECONNECT_MS.length - 1)];
  reconnectTries++;
  reconnectTimer = setTimeout(connect, ms);
}

function onText(text) {
  var msg;
  try { msg = JSON.parse(text); } catch (e) { st.link.trunc++; note("bad JSON frame"); return; }
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "hello") {
    var first = st.link.hello === null;
    st.link.hello = msg;
    if (typeof msg.rate === "number" && msg.rate > 0 && msg.rate !== st.link.rateHz) {
      st.link.rateHz = msg.rate;
      initRing(msg.rate);
      nextPlaybackTime = 0;
    }
    if (first) note("hat says: " + msg.rate + " Hz, " + msg.nch + " ch, fw " + (msg.fw || "?"));
  }
}

// ---------------------------------------------------------------- one audio packet

function onPacket(ab) {
  var link = st.link;
  if (ab.byteLength < PKT_HEADER) { link.bad++; note("short frame " + ab.byteLength + " B"); return; }
  var dv = new DataView(ab);
  if (dv.getUint16(0, true) !== PKT_MAGIC) { link.bad++; note("bad magic"); return; }
  var ver = dv.getUint8(2), nch = dv.getUint8(3);
  var seq = dv.getUint32(4, true);
  var nsamp = dv.getUint16(16, true);
  if (nch < 1 || nch > NCH || nsamp < 1 || ab.byteLength !== PKT_HEADER + nch * nsamp * 2) {
    link.bad++;
    note("bad framing: ver=" + ver + " nch=" + nch + " nsamp=" + nsamp + " bytes=" + ab.byteLength);
    return;
  }
  if (link.lastSeq !== null) {
    var d = (seq - link.lastSeq) >>> 0;
    if (d === 0) link.dupes++;
    else if (d > MAX_PLAUSIBLE_GAP) link.restarts++;
    else if (d !== 1) { link.seqGaps++; link.lost += d - 1; }
  }
  link.lastSeq = seq;
  link.packets++;
  link.bytes += ab.byteLength;

  var views = [];
  for (var c = 0; c < nch; c++) {
    views.push(new Int16Array(ab, PKT_HEADER + c * nsamp * 2, nsamp));
  }
  for (var i = 0; i < nch; i++) meterBlock(i, views[i]);
  pushRing(views, nch);
  if (st.rec.armed) recordBlock(views, nch);
  monitorBlock(views, nch, st.link.rateHz);
}

function meterBlock(c, v) {
  var sum = 0, mean = 0, peak = 0, clips = 0, a, s;
  for (var i = 0; i < v.length; i++) {
    s = v[i];
    sum += s * s;
    mean += s;
    a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    if (a >= CLIP_LSB) clips++;
  }
  var n = v.length;
  var rms = Math.sqrt(sum / n), dc = mean / n;
  var ch = st.ch[c];
  ch.rms = ch.rms === 0 ? rms : ch.rms * 0.7 + rms * 0.3;
  ch.dc = ch.dc * 0.9 + dc * 0.1;
  ch.peak = Math.max(peak, ch.peak * 0.97);
  ch.clips += clips;
  ch.silent = ch.rms < SILENT_LSB;
  ch.updatedMs = performance.now();
}

function pushRing(views, nch) {
  var n = views[0].length;
  for (var c = 0; c < NCH; c++) {
    var r = ring[c], v = c < nch ? views[c] : null;
    if (!v) { continue; }
    if (n >= r.length) { r.set(v.subarray(n - r.length)); continue; }
    var p = ringPos;
    var first = Math.min(n, r.length - p);
    r.set(v.subarray(0, first), p);
    if (first < n) r.set(v.subarray(first), 0);
  }
  if (ring.length && views[0].length < ring[0].length) ringPos = (ringPos + views[0].length) % ring[0].length;
  ringCount = Math.min(ringCount + views[0].length, ring[0].length);
}

function recordBlock(views, nch) {
  var rec = st.rec;
  if (rec.chunks.length === 0) {
    for (var c = 0; c < NCH; c++) rec.chunks.push([]);
    rec.startedS = nowS();
  }
  for (var i = 0; i < NCH; i++) rec.chunks[i].push(new Int16Array(i < nch ? views[i] : new Int16Array(views[0].length)));
  rec.frames += views[0].length;
  if (rec.frames / st.link.rateHz >= MAX_REC_SECONDS) { stopRecording(true); }
}

// ---------------------------------------------------------------- playback

function weights() {
  var base = MODES[st.mon.mode] || MODES.mix;
  var soloed = st.ch.some(function (c) { return c.solo; });
  var w = [];
  for (var i = 0; i < NCH; i++) {
    var on = base[i] && !st.ch[i].mute && (!soloed || st.ch[i].solo);
    w.push(on ? st.ch[i].gain : 0);
  }
  return w;
}

function ensureAudio() {
  if (ctx) return true;
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { note("no Web Audio in this browser"); return false; }
  // No explicit sampleRate: buffers carry the stream's own rate and Web Audio resamples. That keeps
  // this working on phones whose output device refuses 16 kHz.
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = st.mon.volume;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 8192; // 5.9 Hz bins at 48 kHz: the tone readout lands on the real pitch
  analyser.smoothingTimeConstant = 0.4;
  freqData = new Float32Array(analyser.frequencyBinCount);
  master.connect(analyser);
  master.connect(ctx.destination);
  return true;
}

function monitorBlock(views, nch, rate) {
  if (!st.mon.listening || !ctx) return;
  var n = views[0].length;
  var w = weights();
  var any = false;
  for (var i = 0; i < NCH; i++) if (w[i] !== 0) any = true;
  if (!any) return;

  var mix = new Float32Array(n);
  for (var c = 0; c < NCH; c++) {
    var g = w[c];
    if (g === 0) continue;
    var v = c < nch ? views[c] : null;
    if (!v) continue;
    for (var k = 0; k < n; k++) mix[k] += v[k] * g / 32768;
  }

  var buf = ctx.createBuffer(1, n, rate);
  buf.copyToChannel(mix, 0);
  var src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(master);

  var now = ctx.currentTime;
  if (nextPlaybackTime - now > MAX_BUFFER_S) {
    st.mon.resyncs++;
    nextPlaybackTime = now + LEAD_S;
  } else if (nextPlaybackTime < now + 0.03) {
    if (st.mon.scheduledFrames > 0) st.mon.underruns++;
    nextPlaybackTime = now + LEAD_S;
  }
  src.start(nextPlaybackTime);
  nextPlaybackTime += buf.duration;
  st.mon.scheduledFrames += n;
  st.mon.playedBlocks++;
}

function updateAnalyser() {
  if (!analyser) return;
  analyser.getFloatFrequencyData(freqData);
  var rate = ctx.sampleRate, binHz = rate / analyser.fftSize;
  var best = -Infinity, bestI = 0;
  var lo = Math.max(1, Math.floor(60 / binHz)), hi = Math.min(freqData.length - 1, Math.floor(4000 / binHz));
  for (var i = lo; i <= hi; i++) if (freqData[i] > best) { best = freqData[i]; bestI = i; }
  st.mon.dominantHz = bestI * binHz;
  st.mon.dominantDb = best;
  st.mon.bufferMs = Math.max(0, (nextPlaybackTime - ctx.currentTime) * 1000);
}

// ---------------------------------------------------------------- recording

function startRecording() {
  if (!ensureAudio()) return;
  if (ctx.state === "suspended") ctx.resume();
  st.rec = { armed: true, frames: 0, startedS: nowS(), chunks: [], files: [], autoStopped: false };
  clearFiles();
  renderPills();
  note("recording started");
}

function stopRecording(auto) {
  var rec = st.rec;
  rec.armed = false;
  rec.autoStopped = !!auto;
  var rate = st.link.rateHz;
  if (rec.frames === 0) { renderPills(); note("nothing recorded"); return; }

  var channels = [];
  for (var c = 0; c < NCH; c++) channels.push(concat(rec.chunks[c], rec.frames));

  var files = [];
  files.push({ name: "mix.wav", blob: wavBlob([mixdown(channels, rec.frames, weights())], rate, 1), note: "average of the four, gains applied" });
  files.push({ name: "4ch.wav", blob: wavBlob(channels, rate, NCH), note: "raw, one channel per mic" });
  for (var i = 0; i < NCH; i++) {
    files.push({ name: "mic" + i + ".wav", blob: wavBlob([channels[i]], rate, 1), note: "raw mic" + i });
  }
  rec.files = files;
  renderFiles();
  note("recorded " + (rec.frames / rate).toFixed(1) + " s" + (auto ? " (auto-stop at " + MAX_REC_SECONDS + " s)" : ""));
  renderPills();
}

function mixdown(channels, frames, w) {
  var out = new Int16Array(frames), anyGain = 0;
  for (var c = 0; c < NCH; c++) anyGain += w[c];
  if (anyGain === 0) return out;
  for (var i = 0; i < frames; i++) {
    var acc = 0;
    for (var c2 = 0; c2 < NCH; c2++) acc += channels[c2][i] * w[c2];
    out[i] = clamp(Math.round(acc / anyGain), -32768, 32767);
  }
  return out;
}

function concat(chunks, frames) {
  var out = new Int16Array(frames), off = 0;
  for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
  return out;
}

function wavBlob(channels, rate, nch) {
  var frames = channels[0].length;
  var dataBytes = frames * nch * 2;
  var buf = new ArrayBuffer(44 + dataBytes);
  var dv = new DataView(buf);
  var ascii = function (off, s) { for (var i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, "RIFF"); dv.setUint32(4, 36 + dataBytes, true); ascii(8, "WAVE");
  ascii(12, "fmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, nch, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * nch * 2, true);
  dv.setUint16(32, nch * 2, true); dv.setUint16(34, 16, true);
  ascii(36, "data"); dv.setUint32(40, dataBytes, true);
  var off = 44;
  for (var f = 0; f < frames; f++) {
    for (var c = 0; c < nch; c++) { dv.setInt16(off, channels[c][f], true); off += 2; }
  }
  return new Blob([buf], { type: "audio/wav" });
}

function clearFiles() {
  st.rec.files.forEach(function (f) { URL.revokeObjectURL(f.url); });
  st.rec.files = [];
  renderFiles();
}

// ---------------------------------------------------------------- rendering

var chEls = [];

function buildUI() {
  var host = document.getElementById("channels");
  chEls = MICS.map(function (m) {
    var box = el("div", "ch");
    var head = el("div", "chhead");
    head.appendChild(el("span", "name", "m" + m.id));
    head.appendChild(el("span", "geo", "bus" + m.bus + " " + m.lr + "  x=" + m.x_mm + "mm"));
    var val = el("span", "val", "-inf dBFS");
    head.appendChild(val);
    box.appendChild(head);

    var bar = el("div", "bar");
    var fill = el("div", "fill");
    var hold = el("div", "hold");
    bar.appendChild(fill); bar.appendChild(hold);
    box.appendChild(bar);

    var ctrls = el("div", "ctrls");
    var mute = el("button", "ghost", "M");
    mute.style.minWidth = "38px"; mute.style.padding = "6px 8px";
    var solo = el("button", "ghost", "S");
    solo.style.minWidth = "38px"; solo.style.padding = "6px 8px";
    var gain = el("input");
    gain.type = "range"; gain.min = "0"; gain.max = "200"; gain.value = "100";
    gain.className = "gain";
    var gv = el("span", null, "1.00x");
    ctrls.appendChild(mute); ctrls.appendChild(solo); ctrls.appendChild(gain); ctrls.appendChild(gv);
    box.appendChild(ctrls);

    var flags = el("div", "flags");
    box.appendChild(flags);
    host.appendChild(box);

    mute.onclick = function () { var c = st.ch[m.id]; c.mute = !c.mute; mute.className = c.mute ? "on" : "ghost"; renderPills(); };
    solo.onclick = function () { var c = st.ch[m.id]; c.solo = !c.solo; solo.className = c.solo ? "live" : "ghost"; renderPills(); };
    gain.oninput = function () { var g = Number(gain.value) / 100; st.ch[m.id].gain = g; gv.textContent = g.toFixed(2) + "x"; };

    return { head: val, bar: bar, fill: fill, hold: hold, flags: flags, mute: mute, solo: solo };
  });

  var legend = document.getElementById("legend");
  legend.textContent = "m0 bus0-L x=-120mm  |  m1 bus0-R x=-40mm  |  m2 bus1-L x=+40mm  |  m3 bus1-R x=+120mm" +
    "   (hat frame: -x is the wearer's left, per config/array.json)";

  document.getElementById("listenBtn").onclick = toggleListen;
  document.getElementById("recBtn").onclick = function () { st.rec.armed ? stopRecording(false) : startRecording(); };
  document.getElementById("mode").onchange = function (e) { st.mon.mode = e.target.value; };
  document.getElementById("vol").oninput = function (e) {
    st.mon.volume = Number(e.target.value) / 100;
    document.getElementById("volVal").textContent = e.target.value + "%";
    if (master) master.gain.value = st.mon.volume;
  };
}

function toggleListen() {
  if (st.mon.listening) {
    st.mon.listening = false;
    nextPlaybackTime = 0;
    renderPills();
    note("monitor off");
    return;
  }
  if (!ensureAudio()) return;
  ctx.resume();
  st.mon.listening = true;
  nextPlaybackTime = 0;
  renderPills();
  note("monitor on: " + st.mon.mode + " at " + Math.round(st.mon.volume * 100) + "%");
}

function renderPills() {
  var lp = document.getElementById("linkPill");
  var h = st.link.hello;
  if (st.link.state === "open") {
    lp.className = "pill " + (st.link.bad > 0 ? "warn" : "ok");
    lp.textContent = "link ok" + (h ? "  " + h.rate + " Hz" : "");
  } else if (st.link.state === "connecting") {
    lp.className = "pill"; lp.textContent = "connecting";
  } else {
    lp.className = "pill bad"; lp.textContent = "no link";
  }

  var rp = document.getElementById("recPill");
  var secs = st.rec.frames / (st.link.rateHz || 16000);
  rp.className = "pill " + (st.rec.armed ? "bad" : "");
  rp.textContent = st.rec.armed ? "rec " + secs.toFixed(1) + " s" : (st.rec.frames ? "rec stopped " + secs.toFixed(1) + " s" : "idle");

  var lb = document.getElementById("listenBtn");
  lb.className = st.mon.listening ? "live" : "ghost";
  lb.textContent = st.mon.listening ? "Listening" : "Listen";

  var rb = document.getElementById("recBtn");
  rb.className = st.rec.armed ? "on" : "";
  rb.textContent = st.rec.armed ? "Stop" : "Record";
}

function stats(host, pairs) {
  var h = document.getElementById(host);
  while (h.firstChild) h.removeChild(h.firstChild);
  pairs.forEach(function (p) {
    var d = el("div");
    d.appendChild(el("span", null, p[0] + " "));
    d.appendChild(el("b", null, p[1]));
    h.appendChild(d);
  });
}

function renderLog() {
  var l = document.getElementById("log");
  l.textContent = st.link.errors.map(function (e) {
    return e.t.toFixed(2) + "s  " + e.msg;
  }).join("\n");
  l.scrollTop = l.scrollHeight;
}

function renderFiles() {
  var host = document.getElementById("files");
  while (host.firstChild) host.removeChild(host.firstChild);
  st.rec.files.forEach(function (f) {
    if (!f.url) f.url = URL.createObjectURL(f.blob);
    var a = el("a");
    a.href = f.url;
    a.download = f.name;
    a.appendChild(el("b", null, f.name));
    a.appendChild(el("span", null, "  " + (f.blob.size / 1024).toFixed(0) + " kB - " + f.note));
    host.appendChild(a);
  });
}

function renderMsg() {
  var m = document.getElementById("msg");
  var txt = "";
  if (st.link.state !== "open") txt = "Waiting for the hat on " + st.link.url + ".";
  else if (!st.mon.listening) txt = "Link is live. Tap Listen to hear the mics.";
  else if (st.mon.underruns > 3) txt = "Playback underruns (" + st.mon.underruns + ") - Wi-Fi jitter is beating the " + LEAD_S * 1000 + " ms buffer.";
  if (txt) { m.textContent = txt; m.className = "msg"; } else { m.className = "msg hidden"; }
}

var uiTimer = 0;

function render(ts) {
  if (ts - uiTimer > 66) {
    uiTimer = ts;
    var mon = st.mon;
    if (mon.listening) updateAnalyser();
    st.link.pps = 0;

    stats("streamStats", [
      ["socket", st.link.state],
      ["packets", st.link.packets],
      ["seq gaps", st.link.seqGaps + (st.link.lost ? " (" + st.link.lost + " lost)" : "") +
        (st.link.restarts ? " / " + st.link.restarts + " restart" : "") +
        (st.link.dupes ? " / " + st.link.dupes + " dup" : "")],
      ["bad frames", st.link.bad],
      ["data", (st.link.bytes / 1048576).toFixed(2) + " MB"],
      ["buffer", mon.listening ? mon.bufferMs.toFixed(0) + " ms" : "-"]
    ]);
    var h = st.link.hello;
    var pins = h && h.pins ? "bus0 " + h.pins.bus0.join("/") + "  bus1 " + h.pins.bus1.join("/") : "-";
    stats("fwStats", [
      ["rate", (h && h.rate ? h.rate : st.link.rateHz) + " Hz"],
      ["block", (h && h.block ? h.block : "-") + " samp"],
      ["firmware", h && h.fw ? h.fw : "-"],
      ["pins BCLK/WS/DIN", pins],
      ["hat counters", h && typeof h.overflows === "number"
        ? h.overflows + " ovf, " + h.stalls + " stall, " + h.short_reads + " short" : "-"],
      ["rssi", h && typeof h.rssi === "number" ? h.rssi + " dBm" : "-"],
      ["uptime", h && typeof h.uptime === "number" ? h.uptime + " s" : "-"]
    ]);
    stats("monStats", [
      ["listening", mon.listening ? "yes" : "no"],
      ["mode", mon.mode + "  weights " + weights().join(",")],
      ["volume", Math.round(mon.volume * 100) + "%"],
      ["played", (mon.scheduledFrames / (st.link.rateHz || 16000)).toFixed(1) + " s"],
      ["underruns", mon.underruns + " / " + mon.resyncs + " resync"],
      ["dominant tone", mon.listening && mon.dominantHz ? mon.dominantHz.toFixed(0) + " Hz (" + mon.dominantDb.toFixed(0) + " dB)" : "-"]
    ]);
    var secs = st.rec.frames / (st.link.rateHz || 16000);
    stats("recStats", [
      ["state", st.rec.armed ? "recording" : (st.rec.frames ? "stopped" : "idle")],
      ["length", secs.toFixed(1) + " s"],
      ["frames", st.rec.frames],
      ["files", st.rec.files.length]
    ]);
    st.link.pps = 0;
  }

  for (var i = 0; i < NCH; i++) {
    var c = st.ch[i], e = chEls[i];
    e.fill.style.width = pct(c.rms).toFixed(1) + "%";
    e.hold.style.left = pct(c.peak).toFixed(1) + "%";
    e.bar.className = c.peak >= CLIP_LSB || c.clips > 0 ? "bar hot" : "bar";
    e.head.textContent = dbfsText(dbfs(c.rms)) + " dBFS   peak " + c.peak.toFixed(0) + " lsb";
    while (e.flags.firstChild) e.flags.removeChild(e.flags.firstChild);
    var silent = el("span", "flag " + (c.silent ? "hot" : ""), c.silent ? "silent" : "signal");
    var dc = el("span", "flag " + (Math.abs(c.dc) > DC_LSB ? "bad" : ""), "dc " + c.dc.toFixed(1) + " lsb");
    var cl = el("span", "flag " + (c.clips ? "bad" : ""), "clips " + c.clips);
    e.flags.appendChild(silent); e.flags.appendChild(dc); e.flags.appendChild(cl);
  }

  renderPills();
  renderMsg();
  requestAnimationFrame(render);
}

// ---------------------------------------------------------------- scripted hooks (read-only)

window.__app = {
  snapshot: function () {
    return {
      link: {
        url: st.link.url, state: st.link.state, packets: st.link.packets, bytes: st.link.bytes,
        seqGaps: st.link.seqGaps, lost: st.link.lost, bad: st.link.bad, lastSeq: st.link.lastSeq,
        dupes: st.link.dupes, restarts: st.link.restarts,
        rateHz: st.link.rateHz, hello: st.link.hello,
        errors: st.link.errors.slice(-10)
      },
      channels: st.ch.map(function (c) {
        return {
          id: c.mic.id, bus: c.mic.bus, lr: c.mic.lr, x_mm: c.mic.x_mm,
          rms_lsb: c.rms, rms_dbfs: dbfs(c.rms), peak_lsb: c.peak, dc_lsb: c.dc,
          silent: c.silent, clips: c.clips, mute: c.mute, solo: c.solo, gain: c.gain
        };
      }),
      monitor: {
        listening: st.mon.listening, mode: st.mon.mode, weights: weights(), volume: st.mon.volume,
        buffer_ms: st.mon.bufferMs, underruns: st.mon.underruns, resyncs: st.mon.resyncs,
        scheduled_frames: st.mon.scheduledFrames,
        played_blocks: st.mon.playedBlocks, dominant_hz: st.mon.dominantHz,
        context_state: ctx ? ctx.state : "none", context_rate: ctx ? ctx.sampleRate : 0
      },
      record: {
        armed: st.rec.armed, frames: st.rec.frames, seconds: st.rec.frames / (st.link.rateHz || 16000),
        auto_stopped: st.rec.autoStopped,
        files: st.rec.files.map(function (f) { return { name: f.name, bytes: f.blob.size }; })
      }
    };
  },
  // Last RING_SECONDS of received audio for one mic, in chronological order (copy).
  samples: function (c) {
    var r = ring[c];
    if (ringCount < r.length) return r.slice(0, ringCount);
    var out = new Int16Array(r.length);
    out.set(r.subarray(ringPos));
    out.set(r.subarray(0, ringPos), r.length - ringPos);
    return out;
  },
  // The recorded capture for one mic (empty array when nothing was recorded).
  recording: function (c) {
    return st.rec.frames ? concat(st.rec.chunks[c], st.rec.frames) : new Int16Array(0);
  },
  // The exact bytes of an exported file, for checking the WAV container.
  fileBytes: function (name) {
    var f = st.rec.files.filter(function (x) { return x.name === name; })[0];
    if (!f) return Promise.reject(new Error("no such file: " + name));
    return f.blob.arrayBuffer();
  },
  reset: function () {
    st.link.packets = 0; st.link.bytes = 0; st.link.seqGaps = 0; st.link.lost = 0;
    st.link.bad = 0; st.link.lastSeq = null; st.link.errors = [];
    st.link.dupes = 0; st.link.restarts = 0;
    st.mon.underruns = 0; st.mon.resyncs = 0; st.mon.scheduledFrames = 0; st.mon.playedBlocks = 0;
    st.ch.forEach(function (c) { c.clips = 0; });
    clearFiles();
    st.rec = { armed: false, frames: 0, startedS: 0, chunks: [], files: [], autoStopped: false };
    renderLog();
  }
};

buildUI();
renderLog();
renderPills();
renderFiles();
connect();
requestAnimationFrame(render);
</script>
</body>
</html>
)rawliteral";
