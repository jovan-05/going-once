"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { EngineEvent } from "@/engine";
import { HoldToBid, type PaddleTone } from "@/ui/HoldToBid";
import { RollingPrice } from "@/ui/RollingPrice";
import { CAPTURE_COPY, REJECT_COPY, REVEAL_KEY, readLocal, tokenKey, usd, useRoom, type PaddleSnapshot } from "@/ui/useRoom";

const LIVE = new Set(["open", "going_once", "going_twice"]);

export default function PaddlePage() {
  const { room } = useParams<{ room: string }>();
  const reduce = useReducedMotion();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    setToken(readLocal(tokenKey(room)));
    try {
      if (sessionStorage.getItem(REVEAL_KEY(room))) {
        sessionStorage.removeItem(REVEAL_KEY(room));
        setReveal(true);
      }
    } catch {
      /* ignore */
    }
  }, [room]);

  const [message, setMessage] = useState<string | null>(null);

  // Clear a stale rejection message when the room moves on.
  const onEvents = useCallback((evs: EngineEvent[], _s: PaddleSnapshot | null) => {
    if (evs.some((e) => e.type === "bid_accepted" || e.type === "lot_opened" || e.type === "lot_advanced")) setMessage(null);
  }, []);
  const { state, connected, send } = useRoom(token === undefined ? undefined : room, "paddle", { token }, onEvents);

  const lot = state?.lot ?? null;
  const me = state?.me ?? null;
  const live = !!lot && LIVE.has(lot.status) && !state?.paused;
  const next = lot?.minNextCents ?? 0;
  const overHold = !!me && live && next > me.remainingCents;

  const bid = useCallback(async () => {
    if (!lot || !me) return;
    setMessage(null);
    const r = await send("bid", { lotId: lot.id, amountCents: next });
    if (r.ok) {
      navigator.vibrate?.(30);
    } else setMessage(REJECT_COPY[r.reason ?? ""] ?? "That bid didn't go through. Try again.");
  }, [lot, me, next, send]);

  if (token === undefined || !state) return <Shell>Connecting…</Shell>;

  if (!me) {
    const pending = state.join && state.join.status !== "active";
    return (
      <Shell>
        <p className="text-center text-lg text-parchment">{pending ? (state.join?.error ?? "Waiting for PayPal to confirm your hold…") : "You haven't joined this room yet."}</p>
        <Link href={`/join/${encodeURIComponent(room)}`} className="mt-6 inline-flex min-h-11 items-center rounded-full bg-brass px-6 font-display text-2xl font-bold text-velvet">
          {pending ? "Back to joining" : "Join the auction"}
        </Link>
      </Shell>
    );
  }

  // End of the night (M9): what you won, and what PayPal released.
  if (state.night) {
    const r = state.myRelease;
    const wonLots = state.lots.filter((l) => l.status === "sold" && l.winnerPaddle === me.paddle);
    const rest = Math.max(0, (r?.heldCents ?? me.holdCents) - me.wonCents);
    const released =
      r?.status === "VOIDED"
        ? `PayPal has released the rest of your hold (${usd(rest)}).`
        : r?.status === "CAPTURED"
          ? "Your whole hold went to the charity."
          : r?.status === "failed"
            ? "We couldn't release the rest of your hold yet. The organiser will sort it out."
            : r?.status === "simulated" || me.simulatedHold
              ? "This was a simulated hold, so no money moved."
              : "Releasing the rest of your hold at PayPal…";
    return (
      <main className="mx-auto flex min-h-dvh max-w-[430px] flex-col justify-center px-5 py-8 text-center" aria-live="polite">
        <p className="font-display text-lg font-bold text-smoke">{state.name}</p>
        <h1 className="mt-2 font-display text-6xl font-black text-brass">Thank you</h1>
        {wonLots.length ? (
          <>
            <p className="mt-6 text-lg">You won</p>
            <ul className="mt-2 space-y-1">
              {wonLots.map((l) => (
                <li key={l.id} className="font-serif text-xl text-parchment">
                  {l.title} <span className="font-display font-bold text-brass tabular">{usd(l.hammerCents)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-smoke">Paid from your hold: {usd(me.wonCents)}</p>
          </>
        ) : (
          <p className="mt-6 text-lg">You didn&apos;t win a lot tonight, so you weren&apos;t charged anything.</p>
        )}
        <p className="mt-6 text-lg text-parchment">{released}</p>
      </main>
    );
  }

  const iWon = lot?.status === "sold" && lot.high?.paddle === me.paddle;
  let tone: PaddleTone;
  if (iWon) tone = "high";
  else if (!live || overHold || !connected) tone = me.isHigh ? "high" : "disabled";
  else if (me.isHigh) tone = "high";
  else if (lot?.high) tone = "outbid";
  else tone = "ready";

  let status: { text: string; you?: boolean };
  if (!lot) status = { text: "No lots yet" };
  else if (state.paused) status = { text: "The auction is paused for a moment" };
  else if (iWon) status = { text: "You won this lot", you: true };
  else if (lot.status === "sold") status = { text: `Paddle ${lot.high?.paddle} won this lot` };
  else if (lot.status === "passed") status = { text: "This lot passed" };
  else if (lot.status === "waiting") status = { text: "Waiting for the lot to open" };
  else if (me.isHigh) status = { text: "You're the high bidder", you: true };
  else if (lot.high) status = { text: `Paddle ${lot.high.paddle} bid ${usd(lot.priceCents)} — bid again?` };
  else status = { text: `Opening at ${usd(lot.startCents)}` };

  const myCapture = iWon && lot ? state.captures?.[lot.id] : undefined;
  const holdPct = me.holdCents ? Math.max(0, Math.min(100, (me.remainingCents / me.holdCents) * 100)) : 0;
  const calling = lot?.status === "going_once" ? "Going once" : lot?.status === "going_twice" ? "Going twice" : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-[430px] flex-col px-4 pt-5 pb-6">
      <header className="flex items-baseline justify-between gap-3">
        <p className="truncate font-display text-lg font-bold text-smoke">{lot ? `Lot ${lot.number} · ${lot.title}` : state.name}</p>
        {!connected && <span className="shrink-0 text-sm text-smoke">Reconnecting…</span>}
      </header>

      <section className="mt-6 text-center">
        <p className="font-display text-[72px] font-black text-brass">
          <RollingPrice cents={lot?.priceCents ?? lot?.startCents ?? null} />
        </p>
        <p className={`mt-3 min-h-[1.6em] text-lg ${status.you ? "text-signal" : "text-smoke"}`} role="status">
          {status.text}
          {calling && !iWon && <span className="text-parchment"> · {calling}</span>}
        </p>
      </section>

      <section className="flex flex-1 flex-col items-center justify-center gap-5 py-4">
        <motion.div
          initial={reveal && !reduce ? { rotateY: 90, opacity: 0 } : false}
          animate={{ rotateY: 0, opacity: 1 }}
          transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
          style={{ perspective: 800 }}
          className={`rounded-full ${tone === "high" ? "shadow-[0_0_0_6px_var(--signal)]" : ""}`}
        >
          <HoldToBid
            paddle={me.paddle}
            tone={tone}
            actionLabel={iWon ? "Won" : tone === "high" ? "Top bid" : live ? "Hold to bid" : "Paddle"}
            ariaLabel={live && tone !== "disabled" && tone !== "high" ? `Press and hold to bid ${usd(next)}` : `Paddle ${me.paddle}`}
            onBid={bid}
          />
        </motion.div>
        <p className="min-h-[1.2em] font-display text-3xl font-bold text-parchment tabular">
          {live && !me.isHigh && !overHold ? `Bid ${usd(next)}` : ""}
        </p>
        {myCapture ? (
          <div className="min-h-[3em] text-center" role="status" aria-live="polite">
            <p className={myCapture.status === "captured" ? "text-parchment" : "text-smoke"}>
              {myCapture.status === "captured"
                ? `PayPal took ${usd(myCapture.amountCents)} from your hold`
                : myCapture.status === "capturing"
                  ? `Taking ${usd(myCapture.amountCents)} from your hold…`
                  : CAPTURE_COPY[myCapture.status]}
            </p>
            {myCapture.captureId && <p className="mt-1 font-mono text-xs text-smoke">Capture {myCapture.captureId}</p>}
          </div>
        ) : (
          <p className="min-h-[3em] max-w-[32ch] text-center text-base text-smoke">
            {overHold ? `This is above your remaining hold of ${usd(me.remainingCents)}` : message}
          </p>
        )}
      </section>

      <footer>
        <div className="flex items-baseline justify-between">
          <span className="text-smoke">
            Your hold{me.simulatedHold && " · simulated"}
          </span>
          <span className="font-display text-xl font-bold text-parchment tabular">{usd(me.remainingCents)} left</span>
        </div>
        <div
          className="mt-2 h-3 overflow-hidden rounded-full bg-curtain"
          role="meter"
          aria-label="Remaining hold"
          aria-valuenow={me.remainingCents / 100}
          aria-valuemin={0}
          aria-valuemax={me.holdCents / 100}
        >
          <div className="h-full rounded-full bg-brass transition-[width] duration-700" style={{ width: `${holdPct}%` }} />
        </div>
        {me.wonCents > 0 && <p className="mt-2 text-sm text-smoke">Won so far: {usd(me.wonCents)} of your {usd(me.holdCents)} hold</p>}
      </footer>
    </main>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex min-h-dvh max-w-[430px] flex-col items-center justify-center px-4 font-serif text-smoke">{children}</main>;
}
