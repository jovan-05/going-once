"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Scaled } from "@/ui/Scaled";
import { clerkKeyKey, readLocal, useRoom } from "@/ui/useRoom";

/**
 * Judge view (DEMO.md): the big screen and a phone side by side, so one
 * person on a laptop can play both roles. Both are the real pages in frames.
 */
export default function JudgeView() {
  const { room } = useParams<{ room: string }>();
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => setKey(readLocal(clerkKeyKey(room))), [room]);
  const { state, send } = useRoom(key ? room : undefined, "clerk", { key });

  const [buyer, setBuyer] = useState<{ email: string; password: string } | null>(null);
  useEffect(() => {
    fetch("/api/demo/info")
      .then((r) => r.json())
      .then((j: { buyer?: { email: string; password: string } | null }) => setBuyer(j.buyer ?? null))
      .catch(() => undefined);
  }, []);

  const [qr, setQr] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState("");
  useEffect(() => {
    const url = `${window.location.origin}/join/${encodeURIComponent(room)}`;
    setJoinUrl(url);
    QRCode.toDataURL(url, { margin: 1, width: 240, color: { dark: "#2B0A1D", light: "#F6EDDC" } }).then(setQr, () => setQr(null));
  }, [room]);

  const lot = state?.lots?.[state.currentLotIndex];
  const status = state?.night ? "Night closed · holds released" : lot ? `Lot ${lot.number} of ${state!.lots.length} · ${STATUS[lot.status] ?? lot.status}${state!.paused ? " · paused" : ""}` : "Connecting…";
  const enc = encodeURIComponent(room);

  return (
    <main className="flex min-h-dvh flex-col gap-4 p-4 lg:h-dvh lg:p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 className="font-display text-3xl font-black text-brass">
          Going Once <span className="font-bold text-smoke">· judge view</span>
        </h1>
        <p className="font-serif text-lg text-smoke" role="status">
          {status}
        </p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 lg:flex-row">
        {/* The big screen */}
        <section className="flex min-w-0 flex-1 flex-col gap-3">
          <Scaled w={1920} h={1080} title="Stage: the projector screen" src={`/stage/${enc}`} className="rounded-xl ring-1 ring-curtain" />
          <div className="flex flex-wrap items-center gap-3">
            {lot?.status === "waiting" && state?.currentLotIndex === 0 ? (
              <Btn primary onClick={() => send("clerk:open")}>
                Start bidding now
              </Btn>
            ) : null}
            {state?.paused ? <Btn onClick={() => send("clerk:resume")}>Resume</Btn> : <Btn onClick={() => send("clerk:pause")}>Pause</Btn>}
            {(lot?.status === "sold" || lot?.status === "passed") && <Btn onClick={() => send("clerk:next")}>Next lot</Btn>}
            {lot?.status === "waiting" && (state?.currentLotIndex ?? 0) > 0 && <Btn onClick={() => send("clerk:open")}>Open this lot</Btn>}
            {state && !state.night && lot && (lot.status === "sold" || lot.status === "passed") && (
              <Btn onClick={() => send("clerk:close-night")}>End the night</Btn>
            )}
            <span className="font-serif text-base text-smoke">Click the stage once to turn on the auctioneer&apos;s voice.</span>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 font-serif text-base">
            <Link className="underline decoration-smoke underline-offset-4" href={`/stage/${enc}`} target="_blank">
              Stage in its own tab
            </Link>
            <Link className="underline decoration-smoke underline-offset-4" href={`/clerk/${enc}`} target="_blank">
              Clerk console
            </Link>
            <Link className="underline decoration-smoke underline-offset-4" href="/demo">
              New demo room
            </Link>
          </div>
        </section>

        {/* The phone, plus how to join */}
        <aside className="flex shrink-0 flex-col items-center gap-4 lg:w-[min(30vw,440px)]">
          <div className="w-full max-w-[400px] flex-1 lg:min-h-0">
            <Scaled w={390} h={844} title="Phone: your paddle" src={`/join/${enc}`} className="rounded-[2rem] ring-8 ring-curtain" fit="contain" />
          </div>
          <div className="w-full max-w-[400px] rounded-xl bg-curtain p-4 font-serif text-base leading-snug">
            {buyer ? (
              <>
                <p className="text-smoke">PayPal sandbox buyer (test money only):</p>
                <p className="mt-1 font-mono text-sm break-all text-parchment">{buyer.email}</p>
                <p className="font-mono text-sm break-all text-parchment">{buyer.password}</p>
              </>
            ) : (
              <p className="text-smoke">Approve the hold with any PayPal sandbox personal account (see the README).</p>
            )}
            <div className="mt-3 flex items-center gap-3">
              {qr && <img src={qr} alt={`QR code to join at ${joinUrl}`} className="size-20 rounded" />}
              <p className="text-smoke">Or join from your own phone: scan this, and keep this tab as the big screen.</p>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

const STATUS: Record<string, string> = {
  waiting: "opens when you join",
  open: "bidding",
  going_once: "going once",
  going_twice: "going twice",
  sold: "sold",
  passed: "passed",
};

function Btn({ children, onClick, primary }: { children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-11 rounded-full px-5 font-display text-xl font-bold ${primary ? "bg-brass text-velvet" : "border-2 border-parchment text-parchment"}`}
    >
      {children}
    </button>
  );
}
