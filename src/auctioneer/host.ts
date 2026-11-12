/**
 * M7 — the auctioneer (AUCTIONEER.md).
 *
 * Listens to engine events and says something about each one. It never waits
 * for the model:
 *   - Before a lot opens, one AI call writes a bank of line templates for it.
 *     Until (or unless) that arrives, the deterministic DEFAULT_BANK is used.
 *   - Each event picks a line from the bank and code fills in the amounts and
 *     names. Speech starts immediately.
 *   - After each bid, a non-blocking AI call drafts a fresher line for the
 *     next lull. If it is back in time and the room hasn't moved on, it is
 *     used; otherwise it is dropped.
 * The AI has no way to accept a bid, change a price, or touch money (rule 2):
 * it returns text, which is validated, and an asking price, which is clamped.
 */
import { clampAsk, formatUsd, minNextBid, publicName, remainingHold, type AuctionState, type Bidder, type EngineEvent, type Lot } from "../engine";
import type { RoomManager } from "../server/rooms";
import type { AiClient } from "./ai";
import { BANK_SYSTEM, FRESH_SYSTEM, THANKS_SYSTEM, bankPrompt, freshPrompt, thanksPrompt } from "./prompt";
import {
  DEFAULT_BANK,
  FRESH_PLACEHOLDERS,
  SLOTS,
  SYSTEM,
  FreshLineSchema,
  fill,
  sanitizeBank,
  templateProblem,
  type Bank,
  type Slot,
  type Vars,
} from "./templates";

export type Tone = "warm" | "playful" | "urgent" | "grateful";

export interface HostLine {
  id: number;
  lotId: string | null;
  event: string;
  text: string;
  /** The template and values the text was filled from, so the stage can stitch pre-rendered audio. */
  template: string;
  vars: Vars;
  tone: Tone;
  /** "ai" = model-written template, "bank" = built-in template, "system" = fixed wording. */
  source: "ai" | "bank" | "system";
  at: number;
}

interface Fresh {
  lotId: string;
  bidCount: number;
  template: string;
  targetPaddle: number | null;
  askCents: number | null;
  tone: Tone;
}

interface RoomHost {
  banks: Map<string, { bank: Bank; fromAi: boolean }>;
  bankLoading: Set<string>;
  turn: Map<Slot, number>;
  recent: string[];
  /** lotId → paddle → times encouraged without bidding (never more than twice). */
  nudges: Map<string, Map<number, number>>;
  fresh: Fresh | null;
  freshSeq: number;
  last: HostLine | null;
}

export interface AuctioneerDeps {
  rooms: RoomManager;
  ai: AiClient | null;
  emit: (roomId: string, line: HostLine) => void;
  /** A lot's bank changed (AI bank arrived): screens should refresh their voice plan. */
  onPlanChange?: (roomId: string) => void;
  log?: (m: string) => void;
  bankTimeoutMs?: number;
  freshTimeoutMs?: number;
}

const MAX_NUDGES = 2;

type Said = Omit<HostLine, "id" | "lotId" | "at">;

/** A fixed line (SYSTEM wording) filled with values. */
function system(event: string, template: string, vars: Vars, tone: Tone): Said | null {
  const text = fill(template, vars);
  return text ? { text, template, vars, source: "system", tone, event } : null;
}
const usd = formatUsd;

/** "Asha" or "paddle 3" — never "Paddle 3" mid-sentence. */
const spoken = (b: Pick<Bidder, "paddle" | "name" | "showName">) => {
  const n = publicName(b);
  return n === `Paddle ${b.paddle}` ? `paddle ${b.paddle}` : n;
};

export class AuctioneerService {
  private hosts = new Map<string, RoomHost>();
  private seq = 0;

  constructor(private readonly d: AuctioneerDeps) {}

  get aiLabel() {
    return this.d.ai?.label ?? null;
  }

  private log(m: string) {
    (this.d.log ?? console.log)(`[auctioneer] ${m}`);
  }

  private host(roomId: string): RoomHost {
    let h = this.hosts.get(roomId);
    if (!h) {
      h = { banks: new Map(), bankLoading: new Set(), turn: new Map(), recent: [], nudges: new Map(), fresh: null, freshSeq: 0, last: null };
      this.hosts.set(roomId, h);
    }
    return h;
  }

