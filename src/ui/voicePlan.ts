/**
 * Which clips the stage should pre-render, in priority order (AUCTIONEER.md
 * "Numbers are pre-rendered"): the current lot's templates, the bidders'
 * spoken names, the amounts just above the current price, then the next lot.
 */
import { staticPieces } from "@/auctioneer/pieces";
import { formatUsd } from "@/engine";
import type { StageSnapshot } from "./useRoom";

// Kokoro renders ~1 clip per 1–3 s on WebAssembly, so keep the ladder short; it moves with the price.
const AMOUNT_STEPS_CURRENT = 10;
const AMOUNT_STEPS_NEXT = 6;

/** Same as the server's spoken names: "Asha" or "paddle 3". */
export const spokenName = (b: { paddle: number; name: string }) => (b.name === `Paddle ${b.paddle}` ? `paddle ${b.paddle}` : b.name);

export function planClips(s: StageSnapshot): { text: string; prio: number }[] {
  const out: { text: string; prio: number }[] = [];
  const plan = s.voicePlan?.lots ?? [];
  plan.forEach((p, i) => {
    const current = i === 0;
    const base = current ? 600 : 200;
    const meta = s.lots.find((l) => l.id === p.lotId);
    const lot = s.lot?.id === p.lotId ? s.lot : null;
    for (const t of p.templates) for (const piece of staticPieces(t)) out.push({ text: piece, prio: base + 100 });
    if (meta) {
      out.push({ text: meta.title, prio: base + 90 });
      out.push({ text: String(meta.number), prio: base + 80 });
    }
    // Amounts: from the current price (or the opening price) upwards, nearest first.
    const start = p.startCents;
    const inc = p.incrementCents;
    if (inc > 0) {
      const from = lot?.priceCents ?? start;
      const steps = current ? AMOUNT_STEPS_CURRENT : AMOUNT_STEPS_NEXT;
      out.push({ text: formatUsd(start), prio: base + 85 });
      for (let k = 0; k <= steps; k++) out.push({ text: formatUsd(from + k * inc), prio: base + 70 - k });
    }
  });
  // Names are shared by every lot.
  for (const b of s.bidders) out.push({ text: spokenName(b), prio: 680 });
  out.push({ text: "the winner", prio: 300 });
  return out;
}
