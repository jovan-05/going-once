/**
 * The deterministic auction engine. Pure: no I/O, no clock reads, no randomness.
 * The caller passes `now` with every command. This is the only code that may
 * accept a bid, move the clock, or decide a winner (CLAUDE.md rule 2).
 *
 * Lot lifecycle: waiting → open → going_once → going_twice → sold | passed
 * A bid during going_once / going_twice returns the lot to open.
 *
 * Timing (all from EngineConfig):
 *   goingOnceAt = min(lastActivityAt + (no bids yet ? openingSilenceMs : silenceMs), endsAt − 2·callStepMs)
 *   going_twice at goingOnceAt + callStepMs, hammer at goingOnceAt + 2·callStepMs
 *   A bid with < softCloseWindowMs left before endsAt pushes endsAt by softCloseExtendMs.
 */
import { appendToLog } from "./log";
import {
  DEFAULT_CONFIG,
  LIVE_STATUSES,
  type AuctionState,
  type Bidder,
  type BidderInput,
  type Command,
  type DispatchResult,
  type EngineConfig,
  type EngineEvent,
  type EngineEventType,
  type Lot,
  type LotInput,
} from "./types";

export interface CreateAuctionInput {
  id: string;
  name: string;
  isDemo: boolean;
  lots: LotInput[];
  config?: Partial<EngineConfig>;
}

const isMoney = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

export function remainingHold(b: Pick<Bidder, "holdCents" | "wonCents">): number {
  return Math.max(0, b.holdCents - b.wonCents);
}

export function isLive(lot: Lot | undefined): lot is Lot {
  return !!lot && LIVE_STATUSES.includes(lot.status);
}

export function highBid(lot: Lot) {
  return lot.bids[lot.bids.length - 1];
}

/** Smallest acceptable next bid. */
export function minNextBid(lot: Lot): number {
  const top = highBid(lot);
  return top ? top.amountCents + lot.incrementCents : lot.startCents;
}

/** Largest acceptable next bid (guards against fat-finger jumps). */
export function maxNextBid(lot: Lot): number {
  const top = highBid(lot);
  return (top ? top.amountCents : lot.startCents) + lot.maxJumpCents;
}

export function goingOnceAt(lot: Lot, cfg: EngineConfig): number | null {
  if (lot.lastActivityAt === null || lot.endsAt === null) return null;
  const silence = lot.bids.length ? cfg.silenceMs : cfg.openingSilenceMs;
  return Math.min(lot.lastActivityAt + silence, lot.endsAt - 2 * cfg.callStepMs);
}

/** Clamp an AI-suggested asking price into the lot's rules (AUCTIONEER.md). */
export function clampAsk(lot: Lot, suggested: unknown): number {
  // Valid asks sit on the grid base + k·increment, k ≥ 1, not above maxNextBid.
  const inc = lot.incrementCents;
  const base = minNextBid(lot) - inc;
  if (typeof suggested !== "number" || !Number.isFinite(suggested)) return base + inc;
  const kMax = Math.max(1, Math.floor((maxNextBid(lot) - base) / inc));
  const k = Math.min(Math.max(Math.round((suggested - base) / inc), 1), kMax);
  return base + k * inc;
}

export class AuctionEngine {
  private constructor(public state: AuctionState) {}

  static create(input: CreateAuctionInput, now: number): AuctionEngine {
    const config = { ...DEFAULT_CONFIG, ...input.config };
    const lots: Lot[] = input.lots.map((l, i) => {
      if (!isMoney(l.startCents) || !isMoney(l.incrementCents)) throw new Error(`Lot ${l.id}: prices must be positive integer cents`);
      return {
        id: l.id,
        title: l.title,
        story: l.story,
        startCents: l.startCents,
        incrementCents: l.incrementCents,
        maxJumpCents: l.maxJumpCents ?? l.incrementCents * 10,
        number: i + 1,
        status: "waiting",
        bids: [],
        openedAt: null,
        lastActivityAt: null,
        endsAt: null,
        lullEmitted: false,
        closedAt: null,
        winnerId: null,
        hammerCents: null,
      };
    });
    const engine = new AuctionEngine({
      id: input.id,
      name: input.name,
      isDemo: input.isDemo,
      config,
      lots,
      bidders: {},
      currentLotIndex: 0,
      nextPaddle: 1,
      pausedAt: null,
      version: 0,
      log: [],
    });
    const events: EngineEvent[] = [];
    engine.emit(events, "event_created", now, { id: input.id, isDemo: input.isDemo, lots: lots.map((l) => l.id) });
    return engine;
  }

  static fromState(state: AuctionState): AuctionEngine {
    // Rooms saved before a config field existed pick up its default.
    return new AuctionEngine({ ...state, config: { ...DEFAULT_CONFIG, ...state.config } });
  }

  get currentLot(): Lot | undefined {
    return this.state.lots[this.state.currentLotIndex];
  }