  /**
   * The night is over: one closing line. The AI may write its words (validated:
   * only {amount}, which code fills with the real total); otherwise a fixed line.
   */
  async thankYou(roomId: string) {
    const state = this.d.rooms.get(roomId)?.state;
    if (!state) return;
    const sold = state.lots.filter((l) => l.status === "sold");
    const vars: Vars = { amount: formatUsd(sold.reduce((s, l) => s + (l.hammerCents ?? 0), 0)) };
    let template: string = SYSTEM.thanks;
    let source: HostLine["source"] = "system";
    if (this.d.ai) {
      const raw = (await this.d.ai
        .json(THANKS_SYSTEM, thanksPrompt({ eventName: state.name, lotsSold: sold.length, lotTitles: sold.map((l) => l.title) }), { timeoutMs: 4_000, maxTokens: 120, temperature: 0.8 })
        .catch(() => null)) as { line?: unknown } | null;
      const t = typeof raw?.line === "string" ? raw.line.trim() : "";
      const problem = t ? templateProblem(t, ["amount"]) : "empty";
      if (!problem && (t.match(/\{amount\}/g) ?? []).length === 1) {
        template = t;
        source = "ai";
      } else if (t) this.log(`thank-you line rejected (${problem ?? "needs {amount} once"})`);
    }
    const text = fill(template, vars) ?? fill(SYSTEM.thanks, vars)!;
    const line: HostLine = { id: ++this.seq, lotId: null, event: "night_closed", text, template, vars, tone: "grateful", source, at: Date.now() };
    const h = this.host(roomId);
    h.last = line;
    this.d.emit(roomId, line);
  }

  lastLine(roomId: string) {
    return this.hosts.get(roomId)?.last ?? null;
  }

  bankFor(roomId: string, lotId: string) {
    return this.host(roomId).banks.get(lotId) ?? { bank: DEFAULT_BANK, fromAi: false };
  }

  /** Warm banks for the current and next lot. Safe to call any time; never blocks. */
  prepare(roomId: string) {
    const state = this.d.rooms.get(roomId)?.state;
    if (!state) return;
    for (const lot of state.lots.slice(state.currentLotIndex, state.currentLotIndex + 2)) void this.loadBank(roomId, state, lot);
  }

  private async loadBank(roomId: string, state: AuctionState, lot: Lot) {
    const h = this.host(roomId);
    const ai = this.d.ai;
    if (!ai || h.banks.has(lot.id) || h.bankLoading.has(lot.id) || lot.status === "sold" || lot.status === "passed") return;
    h.bankLoading.add(lot.id);
    try {
      const raw = await ai.json(
        BANK_SYSTEM,
        bankPrompt({ eventName: state.name, lotTitle: lot.title, lotStory: lot.story, lotNumber: lot.number, lotCount: state.lots.length }),
        { timeoutMs: this.d.bankTimeoutMs ?? 12_000, maxTokens: 1_200 },
      );
      if (raw === null) return;
      const { bank, rejected } = sanitizeBank(raw, DEFAULT_BANK);
      h.banks.set(lot.id, { bank, fromAi: true });
      this.d.onPlanChange?.(roomId);
      this.log(`bank ready for ${roomId}:${lot.id}${rejected ? ` (${rejected} line(s) rejected by validation)` : ""}`);
    } finally {
      h.bankLoading.delete(lot.id);
    }
  }

  /** Pick the next template for a slot, rotating so the same line isn't said twice in a row. */
  private pick(h: RoomHost, lotId: string, slot: Slot) {
    const { bank, fromAi } = h.banks.get(lotId) ?? { bank: DEFAULT_BANK, fromAi: false };
    const options = bank[slot].length ? bank[slot] : DEFAULT_BANK[slot];
    const n = h.turn.get(slot) ?? 0;
    h.turn.set(slot, n + 1);
    return { template: options[n % options.length]!, source: (fromAi && bank[slot].length ? "ai" : "bank") as HostLine["source"] };
  }

  private say(roomId: string, lotId: string | null, event: string, slot: Slot, vars: Vars, tone: Tone): Said | null {
    const h = this.host(roomId);
    if (!lotId) return null;
    const picked = this.pick(h, lotId, slot);
    const text = fill(picked.template, vars);
    if (text) return { text, template: picked.template, vars, source: picked.source, tone, event };
    const fallback = DEFAULT_BANK[slot][0]!;
    const t2 = fill(fallback, vars);
    return t2 ? { text: t2, template: fallback, vars, source: "bank", tone, event } : null;
  }

