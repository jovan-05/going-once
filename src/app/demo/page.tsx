"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { clerkKeyKey, writeLocal } from "@/ui/useRoom";

/** One click to a fresh demo room with five labelled bots (DEMO.md). */
export default function DemoPage() {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "room" | "online">(null);
  const [error, setError] = useState<string | null>(null);

  async function start(mode: "room" | "online") {
    setBusy(mode);
    setError(null);
    try {
      const r = await fetch("/api/demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
      const j = (await r.json()) as { ok: boolean; id?: string; clerkToken?: string; message?: string };
      if (!j.ok || !j.id || !j.clerkToken) throw new Error(j.message ?? "Couldn't start a demo room. Try again.");
      writeLocal(clerkKeyKey(j.id), j.clerkToken);
      // In the room: the judge view (stage + phone). Online: you are the guest at home.
      router.push(mode === "online" ? `/join/${encodeURIComponent(j.id)}` : `/demo/${encodeURIComponent(j.id)}`);
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-6 py-12">
      <p className="font-display text-xl font-bold text-smoke">Going Once · demo</p>
      <h1 className="mt-2 font-display text-6xl leading-none font-black text-brass sm:text-7xl">Run your own auction night</h1>
      <p className="mt-6 max-w-[60ch] font-serif text-xl leading-relaxed">
        A fresh room for Riverside Reading Rooms, a made-up library charity: six lots, an AI auctioneer, and five bidders who are bots. They&apos;re
        marked <Bot /> on every screen and bid with simulated holds.
      </p>
      <p className="mt-4 max-w-[60ch] font-serif text-xl leading-relaxed">
        You bid as yourself, with a real PayPal sandbox hold. Win a lot and PayPal captures exactly the hammer price. The capture ID shows on the
        big screen.
      </p>
      <ol className="mt-8 space-y-2 font-serif text-lg text-smoke">
        <li>1. Join in the phone on the right of the next screen, or scan its QR code with your own phone.</li>
        <li>2. Approve the hold with the sandbox buyer login shown there.</li>
        <li>3. Lot 1 opens a few seconds later. Hold your paddle to bid.</li>
      </ol>
      <div className="mt-10 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => start("room")}
          disabled={busy !== null}
          className="min-h-14 rounded-full bg-brass px-8 font-display text-2xl font-black text-velvet disabled:opacity-60"
        >
          {busy === "room" ? "Setting the room…" : "Start a demo room"}
        </button>
        <button
          type="button"
          onClick={() => start("online")}
          disabled={busy !== null}
          className="min-h-14 rounded-full border-2 border-brass px-8 font-display text-2xl font-black text-brass disabled:opacity-60"
        >
          {busy === "online" ? "Opening the auction…" : "Join an online auction"}
        </button>
      </div>
      <p className="mt-4 max-w-[60ch] font-serif text-base text-smoke">
        <b className="text-parchment">Demo room:</b> the big screen and a phone side by side, as at a gala. <b className="text-parchment">Online auction:</b> you bid from home, watching and hearing the live stage on the same screen. About 3 minutes either way; sound on for the auctioneer.
      </p>
      {error && (
        <p role="alert" className="mt-4 text-parchment">
          {error}
        </p>
      )}
    </main>
  );
}

function Bot() {
  return <span className="inline-block rounded bg-smoke px-1.5 align-middle font-display text-base leading-tight font-bold text-velvet">BOT</span>;
}
