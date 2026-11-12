/**
 * Demo mode (DEMO.md, BUILD_PLAN M8): five labelled bots and an autopilot that
 * runs the lots, so a judge can win a lot with a real hold in under 3 minutes.
 *
 * - Bots exist only in demo rooms (the engine refuses them elsewhere) and are
 *   always isBot + simulatedHold, so every screen tags them "BOT" and no money
 *   is ever taken from them.
 * - Bots bid through the same engine command as phones, at the minimum next
 *   bid, so the engine's rules (increments, holds, soft close) apply to them.
 * - Each bot values each lot privately. Once a human has bid on a lot, bots
 *   make at most a raise or two more, then fold: the judge can always win.
 * - The AI is not involved: bots and autopilot are plain code.
 */
import { randomUUID } from "node:crypto";
import { highBid, isLive, minNextBid, remainingHold, type EngineEvent, type Lot } from "../engine";
import type { RoomManager } from "./rooms";

export type Temperament = "cautious" | "eager" | "sniper" | "steady" | "generous";

export interface Persona {
  temperament: Temperament;
  name: string;
  holdCents: number;
  /** Private value of a lot, as a multiple of its starting price (min, max). */
  value: [number, number];
}

/** Fictional names only (DEMO.md). */
export const PERSONAS: Persona[] = [
  { temperament: "cautious", name: "Marigold", holdCents: 350_00, value: [1.1, 1.4] },
  { temperament: "eager", name: "Toby", holdCents: 600_00, value: [1.3, 1.9] },
  { temperament: "sniper", name: "Vesper", holdCents: 500_00, value: [1.3, 1.8] },
  { temperament: "steady", name: "Hollis", holdCents: 500_00, value: [1.2, 1.6] },
  { temperament: "generous", name: "Odette", holdCents: 900_00, value: [1.5, 2.2] },
];

const LIVE_EVENTS = new Set(["lot_opened", "bid_accepted", "lull", "going_once", "going_twice", "back_to_open", "resumed"]);

interface LotPlan {
  lotId: string;
  caps: Map<string, number>; // bidderId -> private max (cents)
  botBids: number;
  /** Bot raises still allowed after a human's latest bid. Null until a human bids. */
  afterHuman: number | null;
}

export interface DemoTiming {
  /** After a sale/pass: wait, then move to the next lot. */
  advanceMs: number;
  /** After moving on: wait, then open the next lot. */
  openMs: number;
  /** After the first human joins a waiting room: wait, then open lot 1. */
  firstOpenMs: number;
  /** Scale for bot reaction times (1 = natural; tests use smaller). */
  reactScale: number;
}

export const DEFAULT_TIMING: DemoTiming = { advanceMs: 9_000, openMs: 4_000, firstOpenMs: 4_000, reactScale: 1 };
const MAX_BOT_BIDS_PER_LOT = 9;

export class DemoDirector {
  private plans = new Map<string, LotPlan>();
  private botTimers = new Map<string, NodeJS.Timeout>();
  private flowTimers = new Map<string, NodeJS.Timeout>();
  private readonly t: DemoTiming;
  private readonly rng: () => number;

  constructor(
    private readonly d: {
      rooms: RoomManager;
      timing?: Partial<DemoTiming>;
      rng?: () => number;
      /** After the last lot: end the night (release holds). Resolves ok:false while captures settle. */
      onFinished?: (roomId: string) => Promise<{ ok: boolean; reason?: string }>;
    },
  ) {
    this.t = { ...DEFAULT_TIMING, ...d.timing };
    this.rng = d.rng ?? Math.random;
  }

  /** Add the five bots to a demo room. */
  seedBots(roomId: string) {
    for (const p of PERSONAS) {
      const r = this.d.rooms.dispatch(roomId, {
        type: "add_bidder",
        bidder: { id: `bot-${p.temperament}-${randomUUID().slice(0, 8)}`, name: p.name, showName: true, holdCents: p.holdCents, isBot: true, simulatedHold: true },
      });
      if (!r.ok) throw new Error(`bot refused: ${r.reason}`);
    }
  }

  /** Only rooms with bots are directed (the seeded "riverside" room is left alone). */
  isDirected(roomId: string) {
    const s = this.d.rooms.get(roomId)?.state;
    return !!s?.isDemo && Object.values(s.bidders).some((b) => b.isBot);
  }

  /** Start the first lot now (the judge view's button). */
  start(roomId: string) {
    const lot = this.d.rooms.get(roomId)?.currentLot;
    if (lot?.status !== "waiting") return { ok: false, reason: "not_waiting" };
    return this.d.rooms.dispatch(roomId, { type: "open_lot" });
  }

  handleEvents = (roomId: string, events: EngineEvent[]) => {
    if (!events.length || !this.isDirected(roomId)) return;
    const engine = this.d.rooms.get(roomId)!;
    for (const ev of events) {
      if (ev.type === "bidder_joined" && !ev.data.isBot) {
        // The first real guest is in: open lot 1 shortly, if nobody has.
        const lot = engine.currentLot;
        if (engine.state.currentLotIndex === 0 && lot?.status === "waiting") this.flow(roomId, this.t.firstOpenMs, () => this.start(roomId));
      }
      if (ev.type === "bid_accepted") this.noteBid(roomId, String(ev.data.lotId), String(ev.data.bidderId));
      if (ev.type === "lot_sold" || ev.type === "lot_passed") {
        this.clearBot(roomId);
        this.flow(roomId, ev.type === "lot_sold" ? this.t.advanceMs : this.t.advanceMs / 2, () => {
          const r = this.d.rooms.dispatch(roomId, { type: "next_lot" });
          if (r.ok) this.flow(roomId, this.t.openMs, () => this.d.rooms.dispatch(roomId, { type: "open_lot" }));
          else if (r.reason !== "night_closed") this.finish(roomId, 0);
        });
      }
      if (ev.type === "paused") this.clearBot(roomId);
    }
    if (events.some((e) => LIVE_EVENTS.has(e.type))) this.plan(roomId);
  };

