// Kokoro-82M text-to-speech (Apache 2.0) in a Web Worker, so synthesis never
// blocks the stage's animations. Loaded as a module worker by src/ui/kokoro.ts.
//
// In:  {type:"load", gpu?:boolean} | {type:"gen", key, text, voice, speed, prio} | {type:"bump", key, prio} | {type:"drop", below}
// Out: {type:"progress", pct} | {type:"ready", device} | {type:"error", message} | {type:"note", message}
//      {type:"audio", key, samples:Float32Array, sr} | {type:"failed", key, message}

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
let tts = null;
let loading = false;
let busy = false;
let seq = 0;
const queue = [];

const files = new Map();
let shown = 0;
function onProgress(p) {
  if (p.status === "progress" && p.file) {
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    // Files are discovered one after another, so never let the bar go backwards.
    if (total) shown = Math.max(shown, Math.min(99, Math.round((loaded / total) * 100)));
    self.postMessage({ type: "progress", pct: shown });
  }
}

let preferGpu = true;
async function load() {
  if (tts || loading) return;
  loading = true;
  try {
    const { KokoroTTS } = await import("/vendor/kokoro/kokoro.web.js");
    // WebGPU (fp32, ~310 MB once, then cached) renders clips several times faster.
    // Anywhere it is missing or fails, q8 on WebAssembly (~90 MB) runs everywhere.
    let device = "wasm";
    if (preferGpu && self.navigator.gpu) {
      try {
        if (await self.navigator.gpu.requestAdapter()) {
          tts = await KokoroTTS.from_pretrained(MODEL, { dtype: "fp32", device: "webgpu", progress_callback: onProgress });
          await tts.generate("Ready.", { voice: "bm_george" }); // fail here, not mid-auction
          device = "webgpu";
        }
      } catch (e) {
        tts = null;
        self.postMessage({ type: "note", message: "WebGPU voice failed, using WebAssembly: " + String((e && e.message) || e).slice(0, 120) });
      }
    }
    if (!tts) tts = await KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "wasm", progress_callback: onProgress });
    self.postMessage({ type: "ready", device });
    pump();
  } catch (e) {
    self.postMessage({ type: "error", message: String((e && e.message) || e).slice(0, 200) });
  } finally {
    loading = false;
  }
}

async function pump() {
  if (busy || !tts) return;
  busy = true;
  try {
    while (queue.length) {
      queue.sort((a, b) => b.prio - a.prio || a.seq - b.seq);
      const job = queue.shift();
      try {
        const audio = await tts.generate(job.text, { voice: job.voice, speed: job.speed });
        const samples = audio.audio;
        self.postMessage({ type: "audio", key: job.key, samples, sr: audio.sampling_rate }, [samples.buffer]);
      } catch (e) {
        self.postMessage({ type: "failed", key: job.key, message: String((e && e.message) || e).slice(0, 200) });
      }
    }
  } finally {
    busy = false;
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "load") {
    preferGpu = m.gpu !== false;
    load();
  }
  else if (m.type === "gen") {
    queue.push({ ...m, seq: seq++ });
    pump();
  } else if (m.type === "bump") {
    const job = queue.find((j) => j.key === m.key);
    if (job) job.prio = Math.max(job.prio, m.prio);
  } else if (m.type === "drop") {
    // Forget queued pre-renders below a priority (e.g. the voice changed).
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].prio < m.below) queue.splice(i, 1);
  }
};
