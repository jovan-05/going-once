/**
 * Minimal PayPal REST client. Sandbox only (CLAUDE.md rule 1).
 *
 * - Refuses to construct unless the API host is exactly the sandbox host.
 * - Every write takes a caller-supplied PayPal-Request-Id (rule 3). The caller
 *   must persist that id BEFORE calling, so retries and re-runs reuse it.
 * - Transient failures (network error, 429, 5xx) are retried with the SAME id.
 * - Never logs access tokens or raw payloads (rule 9).
 */

export const SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";

export interface PayPalConfig {
  apiBase: string;
  clientId: string;
  clientSecret: string;
}

export interface Money {
  currency_code: string;
  value: string;
}

export interface Link {
  href: string;
  rel: string;
  method?: string;
}

/** A PayPal error with exactly what PayPal returned (for docs/PAYPAL.md). */
export class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly paypalName: string | undefined,
    readonly paypalMessage: string | undefined,
    readonly details: unknown,
    readonly debugId: string | undefined,
  ) {
    super(
      `PayPal ${method} ${path} -> HTTP ${status} ${paypalName ?? ""}: ${paypalMessage ?? ""} (debug_id=${debugId ?? "n/a"})`,
    );
    this.name = "PayPalError";
  }

  /** Issue codes from `details[].issue`, e.g. INSTRUMENT_DECLINED. */
  get issues(): string[] {
    if (!Array.isArray(this.details)) return [];
    return this.details
      .map((d) => (d && typeof d === "object" ? (d as { issue?: unknown }).issue : undefined))
      .filter((x): x is string => typeof x === "string");
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): PayPalConfig {
  const apiBase = (env.PAYPAL_API_BASE ?? "").replace(/\/+$/, "");
  const clientId = env.PAYPAL_CLIENT_ID ?? "";
  const clientSecret = env.PAYPAL_CLIENT_SECRET ?? "";
  const missing = [
    !apiBase && "PAYPAL_API_BASE",
    !clientId && "PAYPAL_CLIENT_ID",
    !clientSecret && "PAYPAL_CLIENT_SECRET",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(", ")} — copy .env.example to .env and fill in sandbox credentials.`);
  }
  return { apiBase, clientId, clientSecret };
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PayPalClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: PayPalConfig) {
    if (cfg.apiBase !== SANDBOX_API_BASE) {
      throw new Error(
        `Refusing to start: PAYPAL_API_BASE must be ${SANDBOX_API_BASE} (got "${cfg.apiBase}"). Sandbox only.`,
      );
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await fetch(`${this.cfg.apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== "string") {
      throw new PayPalError(
        res.status,
        "POST",
        "/v1/oauth2/token",
        (body.error as string) ?? (body.name as string),
        (body.error_description as string) ?? (body.message as string),
        body.details,
        res.headers.get("paypal-debug-id") ?? (body.debug_id as string | undefined),
      );
    }
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 300;
    this.token = { value: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return this.token.value;
  }

  /**
   * Send a request. Writes (POST/PATCH) MUST pass `requestId`; it is sent as
   * PayPal-Request-Id and reused on every retry.
   */
  async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    opts: { body?: unknown; requestId?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; data: T; debugId: string | undefined }> {
    if (method !== "GET" && !opts.requestId) {
      throw new Error(`PayPal write ${method} ${path} without a PayPal-Request-Id (rule 3).`);
    }
    const maxAttempts = 4;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${await this.accessToken()}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          ...opts.headers,
        };
        if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
        const res = await fetch(`${this.cfg.apiBase}${path}`, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        const data = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
        const debugId = res.headers.get("paypal-debug-id") ?? (data.debug_id as string | undefined);
        if (res.ok) return { status: res.status, data: data as T, debugId };
        const err = new PayPalError(
          res.status,
          method,
          path,
          data.name as string | undefined,
          data.message as string | undefined,
          data.details,
          debugId,
        );
        if (res.status === 401) this.token = null;
        if (!(RETRYABLE(res.status) || res.status === 401) || attempt === maxAttempts) throw err;
        lastErr = err;
      } catch (e) {
        if (e instanceof PayPalError && (e.path === "/v1/oauth2/token" ? !RETRYABLE(e.status) : !(RETRYABLE(e.status) || e.status === 401))) throw e;
        lastErr = e;
        if (attempt === maxAttempts) break;
      }
      await sleep(500 * 2 ** (attempt - 1));
    }
    throw lastErr;
  }
}

export function findLink(links: Link[] | undefined, ...rels: string[]): string | undefined {
  for (const rel of rels) {
    const hit = links?.find((l) => l.rel === rel);
    if (hit) return hit.href;
  }
  return undefined;
}