  stop() {
    for (const t of [...this.botTimers.values(), ...this.flowTimers.values()]) clearTimeout(t);
    this.botTimers.clear();
    this.flowTimers.clear();
  }

  // ---------------------------------------------------------------------------

  private flow(roomId: string, ms: number, fn: () => unknown) {
    clearTimeout(this.flowTimers.get(roomId));
    const t = setTimeout(() => {
      this.flowTimers.delete(roomId);
      fn();
    }, ms);
    t.unref?.();
    this.flowTimers.set(roomId, t);
  }

  /** The last lot is done: close the night, retrying while captures settle. */
  private finish(roomId: string, tries: number) {
    const done = this.d.onFinished;
    if (!done) return;
    void done(roomId).then((r) => {
      if (!r.ok && r.reason === "captures_in_flight" && tries < 20) this.flow(roomId, 3_000, () => this.finish(roomId, tries + 1));
    });
  }

  private clearBot(roomId: string) {
    clearTimeout(this.botTimers.get(roomId));
    this.botTimers.delete(roomId);
  }

  private planFor(roomId: string, lot: Lot): LotPlan {
    const key = `${roomId}:${lot.id}`;
    let p = this.plans.get(key);
    if (!p) {
      const caps = new Map<string, number>();
      for (const b of Object.values(this.d.rooms.get(roomId)!.state.bidders)) {
        const persona = personaOf(b.id);
        if (!persona) continue;
        const [lo, hi] = persona.value;
        const raw = lot.startCents * (lo + (hi - lo) * this.rng());
        caps.set(b.id, Math.round(raw / lot.incrementCents) * lot.incrementCents);
      }
      p = { lotId: lot.id, caps, botBids: 0, afterHuman: null };
      this.plans.set(key, p);
    }
    return p;
  }

  private noteBid(roomId: string, lotId: string, bidderId: string) {
    const lot = this.d.rooms.get(roomId)?.currentLot;
    if (!lot || lot.id !== lotId) return;
    const p = this.planFor(roomId, lot);
    if (personaOf(bidderId)) {
      p.botBids++;
      if (p.afterHuman !== null) p.afterHuman--;
    } else {
      // A human is bidding: let the bots push back once or twice at most, then fold.
      // (about 20% fold at once, 45% raise once, 35% raise twice)
      const r = this.rng();
      p.afterHuman = r < 0.2 ? 0 : r < 0.65 ? 1 : 2;
    }
  }

  /** Pick the next bot move for the room (one pending move at a time; each new event re-plans). */
  private plan(roomId: string) {
    this.clearBot(roomId);
    const engine = this.d.rooms.get(roomId);
    const lot = engine?.currentLot;
    if (!engine || !isLive(lot) || engine.state.pausedAt !== null) return;
    const p = this.planFor(roomId, lot);
    if (p.botBids >= MAX_BOT_BIDS_PER_LOT || (p.afterHuman !== null && p.afterHuman <= 0)) return;

    const high = highBid(lot)?.bidderId ?? null;
    const next = minNextBid(lot);
    const candidates: { id: string; delay: number }[] = [];
    for (const b of Object.values(engine.state.bidders)) {
      const persona = personaOf(b.id);
      if (!persona || b.id === high) continue;
      const cap = p.caps.get(b.id) ?? 0;
      if (next > cap || next > remainingHold(b)) continue;
      const delay = this.reaction(persona.temperament, lot, next, cap, !!high);
      if (delay !== null) candidates.push({ id: b.id, delay: delay * this.t.reactScale });
    }
    if (!candidates.length) return;
    const pick = candidates.sort((a, b) => a.delay - b.delay)[0]!;
    const t = setTimeout(() => {
      this.botTimers.delete(roomId);
      const now = this.d.rooms.get(roomId)?.currentLot;
      if (!isLive(now) || now.id !== lot.id || highBid(now)?.bidderId === pick.id) return;
      this.d.rooms.dispatch(roomId, { type: "bid", bidderId: pick.id, lotId: now.id, amountCents: minNextBid(now) });
    }, pick.delay);
    t.unref?.();
    this.botTimers.set(roomId, t);
  }

  /** Milliseconds until this bot would bid, or null if it sits this moment out. */
  private reaction(temp: Temperament, lot: Lot, next: number, cap: number, hasHigh: boolean): number | null {
    const r = this.rng();
    const between = (a: number, b: number) => a + (b - a) * this.rng();
    const s = lot.status;
    switch (temp) {
      case "eager": // jumps in fast while the lot is open
        return s === "open" && r < 0.75 ? between(1_400, 2_600) : null;
      case "steady": // waits for the room to go quiet
        return s === "open" && r < 0.7 ? between(4_300, 5_500) : null;
      case "cautious": // only early and cheap, and only when called
        return (s === "going_once" || !hasHigh) && next <= cap * 0.85 && r < 0.6 ? between(900, 1_600) : null;
      case "sniper": // the last moment: going twice
        return s === "going_twice" && r < 0.6 ? between(600, 1_300) : null;
      case "generous": // a slower, warm-hearted raise
        return s === "open" && r < 0.45 ? between(2_800, 4_000) : null;
    }
  }
}

function personaOf(bidderId: string): Persona | undefined {
  const m = /^bot-([a-z]+)-/.exec(bidderId);
  return m ? PERSONAS.find((p) => p.temperament === m[1]) : undefined;
}