  /**
   * Every template the stage might need for the current and next lot, so it
   * can pre-render the audio before the lot opens. Text only; no money data.
   */
  voicePlan(roomId: string) {
    const state = this.d.rooms.get(roomId)?.state;
    if (!state) return null;
    const fixed = Object.values(SYSTEM) as string[];
    return {
      lots: state.lots.slice(state.currentLotIndex, state.currentLotIndex + 2).map((lot) => {
        const { bank } = this.bankFor(roomId, lot.id);
        const templates = (Object.keys(SLOTS) as Slot[]).flatMap((slot) => bank[slot]);
        return { lotId: lot.id, startCents: lot.startCents, incrementCents: lot.incrementCents, templates: [...new Set([...templates, ...fixed, `${bank.late[0] ?? ""} ${bank.bid[0] ?? ""}`.trim()])] };
      }),
    };
  }

  /** Called with every batch of engine events (after the state has changed). */
  handleEvents(roomId: string, events: EngineEvent[]) {
    const engine = this.d.rooms.get(roomId);
    if (!engine || !events.length) return;
    const state = engine.state;
    const h = this.host(roomId);
    const lot = state.lots[state.currentLotIndex];
    const top = lot?.bids.at(-1);
    const leaderB = top ? state.bidders[top.bidderId] : undefined;
    const base: Vars = lot
      ? {
          lot: lot.title,
          start: usd(lot.startCents),
          amount: top ? usd(top.amountCents) : usd(lot.startCents),
          next: usd(minNextBid(lot)),
          leader: leaderB ? spoken(leaderB) : undefined,
        }
      : {};
    const late = events.some((e) => e.type === "soft_close_extended");
    let out: Said | null = null;

    for (const ev of events) {
      const d = ev.data;
      switch (ev.type) {
        case "lot_opened":
          out = this.say(roomId, lot?.id ?? null, ev.type, "intro", base, "warm");
          this.prepare(roomId);
          this.requestFresh(roomId);
          break;
        case "bid_accepted": {
          const bidder = state.bidders[String(d.bidderId)];
          if (lot && bidder) h.nudges.get(lot.id)?.delete(bidder.paddle); // they're back in: nudges reset
          const line = this.say(roomId, lot?.id ?? null, ev.type, "bid", base, "playful");
          if (line && late && lot) {
            const template = `${this.pick(h, lot.id, "late").template} ${line.template}`;
            const both = fill(template, base);
            out = both && both.length <= 160 ? { ...line, text: both, template, tone: "urgent" } : line;
          } else out = line;
          this.requestFresh(roomId);
          break;
        }
        case "lull":
          out = this.lullLine(roomId, state, lot, base);
          break;
        case "going_once":
          out = top ? this.say(roomId, lot?.id ?? null, ev.type, "goingOnce", base, "urgent") : system(ev.type, SYSTEM.goingOnceOpen, {}, "urgent");
          h.freshSeq++; // too late for a fresh lull line now
          break;
        case "going_twice":
          out = system(ev.type, SYSTEM.goingTwice, {}, "urgent");
          break;
        case "lot_sold":
          // Not "Sold" yet: that word waits for PayPal (rule 4); the stage says it on COMPLETED.
          out = system(ev.type, SYSTEM.hammer, { amount: usd(Number(d.amountCents)), leader: base.leader ?? "the winner" }, "grateful");
          break;
        case "lot_passed":
          out = this.say(roomId, lot?.id ?? null, ev.type, "passed", base, "warm");
          break;
        case "paused":
          out = system(ev.type, SYSTEM.paused, {}, "warm");
          break;
        case "resumed":
          out = system(ev.type, SYSTEM.resumed, {}, "warm");
          break;
        case "bidder_joined":
          this.prepare(roomId); // a room coming to life: write its first banks before lot 1 opens
          break;
        case "lot_advanced":
          out = lot ? system(ev.type, SYSTEM.advanced, { number: String(lot.number), lot: lot.title }, "warm") : null;
          h.fresh = null;
          this.prepare(roomId);
          break;
        default:
          break;
      }
    }
    if (!out) return;
    const line: HostLine = { ...out, id: ++this.seq, lotId: lot?.id ?? null, at: Date.now() };
    h.last = line;
    h.recent = [...h.recent, line.text].slice(-4);
    this.d.emit(roomId, line);
  }

