/**
 * Splitting a line into audio pieces (AUCTIONEER.md "Numbers are pre-rendered").
 *
 * A filled line like "$240 to Asha. Do I hear $260?" is spoken as clips:
 *   ["$240"] ["to"] ["Asha"] ["Do I hear"] ["$260"]
 * Template text and every value (amounts, names, lot titles) is one clip, and
 * punctuation becomes a pause. The stage renders all the clips for a lot
 * before it opens, so during bidding a line is only stitched together, never
 * synthesised. Lines with no placeholders are a single clip, punctuation kept.
 */
import type { Vars } from "./templates";

export interface Piece {
  text: string;
  /** Silence after this clip. */
  pauseMs: number;
  /** True if the text came from a placeholder value. */
  value: boolean;
}

const PUNCT = /[\s.,!?;:…—–-]/;
const pauseFor = (p: string) => (/[.!?…]/.test(p) ? 260 : /[,;:—–-]/.test(p) ? 140 : 40);

export function linePieces(template: string, vars: Vars): Piece[] | null {
  const t = template.trim();
  if (!/\{[a-z]+\}/.test(t)) return t ? [{ text: t, pauseMs: 0, value: false }] : [];
  const out: Piece[] = [];
  for (const tok of t.split(/(\{[a-z]+\})/)) {
    if (!tok) continue;
    const m = /^\{([a-z]+)\}$/.exec(tok);
    const raw = m ? vars[m[1] as keyof Vars] : tok;
    if (raw === undefined) return null;
    let i = 0;
    while (i < raw.length && PUNCT.test(raw[i]!)) i++;
    let j = raw.length;
    while (j > i && PUNCT.test(raw[j - 1]!)) j--;
    const lead = raw.slice(0, i);
    const core = raw.slice(i, j);
    const trail = raw.slice(j);
    const prev = out.at(-1);
    if (prev && lead.trim()) prev.pauseMs = Math.max(prev.pauseMs, pauseFor(lead));
    if (!core) {
      if (prev && trail.trim()) prev.pauseMs = Math.max(prev.pauseMs, pauseFor(trail));
      continue;
    }
    out.push({ text: core, pauseMs: trail.trim() ? pauseFor(trail) : 40, value: !!m });
  }
  if (out.length) out.at(-1)!.pauseMs = 0;
  return out;
}

/** The template's own clips (no values), for pre-rendering. */
export function staticPieces(template: string): string[] {
  const SENTINEL = "\u0001";
  const all: Vars = { amount: SENTINEL, next: SENTINEL, leader: SENTINEL, target: SENTINEL, start: SENTINEL, lot: SENTINEL, number: SENTINEL };
  return (linePieces(template, all) ?? []).filter((p) => !p.value).map((p) => p.text);
}
