"use client";
/**
 * The auctioneer's voice on the stage: Kokoro-82M (Apache 2.0) via kokoro-js,
 * running in a Web Worker in this browser (public/kokoro-worker.js).
 *
 * - The model loads once ("Warming up the auctioneer's voice") and the browser
 *   caches it, so later visits start fast.
 * - Before a lot opens, every clip it may need is pre-rendered: the lot's
 *   intro and bank templates, the fixed lines, bidder names and a ladder of
 *   amounts. During bidding a line is stitched from clips, not synthesised.
 * - If Kokoro can't load (old browser, no WebAssembly, network), or a clip
 *   isn't ready in time, the line is spoken by window.speechSynthesis instead.
 *   The caption shows the same words either way.
 */
import { linePieces } from "@/auctioneer/pieces";
import type { Vars } from "@/auctioneer/templates";
import { decodeAudio, playClips } from "./sound";
import { setVoiceMuted, speak as browserSpeak } from "./voice";

export type Tone = "warm" | "playful" | "urgent" | "grateful";
export type VoiceStatus = "idle" | "loading" | "ready" | "failed";
export interface VoiceState {
  status: VoiceStatus;
  pct: number;
  error: string | null;
  voice: string;
  /** "webgpu" or "wasm" once ready. */
  device: string | null;
}

/** Shortlist for /voices: the deeper and more characterful Kokoro English voices. */
export const KOKORO_VOICES: { id: string; label: string }[] = [
  { id: "bm_george", label: "George · British, male" },
  { id: "bm_fable", label: "Fable · British, male" },
  { id: "bm_lewis", label: "Lewis · British, male" },
  { id: "bm_daniel", label: "Daniel · British, male" },
  { id: "am_michael", label: "Michael · American, male" },
  { id: "am_fenrir", label: "Fenrir · American, male" },
  { id: "am_puck", label: "Puck · American, male" },
  { id: "am_onyx", label: "Onyx · American, male" },
  { id: "af_heart", label: "Heart · American, female" },
  { id: "af_bella", label: "Bella · American, female" },
  { id: "bf_emma", label: "Emma · British, female" },
  { id: "bf_isabella", label: "Isabella · British, female" },
];
export const DEFAULT_VOICE = "bm_george";
const VOICE_KEY = "going-once:kokoro-voice";
const SPEED = 1.05;
const LIVE_PRIO = 1_000;
const LOAD_TIMEOUT_MS = 4 * 60_000;
const LINE_DEADLINE_MS = 2_500;

function storedVoice() {
  try {
    const v = window.localStorage.getItem(VOICE_KEY);
    return v && KOKORO_VOICES.some((x) => x.id === v) ? v : DEFAULT_VOICE;
  } catch {
    return DEFAULT_VOICE;
  }
}

let state: VoiceState = { status: "idle", pct: 0, error: null, voice: DEFAULT_VOICE, device: null };
const listeners = new Set<(s: VoiceState) => void>();
let worker: Worker | null = null;
let sampleRate = 24_000;
const cache = new Map<string, Float32Array>();
const pending = new Map<string, ((v: Float32Array | null) => void)[]>();
let muted = false;
let playing: { stop: () => void } | null = null;
let lineSeq = 0;

function set(patch: Partial<VoiceState>) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

export function subscribeVoice(fn: (s: VoiceState) => void) {
  listeners.add(fn);
  fn(state);
  return () => void listeners.delete(fn);
}

const keyOf = (voice: string, text: string) => `${voice}|${text}`;

function settle(key: string, v: Float32Array | null) {
  for (const r of pending.get(key) ?? []) r(v);
  pending.delete(key);
}

function fail(message: string) {
  set({ status: "failed", error: message });
  for (const key of [...pending.keys()]) settle(key, null);
}

