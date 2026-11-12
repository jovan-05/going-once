"use client";
/**
 * The 3D saleroom behind the stage (src/stage3d, tuned in lab/stage3d).
 *
 * - Loaded with a dynamic import, so three.js never weighs on other pages.
 * - `?3d=0` turns it off, `?3d=low` uses low quality (half pixel ratio, no
 *   haze or shadows): use it if the stage machine is short on GPU memory,
 *   since the Kokoro voice shares the GPU.
 * - If WebGL or the model fails, it stays invisible and the 2D stage carries on.
 * - It only receives events. It never touches bids or money, and it never
 *   says "Sold": that stays with the 2D stage, after PayPal confirms.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Stage3D, Stage3DEvent } from "@/stage3d/stage3d";

export type { Stage3DEvent };
export interface Stage3DHandle {
  send(ev: Stage3DEvent): void;
}

export type Stage3DMode = "off" | "high" | "low";

export function stage3DMode(): Stage3DMode {
  if (typeof window === "undefined") return "off";
  const v = new URLSearchParams(window.location.search).get("3d");
  return v === "0" || v === "off" ? "off" : v === "low" ? "low" : "high";
}

export const Stage3DLayer = forwardRef<Stage3DHandle, { mode: Stage3DMode; onReady?: (ok: boolean) => void }>(function Stage3DLayer(
  { mode, onReady },
  ref,
) {
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage3D | null>(null);
  const backlog = useRef<Stage3DEvent[]>([]);
  const [shown, setShown] = useState(false);
  const readyCb = useRef(onReady);
  readyCb.current = onReady;

  useImperativeHandle(ref, () => ({
    send(ev) {
      if (stage.current) stage.current.handle(ev);
      else backlog.current = [...backlog.current.slice(-39), ev];
    },
  }));

  useEffect(() => {
    const el = box.current;
    if (mode === "off" || !el) {
      readyCb.current?.(false);
      return;
    }
    let disposed = false;
    let ro: ResizeObserver | null = null;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    el.append(canvas);

    void import("@/stage3d/stage3d")
      .then(({ createStage3D }) => {
        if (disposed) return;
        // next/font renames families; hand the module the real one.
        const display = getComputedStyle(document.documentElement).getPropertyValue("--font-big-shoulders").trim();
        const s = createStage3D(canvas, {
          modelUrl: "/models/saleroom.glb",
          reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          quality: mode,
          fontFamily: display ? `${display}, "Arial Narrow", sans-serif` : undefined,
        });
        stage.current = s;
        const size = () => {
          const r = el.getBoundingClientRect();
          s.resize(r.width, r.height);
        };
        size();
        ro = new ResizeObserver(size);
        ro.observe(el);
        for (const ev of backlog.current) s.handle(ev);
        backlog.current = [];
        return s.ready.then(
          () => {
            if (disposed) return;
            setShown(true);
            readyCb.current?.(true);
          },
          (err: unknown) => {
            console.info(`[stage3d] off: ${err instanceof Error ? err.message : String(err)}`);
            if (!disposed) readyCb.current?.(false);
          },
        );
      })
      .catch(() => {
        if (!disposed) readyCb.current?.(false);
      });

    return () => {
      disposed = true;
      ro?.disconnect();
      stage.current?.dispose();
      stage.current = null;
      canvas.remove();
      setShown(false);
    };
  }, [mode]);

  if (mode === "off") return null;
  return (
    <div
      ref={box}
      aria-hidden
      className={`pointer-events-none absolute inset-0 -z-10 transition-opacity duration-700 ${shown ? "opacity-100" : "opacity-0"}`}
    />
  );
});
