"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Scaled } from "@/ui/Scaled";

/**
 * Online mode: a bidder at home sees and hears the live stage and bids on the
 * same screen. Laptop: the stage beside the paddle. Phone: the stage on top,
 * the paddle below. Both are the real pages, so they stay in sync through the
 * same socket room as everyone else (in the hall or at home).
 */
export default function LivePage() {
  const { room } = useParams<{ room: string }>();
  const enc = encodeURIComponent(room);
  const [name, setName] = useState("");
  const [tapped, setTapped] = useState(false);
  useEffect(() => {
    fetch(`/api/rooms/${enc}`)
      .then((r) => r.json())
      .then((j: { name?: string }) => setName(j.name ?? ""))
      .catch(() => undefined);
  }, [enc]);
  // A tap inside the stage frame moves focus into it: that's when its sound unlocks.
  useEffect(() => {
    const onBlur = () => setTimeout(() => document.activeElement?.tagName === "IFRAME" && setTapped(true), 0);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  return (
    <main className="flex min-h-dvh flex-col gap-3 p-3 lg:h-dvh lg:p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h1 className="font-display text-2xl font-black text-brass lg:text-3xl">
          Going Once <span className="font-bold text-smoke">· live from home</span>
        </h1>
        <p className="font-serif text-sm text-smoke lg:text-base">{name}</p>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row lg:gap-5">
        <section className="relative min-w-0 lg:flex-1 lg:self-start" aria-label="The live auction">
          <Scaled w={1920} h={1080} title="The live auction stage" src={`/stage/${enc}`} className="rounded-xl ring-1 ring-curtain" />
          {!tapped && (
            <p className="pointer-events-none absolute inset-x-0 bottom-2 mx-auto w-fit rounded-full bg-velvet/85 px-4 py-2 font-serif text-sm text-parchment ring-1 ring-brass/50">
              Tap the stage once to hear the auctioneer
            </p>
          )}
        </section>
        <aside className="h-[620px] shrink-0 lg:h-auto lg:w-[min(32vw,420px)]" aria-label="Your paddle">
          <iframe src={`/paddle/${enc}`} title="Your paddle" className="h-full w-full rounded-2xl ring-4 ring-curtain" />
        </aside>
      </div>
    </main>
  );
}
