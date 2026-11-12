/**
 * Cloud voice for the auctioneer: smallest.ai Lightning (REST, sync WAV).
 *
 * - The API key stays on the server. The stage asks /api/tts for a line's
 *   audio; the server synthesises it once and caches the WAV.
 * - Not an open text-to-speech service: the server only voices lines it wrote itself
 *   (recent auctioneer lines for that room, the "Sold"/"Won" line of a lot
 *   that really sold, or the fixed /voices samples). See `TtsService.allowed`.
 * - When an auctioneer line is emitted, its audio is requested straight
 *   away, so it is usually ready by the time the stage asks.
 * - Free-tier friendly: lines are pre-rendered only for rooms whose stage
 *   asked for audio in the last 10 minutes, nothing is rendered twice, and a
 *   character budget per server run (SMALLEST_MAX_CHARS, default 100k, about
 *   $2 of the $10 free credit) stops calls; the browser voice takes over.
 * - Any failure returns null; the stage then falls back to Kokoro or the browser voice.
 *   After 3 failures in a row, it stops calling for a minute.
 */
import { createHash } from "node:crypto";

export const SMALLEST_URL = "https://api.smallest.ai/waves/v1/tts";
export const DEFAULT_TTS_MODEL = "lightning_v3.1_pro";
export const DEFAULT_TTS_VOICE = "henry";
const MAX_TEXT = 250; // smallest.ai: "max ~250 chars recommended"
const CACHE_MAX = 400;

/** Voices offered on /voices (English, from the Lightning v3.1 Pro model card). */
export const CLOUD_VOICES: { id: string; label: string }[] = [
  { id: "henry", label: "Henry · British, male" },
  { id: "benedict", label: "Benedict · British, male" },
  { id: "rupert", label: "Rupert · British, male" },
  { id: "cormac", label: "Cormac · British, male" },
  { id: "blake", label: "Blake · American, male" },
  { id: "austin", label: "Austin · American, male" },
  { id: "owen", label: "Owen · American, male" },
  { id: "jack", label: "Jack · American, male" },
  { id: "cressida", label: "Cressida · British, female" },
  { id: "sophie", label: "Sophie · British, female" },
  { id: "savannah", label: "Savannah · American, female" },
  { id: "kaitlyn", label: "Kaitlyn · American, female" },
];

/** The only free text /voices may preview (no arbitrary text: see `allowed`). */
export const PREVIEW_LINES = [
  "Lot three: a cooking class for six. Who'll start me at one hundred and twenty dollars?",
  "Two hundred to Asha by the window. Do I hear two twenty? Going once… going twice…",
  "Sold, to Asha, for two hundred dollars. Thank you!",
];

export interface TtsEngine {
  readonly label: string;
  synth(text: string, voice: string): Promise<Buffer | null>;
}

export class SmallestTts implements TtsEngine {
  readonly label: string;
  private failures = 0;
  private pausedUntil = 0;

  constructor(
    private readonly apiKey: string,
    private readonly model = DEFAULT_TTS_MODEL,
    private readonly speed = 1.05,
    private readonly log: (m: string) => void = (m) => console.warn(m),
  ) {
    this.label = `smallest:${model}`;
  }

