// Local mock backend for HUD development (C2). Replays a scripted event
// stream on ws://127.0.0.1:8000/ws so the frontend can be built and tested
// before server/main.py exists. Run: node web/dev/mock-ws.mjs
import { WebSocketServer } from "ws";

const PORT = 8000;
const wss = new WebSocketServer({ port: PORT, path: "/ws" });
console.log(`[mock-ws] listening on ws://127.0.0.1:${PORT}/ws`);

const CALIB = {
  baseline_m: 0.24,
  spacing_m: 0.08,
  head_yaw_offset_deg: 0.0,
  camera_fov_deg: 62.0,
  audio_delay_ms: 18.0,
};

let clientSeq = 0;

wss.on("connection", (ws) => {
  const id = ++clientSeq;
  console.log(`[mock-ws] client ${id} connected`);
  const t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;

  const send = (msg) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ ...msg, t: now() }));
  };

  send({
    type: "backend_status",
    model: "yamnet",
    model_path: "models/yamnet.tflite",
    model_sha256: "mock0000000000000000000000000000000000000000000000000000000000",
    classes: 521,
    sample_rate: 16000,
    transport: "mock",
    git_rev: "mock",
  });

  send({
    type: "array_status",
    mics: [
      { id: 0, ok: true },
      { id: 1, ok: true },
      { id: 2, ok: true },
      { id: 3, ok: true },
    ],
    calibration: CALIB,
    transport: "mock",
  });

  const statusTimer = setInterval(() => {
    send({
      type: "backend_status",
      model: "yamnet",
      model_path: "models/yamnet.tflite",
      model_sha256: "mock0000000000000000000000000000000000000000000000000000000000",
      classes: 521,
      sample_rate: 16000,
      transport: "mock",
      git_rev: "mock",
    });
  }, 10_000);

  const arrayTimer = setInterval(() => {
    send({
      type: "array_status",
      mics: [
        { id: 0, ok: true },
        { id: 1, ok: true },
        { id: 2, ok: true },
        { id: 3, ok: true },
      ],
      calibration: CALIB,
      transport: "mock",
    });
  }, 2_000);

  // Scripted demo-beat loop, restarts every LOOP_MS.
  const LOOP_MS = 15_000;
  let evCounter = 0;
  const nextId = (prefix) => `${prefix}${++evCounter}`;

  const scriptTimers = [];
  const schedule = (delayMs, fn) => scriptTimers.push(setTimeout(fn, delayMs));

  const runScript = () => {
    // 1. Clapping, left-behind, unambiguous.
    schedule(1_000, () => {
      send({
        type: "sound_event",
        id: nextId("clap"),
        class: "Clapping",
        confidence: 0.92,
        bearing_deg: -40,
        elevation_deg: null,
        accuracy_deg: 8,
        ambiguous: false,
        urgency: "normal",
        source: "array",
      });
    });

    // 2. Speech near center, right where a face should be -> anchors to a face.
    schedule(3_000, () => {
      const evId = nextId("speech_ev");
      send({
        type: "sound_event",
        id: evId,
        class: "Speech",
        confidence: 0.88,
        bearing_deg: 10,
        elevation_deg: null,
        accuracy_deg: 10,
        ambiguous: false,
        urgency: "normal",
        source: "array",
      });
      schedule(600, () =>
        send({
          type: "speech",
          id: nextId("speech_txt"),
          parent_event: evId,
          bearing_deg: 10,
          text: "did you see that",
          partial: false,
          confidence: 0.78,
          lang: "en",
        })
      );
    });

    // 2b. A second, simultaneous speaker off to the side (off-FOV) -- tests
    // that two live speech bubbles at once don't collide, and that this one
    // correctly renders in the "directional" (docked-to-edge-arrow) style
    // while 2's is anchored/in-frame at the same time.
    schedule(3_300, () => {
      const evId = nextId("speech2_ev");
      send({
        type: "sound_event",
        id: evId,
        class: "Speech",
        confidence: 0.84,
        bearing_deg: -60,
        elevation_deg: null,
        accuracy_deg: 14,
        ambiguous: false,
        urgency: "normal",
        source: "array",
      });
      schedule(500, () =>
        send({
          type: "speech",
          id: nextId("speech2_txt"),
          parent_event: evId,
          bearing_deg: -60,
          text: "over here too",
          partial: false,
          confidence: 0.72,
          lang: "en",
        })
      );
    });

    // 3. "Playback" speech: off to a side where no face is expected -> no anchor.
    schedule(6_000, () => {
      const evId = nextId("playback_ev");
      send({
        type: "sound_event",
        id: evId,
        class: "Speech",
        confidence: 0.81,
        bearing_deg: -25,
        elevation_deg: null,
        accuracy_deg: 15,
        ambiguous: false,
        urgency: "normal",
        source: "array",
      });
      schedule(500, () =>
        send({
          type: "speech",
          id: nextId("playback_txt"),
          parent_event: evId,
          bearing_deg: -25,
          text: "this is a recorded announcement",
          partial: false,
          confidence: 0.7,
          lang: "en",
        })
      );
    });

    // 4. Ambiguous event: linear-array front/back ambiguity -> two mirrored candidates.
    schedule(8_500, () => {
      send({
        type: "sound_event",
        id: nextId("dog"),
        class: "Dog",
        confidence: 0.73,
        bearing_deg: -100,
        elevation_deg: null,
        accuracy_deg: 18,
        ambiguous: true,
        urgency: "normal",
        source: "array",
      });
    });

    // 5. Urgent alarm, off to the right rear -> should displace everything.
    schedule(10_500, () => {
      send({
        type: "sound_event",
        id: nextId("alarm"),
        class: "Alarm",
        confidence: 0.95,
        bearing_deg: 120,
        elevation_deg: null,
        accuracy_deg: 20,
        ambiguous: false,
        urgency: "urgent",
        source: "array",
      });
    });
  };

  runScript();
  const loopTimer = setInterval(runScript, LOOP_MS);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping") {
        send({ type: "pong", t_echo: msg.t });
      } else {
        console.log(`[mock-ws] client ${id} ->`, msg);
      }
    } catch {
      console.log(`[mock-ws] client ${id} sent non-JSON:`, data.toString());
    }
  });

  ws.on("close", () => {
    console.log(`[mock-ws] client ${id} disconnected`);
    clearInterval(statusTimer);
    clearInterval(arrayTimer);
    clearInterval(loopTimer);
    for (const t of scriptTimers) clearTimeout(t);
  });
});
