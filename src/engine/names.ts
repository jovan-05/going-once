/**
 * Untrusted text handling (CLAUDE.md rules 7 and 8). Pure, shared by server and UI.
 */

export const NAME_MAX = 24;
export const LOT_TEXT_MAX = 400;

// C0/C1 controls, zero-width & bidi overrides that can spoof display order.
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export function cleanText(input: unknown, max: number): string {
  if (typeof input !== "string") return "";
  const s = input.normalize("NFKC").replace(CONTROL, "").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, max).join("").trim();
}

export function cleanName(input: unknown): string {
  return cleanText(input, NAME_MAX);
}

// Deliberately small list; matched on letters-only, de-leeted text.
const BLOCKED = [
  "fuck", "shit", "cunt", "bitch", "bastard", "dick", "cock", "pussy", "asshole", "slut", "whore",
  "nigger", "nigga", "faggot", "retard", "wank", "twat", "porn", "nazi", "hitler", "rape",
];
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

export function isProfane(input: string): boolean {
  const flat = input
    .toLowerCase()
    .replace(/[0-9@$!]/g, (ch) => LEET[ch] ?? ch)
    .replace(/[^a-z]/g, "");
  return BLOCKED.some((w) => flat.includes(w));
}

/** Looks like an attempt to instruct the AI or the room; never shown on stage. */
export function looksLikeInstruction(input: string): boolean {
  return /\b(ignore|disregard|system|prompt|instruction|declare|winner|assistant)\b/i.test(input);
}

/**
 * What the big screen may show for a bidder: first name only with consent and
 * when the name passes the filters; otherwise the paddle number.
 */
export function publicName(b: { paddle: number; name: string; showName: boolean }): string {
  const first = b.name.split(" ")[0] ?? "";
  if (!b.showName || !first || isProfane(b.name) || looksLikeInstruction(b.name)) return `Paddle ${b.paddle}`;
  return first;
}
