"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";

/**
 * The auctioneer's current line, revealed word by word (M7 will pace this to
 * the voice). Reduced motion shows the whole line at once.
 */
export function Caption({ line, id, msPerWord = 140, className = "" }: { line: string; id: number; msPerWord?: number; className?: string }) {
  const reduce = useReducedMotion();
  const words = line.split(" ").filter(Boolean);
  const [shown, setShown] = useState(reduce ? words.length : 0);

  useEffect(() => {
    if (reduce) {
      setShown(words.length);
      return;
    }
    setShown(1);
    const t = setInterval(() => setShown((n) => (n >= words.length ? n : n + 1)), msPerWord);
    return () => clearInterval(t);
    // re-run for each new line
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reduce]);

  return (
    <p className={className} aria-live="polite" aria-atomic>
      <span className="sr-only">{line}</span>
      <span aria-hidden>
        {words.map((w, i) => (
          <span key={i} className={`transition-opacity duration-200 ${i < shown ? "opacity-100" : "opacity-0"}`}>
            {w}
            {i < words.length - 1 ? " " : ""}
          </span>
        ))}
      </span>
    </p>
  );
}