  dispatch(cmd: Command, now: number): DispatchResult {
    const events: EngineEvent[] = [];
    const reject = (reason: string, data: Record<string, unknown> = {}): DispatchResult => {
      this.emit(events, cmd.type === "bid" ? "bid_rejected" : "command_rejected", now, { command: cmd.type, reason, ...data });
      return { ok: false, reason, events };
    };

    switch (cmd.type) {
      case "add_bidder":
        return this.addBidder(cmd.bidder, now, events, reject);

      case "set_hold": {
        const b = this.state.bidders[cmd.bidderId];
        if (!b) return reject("unknown_bidder");
        if (!Number.isSafeInteger(cmd.holdCents) || cmd.holdCents < 0) return reject("invalid_amount");
        const lot = this.currentLot;
        const leading = isLive(lot) && highBid(lot)?.bidderId === b.id ? highBid(lot)!.amountCents : 0;
        if (cmd.holdCents < b.wonCents + leading) return reject("hold_below_commitments");
        b.holdCents = cmd.holdCents;
        this.emit(events, "hold_set", now, { bidderId: b.id, holdCents: b.holdCents });
        return { ok: true, events };
      }

      case "open_lot": {
        const lot = this.currentLot;
        if (!lot) return reject("no_more_lots");
        if (lot.status !== "waiting") return reject("lot_not_waiting");
        if (this.state.pausedAt !== null) return reject("paused");
        lot.status = "open";
        lot.openedAt = now;
        lot.lastActivityAt = now;
        lot.endsAt = now + this.state.config.lotDurationMs;
        lot.lullEmitted = false;
        this.emit(events, "lot_opened", now, { lotId: lot.id, number: lot.number, startCents: lot.startCents, endsAt: lot.endsAt });
        return { ok: true, events };
      }

      case "bid":
        return this.bid(cmd, now, events, reject);

      case "tick":
        this.tick(now, events);
        return { ok: true, events };

      case "close_lot": {
        const lot = this.currentLot;
        if (!isLive(lot)) return reject("no_live_lot");
        if (this.state.pausedAt !== null) return reject("paused");
        this.hammer(lot, now, events, "clerk");
        return { ok: true, events };
      }

      case "next_lot": {
        const lot = this.currentLot;
        if (!lot || (lot.status !== "sold" && lot.status !== "passed")) return reject("lot_not_closed");
        if (this.state.currentLotIndex >= this.state.lots.length - 1) return reject("no_more_lots");
        this.state.currentLotIndex += 1;
        this.emit(events, "lot_advanced", now, { lotId: this.currentLot!.id, number: this.currentLot!.number });
        return { ok: true, events };
      }

      case "pause": {
        if (this.state.pausedAt !== null) return reject("already_paused");
        this.tick(now, events); // settle anything already due before freezing
        this.state.pausedAt = now;
        this.emit(events, "paused", now, {});
        return { ok: true, events };
      }

      case "add_lot": {
        const l = cmd.lot;
        const title = typeof l.title === "string" ? l.title.trim() : "";
        const story = typeof l.story === "string" ? l.story.trim() : "";
        if (!/^[a-z0-9-]{1,40}$/.test(l.id ?? "")) return reject("invalid_lot_id");
        if (this.state.lots.some((x) => x.id === l.id)) return reject("duplicate_lot");
        if (!title || title.length > 80 || story.length > 400) return reject("invalid_lot_text");
        if (!isMoney(l.startCents) || !isMoney(l.incrementCents) || l.startCents > 100_000_00 || l.incrementCents > l.startCents * 2)
          return reject("invalid_amount");
        const lot: Lot = {
          id: l.id,
          title,
          story,
          startCents: l.startCents,
          incrementCents: l.incrementCents,
          maxJumpCents: l.maxJumpCents ?? l.incrementCents * 10,
          number: this.state.lots.length + 1,
          status: "waiting",
          bids: [],
          openedAt: null,
          lastActivityAt: null,
          endsAt: null,
          lullEmitted: false,
          closedAt: null,
          winnerId: null,
          hammerCents: null,
        };
        this.state.lots.push(lot);
        this.emit(events, "lot_added", now, { lotId: lot.id, number: lot.number, startCents: lot.startCents, incrementCents: lot.incrementCents });
        return { ok: true, events };
      }

      case "resume": {
        if (this.state.pausedAt === null) return reject("not_paused");
        const delta = now - this.state.pausedAt;
        const lot = this.currentLot;
        if (isLive(lot)) {
          lot.lastActivityAt = (lot.lastActivityAt ?? now) + delta;
          lot.endsAt = (lot.endsAt ?? now) + delta;
        }
        this.state.pausedAt = null;
        this.emit(events, "resumed", now, { pausedMs: delta });
        return { ok: true, events };
      }
    }
  }

  // ---------- internals ----------

