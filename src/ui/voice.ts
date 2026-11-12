"use client";
/**
 * The auctioneer's voice: the browser's own speech synthesis (AUCTIONEER.md
 * fallback, used as the primary voice for now: no API key, no network delay,
 * and every amount is spoken instantly).
 *
 * Keeping pace with rapid bids: a new line interrupts the one being spoken,
 * so the voice is never behind the room. Captions always show the same text.
 */

type Tone = "warm" | "playful" | "urgent" | "grateful";

let muted = false;
let chosen: SpeechSynthesisVoice | null = null;

const synth = () => (typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null);

/** Prefer a natural-sounding English voice when the browser has one. */
function pickVoice(): SpeechSynthesisVoice | null {
  const s = synth();
  if (!s) return null;
  if (chosen) return chosen;
  const voices = s.getVoices().filter((v) => /^en(-|_|$)/i.test(v.lang));
  const score = (v: SpeechSynthesisVoice) =>
    (/natural|neural|online/i.test(v.name) ? 8 : 0) +
    (/en-GB/i.test(v.lang) ? 3 : /en-US/i.test(v.lang) ? 2 : 0) +
    (/ryan|guy|daniel|george|arthur|male/i.test(v.name) ? 2 : 0) +
    (/google/i.test(v.name) ? 1 : 0) +
    (v.localService ? 0 : 1);
  chosen = voices.sort((a, b) => score(b) - score(a))[0] ?? null;
  return chosen;
}

if (typeof window !== "undefined" && "speechSynthesis" in window) {
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    chosen = null;
    pickVoice();
  });
}

const RATE: Record<Tone, number> = { warm: 1.0, playful: 1.06, urgent: 1.12, grateful: 0.96 };

export function voiceSupported() {
  return !!synth();
}

/** Call from a user gesture so browsers that gate speech will allow it later. */
export function unlockVoice() {
  const s = synth();
  if (!s) return;
  const u = new SpeechSynthesisUtterance("");
  u.volume = 0;
  s.speak(u);
}

export function setVoiceMuted(m: boolean) {
  muted = m;
  if (m) synth()?.cancel();
}

export function speak(text: string, tone: Tone = "warm") {
  const s = synth();
  if (!s || muted || !text) return;
  s.cancel(); // never fall behind: the newest line wins
  const u = new SpeechSynthesisUtterance(text.replace(/…/g, "..."));
  const v = pickVoice();
  if (v) {
    u.voice = v;
    u.lang = v.lang;
  } else u.lang = "en-GB";
  u.rate = RATE[tone];
  u.pitch = 0.95;
  s.speak(u);
}