/** Kokoro pads each clip with silence; trim it so stitched lines flow. */
function trim(s: Float32Array, sr: number) {
  const th = 0.01;
  let a = 0;
  while (a < s.length && Math.abs(s[a]!) < th) a++;
  let b = s.length - 1;
  while (b > a && Math.abs(s[b]!) < th) b--;
  const pad = Math.round(sr * 0.025);
  return s.slice(Math.max(0, a - pad), Math.min(s.length, b + pad));
}

/** Start loading the model (idempotent). */
export function initKokoro() {
  if (typeof window === "undefined" || worker || state.status === "failed") return;
  state = { ...state, voice: storedVoice() };
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") return fail("This browser can't run Kokoro.");
  try {
    worker = new Worker("/kokoro-worker.js", { type: "module" });
  } catch {
    return fail("Couldn't start the voice worker.");
  }
  set({ status: "loading", pct: 0 });
  const timer = setTimeout(() => state.status === "loading" && fail("The voice took too long to load."), LOAD_TIMEOUT_MS);
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as
      | { type: "progress"; pct: number }
      | { type: "ready"; device: string }
      | { type: "note"; message: string }
      | { type: "error"; message: string }
      | { type: "audio"; key: string; samples: Float32Array; sr: number }
      | { type: "failed"; key: string };
    switch (m.type) {
      case "progress":
        if (state.status === "loading") set({ pct: m.pct });
        break;
      case "ready":
        clearTimeout(timer);
        set({ status: "ready", pct: 100, error: null, device: m.device });
        break;
      case "error":
        clearTimeout(timer);
        fail(m.message);
        break;
      case "audio": {
        sampleRate = m.sr;
        const clip = trim(m.samples, m.sr);
        cache.set(m.key, clip);
        settle(m.key, clip);
        break;
      }
      case "failed":
        settle(m.key, null);
        break;
      case "note":
        console.info(`[voice] ${m.message}`);
        break;
    }
  };
  worker.onerror = () => fail("The voice worker crashed.");
  // ?voice-gpu=0 forces WebAssembly (e.g. on a machine short of memory).
  const gpu = new URLSearchParams(window.location.search).get("voice-gpu") !== "0";
  worker.postMessage({ type: "load", gpu });
}

// ---------------------------------------------------------------------------
// Cloud voice (smallest.ai via our server). When the server has it, Kokoro is
// not loaded at all: the GPU stays free for the 3D room.
// ---------------------------------------------------------------------------
const CLOUD_KEY = "going-once:cloud-voice";
const CLOUD_DEADLINE_MS = 3_000;
let cloudRoom: string | null = null;
export interface CloudInfo {
  enabled: boolean;
  label: string | null;
  defaultVoice: string | null;
  voices: { id: string; label: string }[];
  previewLines: string[];
}

export async function cloudInfo(): Promise<CloudInfo | null> {
  try {
    const j = (await (await fetch("/api/tts/info")).json()) as CloudInfo & { ok: boolean };
    return j.ok ? j : null;
  } catch {
    return null;
  }
}

export function storedCloudVoice(info: CloudInfo) {
  try {
    const v = window.localStorage.getItem(CLOUD_KEY);
    if (v && info.voices.some((x) => x.id === v)) return v;
  } catch {
    /* ignore */
  }
  return info.defaultVoice ?? info.voices[0]?.id ?? "";
}

export function chooseCloudVoice(id: string) {
  try {
    window.localStorage.setItem(CLOUD_KEY, id);
  } catch {
    /* private mode: lasts this session */
  }
  if (cloudRoom !== null) set({ voice: id });
}

