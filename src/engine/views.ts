/**
 * Role-scoped snapshots. The stage never sees holds (AUCTIONEER.md); a paddle
 * sees only its own hold; the clerk sees everything.
 */
import { highBid, isLive, maxNextBid, minNextBid, remainingHold } from "./engine";
import { publicName } from "./names";
import type { AuctionState, Bidder, Lot, LotStatus } from "./types";

export interface PublicBidder {
  paddle: number;
  name: string; // already filtered: first name with consent, else "Paddle N"
  isBot: boolean;
  simulatedHold: boolean;
}

export interface PublicLot {
  id: string;
  number: number;
  title: string;
  story: string;
  status: LotStatus;
  startCents: number;
  incrementCents: number;
  priceCents: number | null;
  minNextCents: number;
  maxNextCents: number;
  high: PublicBidder | null;
  recentBids: { paddle: number; amountCents: number; at: number }[];
  bidCount: number;
  endsAt: number | null;
  hammerCents: number | null;
}

export interface PublicView {
  id: string;
  name: string;
  isDemo: boolean;
  version: number;
  paused: boolean;
  lotCount: number;
  currentLotIndex: number;
  lot: PublicLot | null;
  lots: { id: string; number: number; title: string; status: LotStatus; hammerCents: number | null; winnerPaddle: number | null }[];
  bidders: PublicBidder[];
  totalRaisedCents: number;
}

export interface PaddleView extends PublicView {
  me: {
    id: string;
    paddle: number;
    name: string;
    holdCents: number;
    wonCents: number;
    remainingCents: number;
    isHigh: boolean;
    simulatedHold: boolean;
  } | null;
}

export interface ClerkView extends PublicView {
  allBidders: (Bidder & { remainingCents: number })[];
  allLots: Lot[];
  logLength: number;
  headHash: string | null;
}

const pub = (b: Bidder): PublicBidder => ({ paddle: b.paddle, name: publicName(b), isBot: b.isBot, simulatedHold: b.simulatedHold });

function publicLot(state: AuctionState, lot: Lot): PublicLot {
  const top = highBid(lot);
  const topBidder = top ? state.bidders[top.bidderId] : undefined;
  return {
    id: lot.id,
    number: lot.number,
    title: lot.title,
    story: lot.story,
    status: lot.status,
    startCents: lot.startCents,
    incrementCents: lot.incrementCents,
    priceCents: top?.amountCents ?? null,
    minNextCents: minNextBid(lot),
    maxNextCents: maxNextBid(lot),
    high: topBidder ? pub(topBidder) : null,
    recentBids: lot.bids.slice(-6).map((b) => ({ paddle: state.bidders[b.bidderId]?.paddle ?? 0, amountCents: b.amountCents, at: b.at })),
    bidCount: lot.bids.length,
    endsAt: isLive(lot) ? lot.endsAt : null,
    hammerCents: lot.hammerCents,
  };
}

export function publicView(state: AuctionState): PublicView {
  const lot = state.lots[state.currentLotIndex];
  return {
    id: state.id,
    name: state.name,
    isDemo: state.isDemo,
    version: state.version,
    paused: state.pausedAt !== null,
    lotCount: state.lots.length,
    currentLotIndex: state.currentLotIndex,
    lot: lot ? publicLot(state, lot) : null,
    lots: state.lots.map((l) => ({
      id: l.id,
      number: l.number,
      title: l.title,
      status: l.status,
      hammerCents: l.hammerCents,
      winnerPaddle: l.winnerId ? (state.bidders[l.winnerId]?.paddle ?? null) : null,
    })),
    bidders: Object.values(state.bidders).sort((a, b) => a.paddle - b.paddle).map(pub),
    totalRaisedCents: state.lots.reduce((s, l) => s + (l.hammerCents ?? 0), 0),
  };
}

export function paddleView(state: AuctionState, bidderId: string | null): PaddleView {
  const view = publicView(state);
  const b = bidderId ? state.bidders[bidderId] : undefined;
  const lot = state.lots[state.currentLotIndex];
  return {
    ...view,
    me: b
      ? {
          id: b.id,
          paddle: b.paddle,
          name: b.name,
          holdCents: b.holdCents,
          wonCents: b.wonCents,
          remainingCents: remainingHold(b),
          isHigh: !!lot && isLive(lot) && highBid(lot)?.bidderId === b.id,
          simulatedHold: b.simulatedHold,
        }
      : null,
  };
}

export function clerkView(state: AuctionState): ClerkView {
  return {
    ...publicView(state),
    allBidders: Object.values(state.bidders)
      .sort((a, b) => a.paddle - b.paddle)
      .map((b) => ({ ...b, remainingCents: remainingHold(b) })),
    allLots: state.lots,
    logLength: state.log.length,
    headHash: state.log[state.log.length - 1]?.hash ?? null,
  };
}