  /** Who may be encouraged: can still afford the next bid, isn't winning, hasn't been nudged twice. */
  private candidates(state: AuctionState, lot: Lot) {
    const leaderId = lot.bids.at(-1)?.bidderId;
    const nudged = this.host(state.id).nudges.get(lot.id);
    const need = minNextBid(lot);
    return Object.values(state.bidders)
      .filter((b) => b.id !== leaderId && remainingHold(b) >= need && (nudged?.get(b.paddle) ?? 0) < MAX_NUDGES)
      .sort((a, b) => a.paddle - b.paddle);
  }

  private lullLine(roomId: string, state: AuctionState, lot: Lot | undefined, base: Vars): Said | null {
    if (!lot) return null;
    const h = this.host(roomId);
    const f = h.fresh;
    h.fresh = null;
    h.freshSeq++; // anything still in flight is now too late
    if (f && f.lotId === lot.id && f.bidCount === lot.bids.length) {
      const target = f.targetPaddle === null ? undefined : this.candidates(state, lot).find((b) => b.paddle === f.targetPaddle);
      if (f.targetPaddle === null || target) {
        // Re-clamped at the moment it is said, and kept close to the screen: before the first bid the ask is the
        // opening price; after it, at most one step above the next valid bid (so the voice never sounds out of step).
        const next = minNextBid(lot);
        const ask = f.askCents === null || !lot.bids.length ? next : Math.min(clampAsk(lot, f.askCents), next + lot.incrementCents);
        const vars: Vars = { ...base, next: usd(ask), target: target ? spoken(target) : undefined };
        const text = fill(f.template, vars);
        if (text) {
          if (target) {
            const m = h.nudges.get(lot.id) ?? new Map<number, number>();
            m.set(target.paddle, (m.get(target.paddle) ?? 0) + 1);
            h.nudges.set(lot.id, m);
          }
          return { text, template: f.template, vars, source: "ai", tone: f.tone, event: "lull" };
        }
      }
    }
    return this.say(roomId, lot.id, "lull", lot.bids.length ? "lullHigh" : "lullOpen", base, "warm");
  }

  /** Non-blocking: draft a line for the next lull. Dropped if the room moves on first. */
  private requestFresh(roomId: string) {
    const ai = this.d.ai;
    const state = this.d.rooms.get(roomId)?.state;
    const lot = state?.lots[state.currentLotIndex];
    if (!ai || !state || !lot) return;
    const h = this.host(roomId);
    const seq = ++h.freshSeq;
    h.fresh = null;
    const bidCount = lot.bids.length;
    const top = lot.bids.at(-1);
    const leader = top ? state.bidders[top.bidderId] : undefined;
    const candidates = this.candidates(state, lot).slice(0, 8);
    const min = minNextBid(lot);
    const ctx = {
      eventName: state.name,
      lotTitle: lot.title,
      lotStory: lot.story,
      leader: leader ? spoken(leader) : null,
      bidCount,
      incrementDollars: lot.incrementCents / 100,
      askRangeDollars: [min / 100, (min + lot.incrementCents) / 100] as [number, number],
      candidates: candidates.map((b) => ({ paddle: b.paddle, name: spoken(b) })),
      recent: h.recent,
    };
    void ai.json(FRESH_SYSTEM, freshPrompt(ctx), { timeoutMs: this.d.freshTimeoutMs ?? 3_000, maxTokens: 200 }).then((raw) => {
      if (raw === null || h.freshSeq !== seq) return; // failed, or the moment has passed
      const parsed = FreshLineSchema.safeParse(raw);
      if (!parsed.success) return this.log("fresh line dropped: wrong shape");
      const p = parsed.data;
      const bad = templateProblem(p.line, FRESH_PLACEHOLDERS);
      if (bad) return this.log(`fresh line dropped: ${bad}`);
      const target = typeof p.addressPaddle === "number" ? candidates.find((b) => b.paddle === p.addressPaddle) : undefined;
      if (p.line.includes("{target}") && !target) return this.log("fresh line dropped: addresses a bidder it may not");
      if (p.line.includes("{leader}") && !leader) return this.log("fresh line dropped: no leader yet");
      h.fresh = {
        lotId: lot.id,
        bidCount,
        template: p.line,
        targetPaddle: target && p.line.includes("{target}") ? target.paddle : null,
        askCents: typeof p.suggestedAsk === "number" && Number.isFinite(p.suggestedAsk) ? Math.round(p.suggestedAsk * 100) : null,
        tone: p.tone,
      };
    });
  }
}
