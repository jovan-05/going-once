/**
 * Auction engine types. All money is integer US cents. All times are epoch ms
 * supplied by the caller (the engine never reads the clock itself).
 */

export type LotStatus = "waiting" | "open" | "going_once" | "going_twice" | "sold" | "passed";

export const LIVE_STATUSES: readonly LotStatus[] = ["open", "going_once", "going_twice"];

export interface EngineConfig {
  /** Silence after the last bid (or opening) before a `lull` event. */
  lullMs: number;
  /** Silence after the last bid before "going once". */
  silenceMs: number;
  /** Before the first bid, how long the lot waits before "going once" (people need time to reach their phones). */
  openingSilenceMs: number;
  /** Time between going once → going twice → hammer. */
  callStepMs: number;
  /** Scheduled lot length; the soft-close window applies to its end. */
  lotDurationMs: number;
  /** A bid with less than this left on the lot clock extends it… */
  softCloseWindowMs: number;
  /** …by this much. */
  softCloseExtendMs: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  lullMs: 4_000,
  silenceMs: 8_000,
  openingSilenceMs: 30_000,
  callStepMs: 2_500,
  lotDurationMs: 90_000,
  softCloseWindowMs: 10_000,
  softCloseExtendMs: 10_000,
};

export interface LotInput {
  id: string;
  title: string;
  story: string;
  startCents: number;
  incrementCents: number;
  /** Largest single jump above the current price; defaults to 10 × increment. */
  maxJumpCents?: number;
}

export interface Bid {
  bidderId: string;
  amountCents: number;
  at: number;
}

export interface Lot extends Required<LotInput> {
  number: number;
  status: LotStatus;
  bids: Bid[];
  openedAt: number | null;
  lastActivityAt: number | null;
  endsAt: number | null;
  lullEmitted: boolean;
  closedAt: number | null;
  winnerId: string | null;
  hammerCents: number | null;
}

export interface BidderInput {
  id: string;
  name: string;
  /** Consent to show first name on the big screen (rule 8). */
  showName: boolean;
  holdCents: number;
  isBot?: boolean;
  /** Hold is not a real PayPal authorization (bots / dev test bidders). */
  simulatedHold?: boolean;
}

export interface Bidder {
  id: string;
  paddle: number;
  name: string;
  showName: boolean;
  isBot: boolean;
  simulatedHold: boolean;
  holdCents: number;
  wonCents: number;
  joinedAt: number;
}

export interface EventLogEntry {
  seq: number;
  at: number;
  type: EngineEventType;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AuctionState {
  id: string;
  name: string;
  isDemo: boolean;
  config: EngineConfig;
  lots: Lot[];
  bidders: Record<string, Bidder>;
  currentLotIndex: number;
  nextPaddle: number;
  pausedAt: number | null;
  version: number;
  log: EventLogEntry[];
}

export type RejectReason =
  | "no_live_lot"
  | "wrong_lot"
  | "paused"
  | "unknown_bidder"
  | "already_high_bidder"
  | "below_minimum"
  | "above_max_jump"
  | "exceeds_hold"
  | "invalid_amount";

export type Command =
  | { type: "add_bidder"; bidder: BidderInput }
  | { type: "set_hold"; bidderId: string; holdCents: number }
  | { type: "open_lot" }
  | { type: "bid"; bidderId: string; lotId: string; amountCents: number }
  | { type: "tick" }
  | { type: "close_lot" }
  | { type: "next_lot" }
  | { type: "pause" }
  | { type: "resume" }
  /** Organiser adds a lot to the end of the night (e.g. drafted by the AI lot writer, then approved). */
  | { type: "add_lot"; lot: LotInput };

export type EngineEventType =
  | "event_created"
  | "bidder_joined"
  | "hold_set"
  | "lot_opened"
  | "bid_accepted"
  | "bid_rejected"
  | "soft_close_extended"
  | "lull"
  | "going_once"
  | "going_twice"
  | "back_to_open"
  | "lot_sold"
  | "lot_passed"
  | "lot_advanced"
  | "lot_added"
  | "paused"
  | "resumed"
  | "command_rejected";

export interface EngineEvent {
  type: EngineEventType;
  at: number;
  data: Record<string, unknown>;
}

export interface DispatchResult {
  ok: boolean;
  reason?: RejectReason | string;
  events: EngineEvent[];
}
