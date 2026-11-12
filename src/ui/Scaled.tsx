"use client";

import { useEffect, useRef, useState } from "react";

/** A real page rendered at its native size (so vw-based layouts look right) and scaled to fit. */
export function Scaled({ w, h, src, title, className = "", fit = "width" }: { w: number; h: number; src: string; title: string; className?: string; fit?: "width" | "contain" }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const byW = r.width / w;
      setScale(fit === "contain" && r.height > 0 ? Math.min(byW, r.height / h) : byW);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h, fit]);
  return (
    <div ref={box} className={fit === "contain" ? "flex h-full min-h-[480px] w-full justify-center lg:min-h-0" : "w-full"} style={fit === "width" ? { aspectRatio: `${w} / ${h}` } : undefined}>
      <div className={`overflow-hidden ${className}`} style={{ width: w * scale, height: h * scale }}>
        {scale > 0 && (
          <iframe
            src={src}
            title={title}
            allow="autoplay"
            style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: "0 0", border: 0, display: "block" }}
          />
        )}
      </div>
    </div>
  );
}
