"use client";
/**
 * All sounds are synthesised with the Web Audio API — no samples, so there is
 * nothing to license (see public/sounds/CREDITS.md).
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let murmur: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
let muted = false;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
  }
  return ctx;
}

/** Must be called from a user gesture once (browser autoplay rules). */
export async function unlockAudio(): Promise<boolean> {
  const c = audio();
  if (!c) return false;
  if (c.state === "suspended") await c.resume().catch(() => undefined);
  return c.state === "running";
}

export function audioRunning() {
  return ctx?.state === "running";
}

export function setMuted(m: boolean) {
  muted = m;
  if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.02);
}

function noiseBuffer(c: AudioContext, seconds: number, brown = false) {
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * seconds), c.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    } else data[i] = white;
  }
  return buf;
}

/** Hardwood gavel on a sound block: a sharp knock plus a short low body. */
export function playGavel() {
  const c = audio();
  if (!c || !master || c.state !== "running") return;
  const t = c.currentTime;

  const knock = c.createBufferSource();
  knock.buffer = noiseBuffer(c, 0.12);
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1400;
  bp.Q.value = 3;
  const kg = c.createGain();
  kg.gain.setValueAtTime(0.9, t);
  kg.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
  knock.connect(bp).connect(kg).connect(master);
  knock.start(t);

  const body = c.createOscillator();
  body.type = "sine";
  body.frequency.setValueAtTime(190, t);
  body.frequency.exponentialRampToValueAtTime(70, t + 0.25);
  const bg = c.createGain();
  bg.gain.setValueAtTime(0.8, t);
  bg.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  body.connect(bg).connect(master);
  body.start(t);
  body.stop(t + 0.4);
}

/** Soft tick when a bid lands. */
export function playTick() {
  const c = audio();
  if (!c || !master || c.state !== "running") return;
  const t = c.currentTime;
  const o = c.createOscillator();
  o.type = "triangle";
  o.frequency.value = 1760;
  const g = c.createGain();
  g.gain.setValueAtTime(0.12, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + 0.08);
}

/** Low room murmur while bidding is live. */
export function setMurmur(on: boolean) {
  const c = audio();
  if (!c || !master) return;
  if (on && !murmur && c.state === "running") {
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 4, true);
    src.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 380;
    const gain = c.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(0.05, c.currentTime, 0.8);
    src.connect(lp).connect(gain).connect(master);
    src.start();
    murmur = { src, gain };
  } else if (!on && murmur) {
    const m = murmur;
    murmur = null;
    m.gain.gain.setTargetAtTime(0, c.currentTime, 0.4);
    setTimeout(() => m.src.stop(), 2_000);
  }
}

/**
 * Play a run of pre-rendered voice clips back to back (Kokoro). Goes through
 * the master gain, so the stage's mute applies. Returns a stop function and
 * resolves `done` when the last clip ends.
 */
export function playClips(clips: { samples: Float32Array; sr: number; pauseMs: number }[]): { stop: () => void; done: Promise<void> } {
  const c = audio();
  if (!c || !master || !clips.length) return { stop: () => {}, done: Promise.resolve() };
  const sources: AudioBufferSourceNode[] = [];
  let t = c.currentTime + 0.03;
  for (const clip of clips) {
    const buf = c.createBuffer(1, clip.samples.length, clip.sr);
    buf.copyToChannel(clip.samples as Float32Array<ArrayBuffer>, 0);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(master);
    src.start(t);
    sources.push(src);
    t += buf.duration + clip.pauseMs / 1000;
  }
  const last = sources.at(-1)!;
  const done = new Promise<void>((resolve) => {
    last.onended = () => resolve();
  });
  return {
    stop: () => {
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          /* not started yet or already stopped */
        }
      }
    },
    done,
  };
}

/** Decode a WAV/MP3 reply (the cloud voice) into mono samples for playClips. */
export async function decodeAudio(data: ArrayBuffer): Promise<{ samples: Float32Array; sr: number } | null> {
  const c = audio();
  if (!c) return null;
  try {
    const buf = await c.decodeAudioData(data);
    return { samples: buf.getChannelData(0), sr: buf.sampleRate };
  } catch {
    return null;
  }
}
