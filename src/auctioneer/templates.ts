/**
 * Line templates and the per-lot "bank" (AUCTIONEER.md "Never wait for the model").
 *
 * Every line the auctioneer speaks is a template filled by code. Amounts and
 * bidder names only ever enter through placeholders, so the model cannot
 * invent a price, reveal a hold, or echo text smuggled in through a name:
 * a template with any digit, "$", or an unknown placeholder is rejected.
 *
 *   {amount}  current high bid       {next}   the asking price (clamped by code)
 *   {leader}  high bidder's public name ("Asha" or "paddle 3")
 *   {target}  a bidder being encouraged (never the leader)
 *   {start}   the lot's opening price {lot}   the lot title
 *   {number}  the lot number (fixed system lines only)
 */
import { z } from "zod";

export const MAX_LINE = 140;

export const SLOTS = {
  intro: ["start", "lot"],
  bid: ["amount", "leader", "next"],
  lullHigh: ["amount", "leader", "next"],
  lullOpen: ["start", "lot"],
  goingOnce: ["amount"],
  late: [],
  passed: [],
} as const satisfies Record<string, readonly string[]>;

export type Slot = keyof typeof SLOTS;
export type Placeholder = "amount" | "next" | "leader" | "target" | "start" | "lot" | "number";
export type Vars = Partial<Record<Placeholder, string>>;

/** Allowed placeholders for a free-standing "fresh" line. */
export const FRESH_PLACEHOLDERS: readonly Placeholder[] = ["amount", "next", "leader", "target"];

/** null if the template is acceptable, else the reason it was rejected. */
export function templateProblem(t: unknown, allowed: readonly string[]): string | null {
  if (typeof t !== "string") return "not a string";
  const s = t.trim();
  if (!s) return "empty";
  if (s.length > MAX_LINE - 20) return "too long";
  if (/[\d$€£¥]/.test(s)) return "contains a number or currency"; // amounts come only from placeholders
  if (/[<>\n\r`\\]/.test(s)) return "markup or control characters";
  if (/\bsold\b/i.test(s)) return 'says "sold"'; // that word waits for PayPal (rule 4)
  for (const m of s.matchAll(/\{([^}]*)\}/g)) if (!allowed.includes(m[1]!)) return `unknown placeholder {${m[1]}}`;
  if (/[{}]/.test(s.replace(/\{[a-z]+\}/g, ""))) return "stray brace";
  return null;
}

/** Fill a template. Returns null if a placeholder has no value or the result is too long. */
export function fill(t: string, vars: Vars): string | null {
  let missing = false;
  const out = t.trim().replace(/\{([a-z]+)\}/g, (_, k: Placeholder) => {
    const v = vars[k];
    if (v === undefined) missing = true;
    return v ?? "";
  });
  if (missing || out.length > MAX_LINE) return null;
  // Capitalise a sentence that starts with a placeholder ("paddle 3 has it" → "Paddle 3 has it").
  return out.charAt(0).toUpperCase() + out.slice(1);
}

export type Bank = { [K in Slot]: string[] };

const lines = z.array(z.string());
/** What the model must return for a lot bank. Lines are checked one by one afterwards. */
export const BankSchema = z.object({
  intro: lines,
  bid: lines,
  lullHigh: lines,
  lullOpen: lines,
  goingOnce: lines,
  late: lines,
  passed: lines,
});

const MIN_PER_SLOT: Record<Slot, number> = { intro: 1, bid: 3, lullHigh: 2, lullOpen: 1, goingOnce: 1, late: 1, passed: 1 };

/**
 * Keep only the valid lines from a model bank; any slot left too thin is
 * topped up from the default bank, so the result is always usable.
 */
export function sanitizeBank(raw: unknown, fallback: Bank): { bank: Bank; rejected: number } {
  const parsed = BankSchema.safeParse(raw);
  let rejected = 0;
  const bank = {} as Bank;
  for (const slot of Object.keys(SLOTS) as Slot[]) {
    const got = parsed.success ? parsed.data[slot] : [];
    const ok = [...new Set(got.map((l) => l.trim()))].filter((l) => {
      // The calls are the engine's: a line may not claim a later call (or the hammer) than its moment.
      const wrongCall = (slot === "goingOnce" && /\b(twice|third|hammer|gone)\b/i.test(l)) || (slot !== "goingOnce" && /\bgoing (once|twice)\b/i.test(l));
      const bad = templateProblem(l, SLOTS[slot]) ?? (wrongCall ? "wrong call for this moment" : null);
      if (bad) rejected++;
      return !bad;
    });
    bank[slot] = (ok.length >= MIN_PER_SLOT[slot] ? ok : [...ok, ...fallback[slot]]).slice(0, 8);
  }
  if (!parsed.success) rejected++;
  return { bank, rejected };
}

/** The deterministic bank: used when there is no AI key, before the AI bank arrives, or if it is unusable. */
export const DEFAULT_BANK: Bank = {
  intro: ["{lot}. Who'll start me at {start}?", "Here's {lot}. We open at {start}. Paddles up."],
  bid: [
    "{amount} to {leader}. Do I hear {next}?",
    "{leader} has it at {amount}. {next}, anyone?",
    "{amount}, thank you {leader}. Looking for {next}.",
    "{amount} with {leader}. Who'll make it {next}?",
  ],
  lullHigh: [
    "Still {amount} with {leader}. Will anyone go {next}?",
    "It's a good cause, and it's {next} to stay in.",
  ],
  lullOpen: ["Who'll start me at {start}? Every bid helps.", "Opening at {start}. Paddles up."],
  goingOnce: ["Going once at {amount}…"],
  late: ["A late bid, so we keep going."],
  passed: ["No takers this time. We'll come back to it."],
};

/** Fresh, single-moment line from the model (AUCTIONEER.md output schema). */
export const FreshLineSchema = z.object({
  line: z.string(),
  addressPaddle: z.number().int().optional().nullable(),
  suggestedAsk: z.number().optional().nullable(),
  tone: z.enum(["warm", "playful", "urgent", "grateful"]),
});
export type FreshLine = z.infer<typeof FreshLineSchema>;

/** Fixed wording, written by us. Still templates, so the stage can pre-render their audio. */
export const SYSTEM = {
  goingOnceOpen: "Going once at the opening price…",
  goingTwice: "Going twice…",
  /** Not "Sold": that word waits for PayPal to confirm the capture (rule 4). */
  hammer: "Hammer down: {amount} to {leader}.",
  paused: "A short pause. Stay with us.",
  resumed: "And we're back.",
  advanced: "Next up, lot {number}: {lot}.",
  /** Said by the stage only once the capture is COMPLETED. */
  sold: "Sold, to {leader}, for {amount}. Thank you.",
  /** Simulated holds (demo bots / test bidders): no money moved, so never "Sold". */
  won: "Won by {leader} for {amount}. Thank you.",
  /** End of the night (M9), when the AI line isn't available. */
  thanks: "That's the night. Thank you, everyone. Together you raised {amount}.",
} as const;
