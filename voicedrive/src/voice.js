// Hold-to-talk voice layer. AssemblyAI streaming speech-to-text gives the transcript; each finished
// turn then goes through AssemblyAI's LLM Gateway (via /command on our server, which holds the key)
// to become a car command.

import { LLM_PROMPT } from "./commands.js";

const RATE = 16000;
const CHUNK = RATE / 20; // 50 ms of audio per message
const IDLE_CLOSE_MS = 120_000;

// AudioWorklet that hands raw mic frames to the main thread.
const WORKLET = `registerProcessor("tap", class extends AudioWorkletProcessor {
  process(inputs) { if (inputs[0][0]) this.port.postMessage(inputs[0][0]); return true; }
});`;

export function createVoice({
  model, languages = ["en", "es"], keyterms = [], record = false,
  onPartial, onFinal, onCommand, onState, onError, onEvent = () => {},
}) {
  let ws = null;
  let connecting = null;
  let audio = null; // { ctx, stream }
  let pressed = false;
  let releasedAt = null;
  let idleTimer = null;
  let pending = []; // Int16 chunks spoken before the socket opened
  let acc = new Float32Array(0);
  let turnAudio = []; // this turn's chunks, kept only when record is on
  let clipCount = 0;
  let lastPartial = ""; // AssemblyAI occasionally sends an empty final; fall back to the last words heard

  const sinceRelease = () => (releasedAt == null ? null : Math.round(performance.now() - releasedAt));

  async function startMic() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new AudioContext({ sampleRate: RATE }); // Chrome resamples the mic to 16 kHz for us
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
    const node = new AudioWorkletNode(ctx, "tap");
    node.port.onmessage = (e) => feed(e.data);
    ctx.createMediaStreamSource(stream).connect(node);
    audio = { ctx, stream };
  }

  // Collect 16 kHz frames into 50 ms PCM16 chunks: real audio while held, silence otherwise.
  function feed(frame) {
    const out = pressed ? frame : new Float32Array(frame.length);
    const merged = new Float32Array(acc.length + out.length);
    merged.set(acc);
    merged.set(out, acc.length);
    acc = merged;
    while (acc.length >= CHUNK) {
      const pcm = new Int16Array(CHUNK);
      for (let i = 0; i < CHUNK; i++) pcm[i] = Math.max(-1, Math.min(1, acc[i])) * 0x7fff;
      acc = acc.slice(CHUNK);
      if (record && pressed) turnAudio.push(pcm);
      if (ws?.readyState === WebSocket.OPEN) ws.send(pcm.buffer);
      else if (pressed) pending.push(pcm.buffer);
    }
  }

  // The first LLM call of a session can be slow; make it before the driver needs it.
  function warmUp() {
    fetch("/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: LLM_PROMPT.replace("{{turn}}", "Lane left.") }),
    }).catch(() => {});
  }

  async function connect() {
    warmUp();
    const res = await fetch("/token");
    const { token, error } = await res.json();
    if (!token) throw new Error(error || "no token");
    const params = new URLSearchParams({
      token,
      sample_rate: String(RATE),
      encoding: "pcm_s16le",
      speech_model: "assemblyai-stt-3-7-realtime-agent",
      mode: "manual", // turns end only on ForceEndpoint, i.e. when Space is released
      language_codes: JSON.stringify(languages),
    });
    if (keyterms.length) params.set("keyterms_prompt", JSON.stringify(keyterms));
    const sock = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${params}`);
    sock.binaryType = "arraybuffer";
    await new Promise((resolve, reject) => {
      sock.onopen = resolve;
      sock.onerror = () => reject(new Error("could not open the AssemblyAI socket"));
    });
    sock.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      onEvent(`${msg.type}${msg.turn_order != null ? ` #${msg.turn_order}` : ""}${msg.end_of_turn ? " end" : ""}`);
      handle(msg);
    };
    sock.onclose = (e) => {
      onEvent(`socket closed ${e.code} ${e.reason}`);
      if (ws === sock) ws = null;
      onState("off");
      if (e.code !== 1000) onError(`AssemblyAI closed the connection (${e.code}${e.reason ? `: ${e.reason}` : ""})`);
    };
    ws = sock;
    for (const chunk of pending) sock.send(chunk);
    pending = [];
    // Space was released while the socket was still opening: end that turn now.
    if (!pressed && releasedAt != null) sock.send(JSON.stringify({ type: "ForceEndpoint" }));
    onState(pressed ? "listening" : "connected");
  }

  function handle(msg) {
    if (msg.type === "Turn") {
      if (!msg.end_of_turn) {
        if (msg.transcript.trim()) lastPartial = msg.transcript;
        return onPartial(msg.transcript);
      }
      const text = msg.transcript.trim() || lastPartial;
      if (!msg.transcript.trim()) onEvent(`empty final, using last partial: ${lastPartial}`);
      lastPartial = "";
      onFinal(text, sinceRelease());
      if (text.trim()) runCommand(text);
    } else if (msg.type === "Error" || msg.error) {
      onError(msg.error ?? JSON.stringify(msg));
    }
  }

  async function runCommand(text) {
    try {
      const res = await fetch("/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: LLM_PROMPT.replace("{{turn}}", text) }),
      });
      const { content, error } = await res.json();
      if (error) return onError(error);
      onCommand(content, sinceRelease());
    } catch (err) {
      onError(`command failed: ${err.message}`);
    }
  }

  function saveClip() {
    const n = turnAudio.reduce((sum, c) => sum + c.length, 0);
    const all = new Int16Array(n);
    let off = 0;
    for (const c of turnAudio) all.set(c, (off += c.length) - c.length);
    turnAudio = [];
    if (n) fetch(`/clip?name=turn-${Date.now()}-${++clipCount}`, { method: "POST", body: all.buffer });
  }

  function armIdleClose() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => close(), IDLE_CLOSE_MS);
  }

  async function press() {
    if (pressed) return;
    pressed = true;
    releasedAt = null;
    onEvent(`press (socket ${ws ? ["connecting", "open", "closing", "closed"][ws.readyState] : "none"})`);
    clearTimeout(idleTimer);
    onState("listening");
    try {
      if (!audio) await startMic();
      if (!ws) await (connecting ??= connect().finally(() => (connecting = null)));
    } catch (err) {
      pressed = false;
      pending = [];
      onState("off");
      onError(err.message);
    }
  }

  function release() {
    if (!pressed) return;
    pressed = false;
    releasedAt = performance.now();
    if (record) saveClip();
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ForceEndpoint" }));
    onEvent(`release (socket ${ws ? ["connecting", "open", "closing", "closed"][ws.readyState] : "none"})`);
    if (ws) onState("connected");
    armIdleClose();
  }

  function close() {
    clearTimeout(idleTimer);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "Terminate" }));
    ws?.close(1000);
    ws = null;
    onState("off");
  }

  return { press, release, close };
}