/** Fetch one line's audio from our server (never the provider directly). */
export async function cloudClip(room: string, text: string, voice: string, timeoutMs = CLOUD_DEADLINE_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch("/api/tts", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room, text, voice }),
    });
    if (!r.ok) return null;
    return await decodeAudio(await r.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * The stage's voice: the cloud voice if the server offers it, otherwise
 * Kokoro in this browser (and the browser's own voice as the last fallback).
 */
export async function initVoice(room: string) {
  if (typeof window === "undefined" || cloudRoom !== null || worker) return;
  const info = await cloudInfo();
  if (info?.enabled) {
    cloudRoom = room;
    set({ status: "ready", pct: 100, error: null, device: "cloud", voice: storedCloudVoice(info) });
    return;
  }
  initKokoro();
}

export function currentVoice() {
  return state.voice;
}

export function chooseVoice(id: string) {
  if (!KOKORO_VOICES.some((v) => v.id === id)) return;
  try {
    window.localStorage.setItem(VOICE_KEY, id);
  } catch {
    /* private mode: the choice lasts this session */
  }
  worker?.postMessage({ type: "drop", below: LIVE_PRIO });
  for (const key of [...pending.keys()]) if (!key.startsWith(`${id}|`)) settle(key, null);
  set({ voice: id });
}

/** Audio for one clip, from the cache or rendered at `prio`. Null if Kokoro is unavailable. */
export function clip(text: string, prio: number, voice = state.voice): Promise<Float32Array | null> {
  const key = keyOf(voice, text);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  if (!worker || state.status === "failed") return Promise.resolve(null);
  return new Promise((resolve) => {
    const waiters = pending.get(key);
    if (waiters) {
      waiters.push(resolve);
      worker!.postMessage({ type: "bump", key, prio });
    } else {
      pending.set(key, [resolve]);
      worker!.postMessage({ type: "gen", key, text, voice, speed: SPEED, prio });
    }
  });
}

/** Queue clips for pre-rendering; anything already cached or queued is skipped. */
export function prewarm(items: { text: string; prio: number }[]) {
  if (!worker || state.status === "failed") return;
  for (const { text, prio } of items) {
    const key = keyOf(state.voice, text);
    if (!text || cache.has(key) || pending.has(key)) continue;
    void clip(text, prio);
  }
}

export function cachedCount() {
  const prefix = `${state.voice}|`;
  let n = 0;
  for (const k of cache.keys()) if (k.startsWith(prefix)) n++;
  return n;
}

export function setSpeechMuted(m: boolean) {
  muted = m;
  setVoiceMuted(m);
  if (m) {
    playing?.stop();
    playing = null;
  }
}

export function stopSpeech() {
  lineSeq++;
  playing?.stop();
  playing = null;
  if (typeof window !== "undefined") window.speechSynthesis?.cancel();
}

/**
 * Say a line. The newest line always wins, so the voice keeps pace with rapid
 * bids. Falls back to the browser voice if Kokoro isn't ready or is too slow.
 */
export async function sayLine(line: { text: string; template?: string; vars?: Vars; tone?: Tone }) {
  stopSpeech();
  const id = lineSeq;
  if (muted || !line.text) return;
  if (cloudRoom !== null) {
    const clipAudio = await cloudClip(cloudRoom, line.text, state.voice);
    if (id !== lineSeq || muted) return; // a newer line took over
    if (!clipAudio) return browserSpeak(line.text, line.tone);
    playing = playClips([{ ...clipAudio, pauseMs: 0 }]);
    return;
  }
  if (state.status !== "ready") return browserSpeak(line.text, line.tone);
  const pieces = (line.template && linePieces(line.template, line.vars ?? {})) || [{ text: line.text, pauseMs: 0, value: false }];
  const deadline = new Promise<null>((r) => setTimeout(() => r(null), LINE_DEADLINE_MS));
  const clips = await Promise.race([Promise.all(pieces.map((p) => clip(p.text, LIVE_PRIO))), deadline]);
  if (id !== lineSeq || muted) return; // a newer line took over
  if (!clips || clips.some((c) => !c)) return browserSpeak(line.text, line.tone);
  playing = playClips(clips.map((samples, i) => ({ samples: samples!, sr: sampleRate, pauseMs: pieces[i]!.pauseMs })));
}
