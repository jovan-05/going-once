/**
 * The model behind the auctioneer. It only ever returns words (templates) and
 * an optional suggested ask; code validates and clamps everything it says.
 *
 * Provider: Groq (OpenAI-compatible chat completions, JSON mode), chosen for
 * low latency. Set AI_PROVIDER=groq, AI_API_KEY, and optionally AI_MODEL.
 * With no key, the auctioneer runs entirely from the deterministic bank.
 */
import { MAX_LINE } from "./templates";

export interface AiClient {
  /** Ask for one JSON object. Resolves to the parsed object, or null on any failure or timeout. */
  json(system: string, user: string, opts: { timeoutMs: number; maxTokens: number; temperature?: number }): Promise<unknown | null>;
  /** One chat turn with optional tools (OpenAI format). Resolves to the assistant message, or null. */
  chat?(messages: ChatMessage[], opts: { tools?: ToolDef[]; timeoutMs: number; maxTokens: number; temperature?: number }): Promise<ChatMessage | null>;
  readonly label: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

export class GroqClient implements AiClient {
  readonly label: string;
  private failures = 0;
  private pausedUntil = 0;
  /** One call at a time: bursts would hit the free tier's tokens-per-minute limit. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly apiKey: string,
    private readonly model = DEFAULT_GROQ_MODEL,
    private readonly log: (m: string) => void = (m) => console.warn(m),
  ) {
    this.label = `groq:${model}`;
  }

  json(system: string, user: string, opts: { timeoutMs: number; maxTokens: number; temperature?: number }): Promise<unknown | null> {
    return this.enqueue(opts.timeoutMs, (left) => this.call(system, user, { ...opts, timeoutMs: left }));
  }

  chat(messages: ChatMessage[], opts: { tools?: ToolDef[]; timeoutMs: number; maxTokens: number; temperature?: number }): Promise<ChatMessage | null> {
    return this.enqueue(opts.timeoutMs, (left) => this.callChat(messages, { ...opts, timeoutMs: left }));
  }

  /** One call at a time; a call that waited past its deadline is skipped. */
  private enqueue<R>(timeoutMs: number, fn: (left: number) => Promise<R | null>): Promise<R | null> {
    const queuedAt = Date.now();
    const run = this.queue.then(() => {
      const left = timeoutMs - (Date.now() - queuedAt);
      return left < 500 ? null : fn(left);
    });
    this.queue = run.catch(() => null);
    return run;
  }

  private reasoning() {
    // Reasoning models (gpt-oss, qwen3): think briefly, so replies come back fast.
    return /gpt-oss/.test(this.model) ? { reasoning_effort: "low" } : /qwen3/.test(this.model) ? { reasoning_effort: "none" } : {};
  }

  private async callChat(messages: ChatMessage[], opts: { tools?: ToolDef[]; timeoutMs: number; maxTokens: number; temperature?: number }): Promise<ChatMessage | null> {
    if (Date.now() < this.pausedUntil) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
          max_tokens: opts.maxTokens,
          temperature: opts.temperature ?? 0.2,
          ...this.reasoning(),
        }),
      });
      if (res.status === 429) {
        const wait = Math.min(60, Number(res.headers.get("retry-after")) || 10);
        this.pausedUntil = Date.now() + wait * 1000;
        this.log(`[ai] ${this.label}: rate limited for ${wait}s`);
        return null;
      }
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: { type?: string; code?: string } } | null;
        throw new Error(`HTTP ${res.status} ${err?.error?.type ?? ""} ${err?.error?.code ?? ""}`.trim());
      }
      const body = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
      const m = body.choices?.[0]?.message;
      if (!m) throw new Error("empty reply");
      return { role: "assistant", content: m.content ?? null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) };
    } catch (e) {
      this.log(`[ai] ${this.label}: ${ctrl.signal.aborted ? `timed out after ${opts.timeoutMs}ms` : e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async call(system: string, user: string, opts: { timeoutMs: number; maxTokens: number; temperature?: number }) {
    // After repeated failures, or when Groq asked us to wait, don't call (the bank covers us).
    if (Date.now() < this.pausedUntil) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          max_tokens: opts.maxTokens,
          temperature: opts.temperature ?? 0.8,
          ...this.reasoning(),
        }),
      });
      if (res.status === 429) {
        // Rate limited: wait as long as Groq asks (not counted as a failure).
        const wait = Math.min(60, Number(res.headers.get("retry-after")) || 10);
        this.pausedUntil = Date.now() + wait * 1000;
        this.log(`[auctioneer] ${this.label}: rate limited; using the line bank for ${wait}s`);
        return null;
      }
      if (!res.ok) {
        // Status and Groq's error type only; never the request (it carries the key header) or the body we sent.
        const err = (await res.json().catch(() => null)) as { error?: { type?: string; code?: string } } | null;
        throw new Error(`HTTP ${res.status} ${err?.error?.type ?? ""} ${err?.error?.code ?? ""}`.trim());
      }
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = body.choices?.[0]?.message?.content;
      if (!text || text.length > 40 * MAX_LINE) throw new Error("empty or oversized reply");
      this.failures = 0;
      return JSON.parse(text) as unknown;
    } catch (e) {
      const why = ctrl.signal.aborted ? `timed out after ${opts.timeoutMs}ms` : e instanceof Error ? e.message : String(e);
      if (++this.failures >= 3) {
        this.pausedUntil = Date.now() + 60_000;
        this.failures = 0;
        this.log(`[auctioneer] ${this.label} failed 3 times (${why}); using the line bank for 60s`);
      } else {
        this.log(`[auctioneer] ${this.label}: ${why}; using the line bank`);
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Env values without a trailing "# comment" (copied from .env.example). */
const env = (k: string) => (process.env[k] ?? "").replace(/\s+#.*$/, "").trim();

export function aiFromEnv(): AiClient | null {
  const key = env("AI_API_KEY");
  if (!key) {
    console.warn("[auctioneer] AI_API_KEY not set — the auctioneer uses its built-in line bank.");
    return null;
  }
  const provider = env("AI_PROVIDER").toLowerCase() || "groq";
  // Groq keys start with gsk_; accept them even if AI_PROVIDER still says something else.
  if (provider !== "groq" && !key.startsWith("gsk_")) {
    console.warn(`[auctioneer] AI_PROVIDER=${provider} is not supported (use groq) — using the built-in line bank.`);
    return null;
  }
  const ai = new GroqClient(key, env("AI_MODEL") || DEFAULT_GROQ_MODEL);
  console.log(`[auctioneer] AI lines from ${ai.label}`);
  return ai;
}
