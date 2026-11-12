/**
 * Deterministic auctioneer lines chosen by code from engine events. Used until
 * the AI host (M7) is wired in, and kept afterwards as the no-AI fallback.
 * Names come from the public view only (already consent- and profanity-filtered).
 */
import type { EngineEvent, PublicView } from "../engine";

const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** "Asha" or "paddle 9" — never "Paddle 9" mid-sentence. */
function who(view: PublicView, paddle: unknown): string {
  const b = view.bidders.find((x) => x.paddle === paddle);
  if (!b) return `paddle ${String(paddle)}`;
  return b.name === `Paddle ${b.paddle}` ? `paddle ${b.paddle}` : b.name;
}

/** Pick a variant by a stable number so the same moment reads the same on every screen. */
const pick = (options: string[], seed: number) => options[Math.abs(seed) % options.length]!;

/** Spoken once PayPal reports the capture COMPLETED (or, for a simulated hold, once it is recorded). */
export function soldLine(view: PublicView, paddle: number, amountCents: number, simulated: boolean): string {
  const name = who(view, paddle);
  return simulated ? `Won by ${name} for ${usd(amountCents)}. Thank you.` : `Sold, to ${name}, for ${usd(amountCents)}. Thank you.`;
}

export function lineFor(ev: EngineEvent, view: PublicView): string | null {
  const lot = view.lot;
  const d = ev.data;
  const seed = view.version + (lot?.bidCount ?? 0);
  switch (ev.type) {
    case "lot_opened":
      return lot ? `Lot ${lot.number}: ${lot.title}. Who'll start me at ${usd(lot.startCents)}?` : null;
    case "bid_accepted": {
      if (!lot) return null;
      const name = who(view, d.paddle);
      const amount = usd(Number(d.amountCents));
      const next = usd(lot.minNextCents);
      return pick(
        [`${amount} to ${name}. Do I hear ${next}?`, `${name} has it at ${amount}. ${next}, anyone?`, `${amount}, thank you ${name}. Looking for ${next}.`],
        seed,
      );
    }
    case "lull":
      if (!lot) return null;
      return lot.high
        ? pick([`Still ${usd(lot.priceCents ?? 0)} with ${who(view, lot.high.paddle)}. Will anyone go ${usd(lot.minNextCents)}?`, `It's a good cause, and it's ${usd(lot.minNextCents)} to stay in.`], seed)
        : pick([`Who'll start me at ${usd(lot.startCents)}? Every bid fills a shelf.`, `Opening at ${usd(lot.startCents)}. Paddles up.`], seed);
    case "soft_close_extended":
      return "A late bid, so we keep going.";
    case "going_once":
      return lot?.high ? `Going once at ${usd(lot.priceCents ?? 0)}…` : "Going once at the opening price…";
    case "going_twice":
      return "Going twice…";
    case "lot_sold":
      // Not "Sold" yet: that word waits for PayPal to confirm the capture (rule 4). See soldLine().
      return `Hammer down: ${usd(Number(d.amountCents))} to ${who(view, d.paddle)}.`;
    case "lot_passed":
      return "No takers this time. We'll come back to it.";
    case "paused":
      return "A short pause. Stay with us.";
    case "resumed":
      return "And we're back.";
    case "lot_advanced":
      return lot ? `Next up, lot ${lot.number}: ${lot.title}.` : null;
    default:
      return null;
  }
}
