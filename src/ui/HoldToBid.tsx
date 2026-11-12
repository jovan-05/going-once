"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const HOLD_MS = 400;
const R = 46; // ring radius in a 100×100 viewBox
const C = 2 * Math.PI * R;

export type PaddleTone = "ready" | "high" | "outbid" | "disabled";

/**
 * The paddle: a big circle with your number. Press and hold for 400ms to bid
 * (a ring fills as you hold) — prevents accidental bids. Works with touch,
 * mouse, and keyboard (hold Space or Enter).
 */
export function HoldToBid({
  paddle,
  tone,
  actionLabel,
  ariaLabel,
  onBid,
}: {
  paddle: number;
  tone: PaddleTone;
  actionLabel: string;
  ariaLabel: string;
  onBid: () => void;
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabled = tone === "ready" || tone === "outbid";

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  }, []);

  const start = useCallback(() => {
    if (!enabled || timer.current) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      onBid();
    }, HOLD_MS);
  }, [enabled, onBid]);

  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);
  useEffect(() => cancel, [cancel]);

  const ring = "var(--brass)";
  const track = tone === "high" ? "var(--brass)" : "var(--curtain)";

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-disabled={!enabled}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") cancel();
      }}
      onContextMenu={(e) => e.preventDefault()}
      className={`relative size-[min(72vw,300px)] touch-none rounded-full select-none [-webkit-touch-callout:none] ${
        enabled ? "cursor-pointer" : "cursor-not-allowed"
      } transition-opacity duration-300 ${tone === "outbid" ? "opacity-70" : tone === "disabled" ? "opacity-40" : "opacity-100"}`}
    >
      <svg viewBox="0 0 100 100" className="absolute inset-0 size-full -rotate-90" aria-hidden>
        <circle cx="50" cy="50" r={R + 2} fill="var(--curtain)" />
        <circle cx="50" cy="50" r={R} fill="none" stroke={track} strokeWidth="4" />
        <circle
          cx="50"
          cy="50"
          r={R}
          fill="none"
          stroke={ring}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={holding ? 0 : C}
          style={{ transition: holding ? `stroke-dashoffset ${HOLD_MS}ms linear` : "stroke-dashoffset 150ms ease-out" }}
        />
      </svg>
      <span className="relative flex flex-col items-center justify-center">
        <span className={`font-display text-[120px] leading-none font-black tabular ${tone === "outbid" ? "text-smoke" : "text-parchment"}`}>{paddle}</span>
        <span className={`mt-1 font-display text-2xl font-bold ${tone === "high" ? "text-brass" : "text-parchment"}`}>{actionLabel}</span>
      </span>
    </button>
  );
}