  async synth(text: string, voice: string): Promise<Buffer | null> {
    if (Date.now() < this.pausedUntil) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const res = await fetch(SMALLEST_URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: "audio/wav" },
        body: JSON.stringify({ text, voice_id: voice, model: this.model, sample_rate: 24_000, speed: this.speed, language: "en", output_format: "wav" }),
      });
      if (!res.ok) {
        // Status only: never the request (it carries the key) or the body.
        throw new Error(`HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100 || buf.subarray(0, 4).toString("ascii") !== "RIFF") throw new Error("not a WAV reply");
      this.failures = 0;
      return buf;
    } catch (e) {
      const why = ctrl.signal.aborted ? "timed out" : e instanceof Error ? e.message : String(e);
      if (++this.failures >= 3) {
        this.failures = 0;
        this.pausedUntil = Date.now() + 60_000;
        this.log(`[tts] ${this.label} failed 3 times (${why}); browser voices for 60s`);
      } else this.log(`[tts] ${this.label}: ${why}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

const env = (k: string) => (process.env[k] ?? "").replace(/\s+#.*$/, "").trim();

export function ttsFromEnv(): { engine: TtsEngine; voice: string; maxChars: number } | null {
  const key = env("SMALLEST_API_KEY");
  if (!key) return null;
  const engine = new SmallestTts(key, env("SMALLEST_MODEL") || DEFAULT_TTS_MODEL);
  const voice = env("SMALLEST_VOICE") || DEFAULT_TTS_VOICE;
  const maxChars = Number(env("SMALLEST_MAX_CHARS")) || 100_000;
  console.log(`[tts] auctioneer voice from ${engine.label} (${voice}), up to ${maxChars} characters this run`);
  return { engine, voice, maxChars };
}

export const voiceOk = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9_]{1,30}$/.test(v);

/** Cache + allow-list in front of the engine. */
export class TtsService {
  private cache = new Map<string, Buffer>();
  private inflight = new Map<string, Promise<Buffer | null>>();
  private allowedText = new Map<string, Set<string>>(); // roomId -> texts the server said
  private roomVoice = new Map<string, string>();
  private watched = new Map<string, number>(); // roomId -> last time its stage asked for audio
  private charsUsed = 0;
  private warnedBudget = false;

  constructor(
    private readonly engine: TtsEngine,
    readonly defaultVoice: string,
    /** Extra lines a room may voice (e.g. the Sold/Won line of a lot that sold). */
    private readonly extraAllowed: (roomId: string) => string[] = () => [],
    /** Character budget for this server run (free-tier guard). */
    private readonly maxChars = 100_000,
  ) {}

  /** Characters sent to the provider so far this run. */
  get used() {
    return this.charsUsed;
  }

  get label() {
    return this.engine.label;
  }

  /** The stage's chosen voice for this room (last one it asked for); pre-renders use it. */
  voiceFor(roomId: string) {
    return this.roomVoice.get(roomId) ?? this.defaultVoice;
  }

  /** Remember a line the server said, and start rendering it now. */
  said(roomId: string, text: string) {
    if (!text || text.length > MAX_TEXT) return;
    let set = this.allowedText.get(roomId);
    if (!set) this.allowedText.set(roomId, (set = new Set()));
    set.add(text);
    if (set.size > 80) set.delete(set.values().next().value!);
    // Pre-render only while a stage is listening (saves credits when nobody is watching).
    if (Date.now() - (this.watched.get(roomId) ?? -Infinity) < 10 * 60_000) void this.get(text, this.voiceFor(roomId));
  }

  /** Pre-render a line that may be needed soon (and allow it). */
  warm(roomId: string, text: string) {
    this.said(roomId, text);
  }

  allowed(roomId: string, text: string) {
    if (roomId === "_preview") return PREVIEW_LINES.includes(text);
    return !!this.allowedText.get(roomId)?.has(text) || this.extraAllowed(roomId).includes(text);
  }

  /** WAV for an allowed line, or null (not allowed, too long, or the provider failed). */
  async audio(roomId: string, text: string, voice?: string): Promise<Buffer | null> {
    if (!text || text.length > MAX_TEXT || !this.allowed(roomId, text)) return null;
    const v = voiceOk(voice) ? voice : this.voiceFor(roomId);
    if (roomId !== "_preview") {
      this.roomVoice.set(roomId, v);
      this.watched.set(roomId, Date.now());
    }
    return this.get(text, v);
  }

  private get(text: string, voice: string): Promise<Buffer | null> {
    const key = createHash("sha256").update(`${voice}\n${text}`).digest("hex");
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const running = this.inflight.get(key);
    if (running) return running;
    if (this.charsUsed + text.length > this.maxChars) {
      if (!this.warnedBudget) console.warn(`[tts] character budget (${this.maxChars}) reached; using the browser voice. Raise SMALLEST_MAX_CHARS to continue.`);
      this.warnedBudget = true;
      return Promise.resolve(null);
    }
    this.charsUsed += text.length;
    const p = this.engine
      .synth(text, voice)
      .then((buf) => {
        if (buf) {
          this.cache.set(key, buf);
          if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
        }
        return buf;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