  private addBidder(input: BidderInput, now: number, events: EngineEvent[], reject: (r: string) => DispatchResult): DispatchResult {
    if (!input.id || this.state.bidders[input.id]) return reject("duplicate_bidder");
    // Rule 6: bots and simulated holds exist only in demo rooms.
    if ((input.isBot || input.simulatedHold) && !this.state.isDemo) return reject("bots_only_in_demo");
    if (!Number.isSafeInteger(input.holdCents) || input.holdCents < 0) return reject("invalid_amount");
    const b: Bidder = {
      id: input.id,
      paddle: this.state.nextPaddle++,
      name: input.name,
      showName: input.showName,
      isBot: !!input.isBot,
      simulatedHold: !!input.simulatedHold || !!input.isBot,
      holdCents: input.holdCents,
      wonCents: 0,
      joinedAt: now,
    };
    this.state.bidders[b.id] = b;
    this.emit(events, "bidder_joined", now, { bidderId: b.id, paddle: b.paddle, isBot: b.isBot, holdCents: b.holdCents });
    return { ok: true, events };
  }

  private bid(
    cmd: Extract<Command, { type: "bid" }>,
    now: number,
    events: EngineEvent[],
    reject: (r: string, d?: Record<string, unknown>) => DispatchResult,
  ): DispatchResult {
    const ctx = { bidderId: cmd.bidderId, lotId: cmd.lotId, amountCents: cmd.amountCents };
    if (this.state.pausedAt !== null) return reject("paused", ctx);
    // Settle the clock first: a bid that arrives after the hammer time is too late.
    this.tick(now, events);
    const lot = this.currentLot;
    if (!isLive(lot)) return reject("no_live_lot", ctx);
    if (lot.id !== cmd.lotId) return reject("wrong_lot", ctx);
    const bidder = this.state.bidders[cmd.bidderId];
    if (!bidder) return reject("unknown_bidder", ctx);
    if (!isMoney(cmd.amountCents)) return reject("invalid_amount", ctx);
    if (highBid(lot)?.bidderId === bidder.id) return reject("already_high_bidder", ctx);
    if (cmd.amountCents < minNextBid(lot)) return reject("below_minimum", { ...ctx, minCents: minNextBid(lot) });
    if (cmd.amountCents > maxNextBid(lot)) return reject("above_max_jump", { ...ctx, maxCents: maxNextBid(lot) });
    // Rule 5: never above the bidder's remaining hold.
    if (cmd.amountCents > remainingHold(bidder)) return reject("exceeds_hold", ctx);

    lot.bids.push({ bidderId: bidder.id, amountCents: cmd.amountCents, at: now });
    const wasCalling = lot.status !== "open";
    lot.status = "open";
    lot.lastActivityAt = now;
    lot.lullEmitted = false;
    this.emit(events, "bid_accepted", now, { lotId: lot.id, bidderId: bidder.id, paddle: bidder.paddle, amountCents: cmd.amountCents });
    if (wasCalling) this.emit(events, "back_to_open", now, { lotId: lot.id });

    const cfg = this.state.config;
    if (lot.endsAt !== null && lot.endsAt - now < cfg.softCloseWindowMs) {
      lot.endsAt += cfg.softCloseExtendMs;
      this.emit(events, "soft_close_extended", now, { lotId: lot.id, endsAt: lot.endsAt });
    }
    return { ok: true, events };
  }

  private tick(now: number, events: EngineEvent[]) {
    if (this.state.pausedAt !== null) return;
    const lot = this.currentLot;
    if (!isLive(lot) || lot.lastActivityAt === null) return;
    const cfg = this.state.config;
    const once = goingOnceAt(lot, cfg)!;

    if (lot.status === "open" && !lot.lullEmitted && now >= lot.lastActivityAt + cfg.lullMs && now < once) {
      lot.lullEmitted = true;
      this.emit(events, "lull", now, { lotId: lot.id, silentMs: now - lot.lastActivityAt });
    }
    if (lot.status === "open" && now >= once) {
      lot.status = "going_once";
      this.emit(events, "going_once", now, { lotId: lot.id });
    }
    if (lot.status === "going_once" && now >= once + cfg.callStepMs) {
      lot.status = "going_twice";
      this.emit(events, "going_twice", now, { lotId: lot.id });
    }
    if (lot.status === "going_twice" && now >= once + 2 * cfg.callStepMs) {
      this.hammer(lot, now, events, "clock");
    }
  }

  private hammer(lot: Lot, now: number, events: EngineEvent[], by: "clock" | "clerk") {
    const top = highBid(lot);
    lot.closedAt = now;
    if (!top) {
      lot.status = "passed";
      this.emit(events, "lot_passed", now, { lotId: lot.id, by });
      return;
    }
    const winner = this.state.bidders[top.bidderId]!;
    lot.status = "sold";
    lot.winnerId = winner.id;
    lot.hammerCents = top.amountCents;
    winner.wonCents += top.amountCents;
    this.emit(events, "lot_sold", now, {
      lotId: lot.id,
      bidderId: winner.id,
      paddle: winner.paddle,
      amountCents: top.amountCents,
      by,
    });
  }

  private emit(events: EngineEvent[], type: EngineEventType, at: number, data: Record<string, unknown>) {
    const ev: EngineEvent = { type, at, data };
    events.push(ev);
    appendToLog(this.state.log, ev);
    this.state.version += 1;
  }
}
