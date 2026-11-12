"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AskClerk, LotWriter } from "@/ui/ClerkAssistant";
import { LedgerGrid, ledgerRows } from "@/ui/LedgerGrid";
import { STATUS_LABEL, clerkKeyKey, readLocal, usd, useRoom, writeLocal, type Ack } from "@/ui/useRoom";


const REASONS: Record<string, string> = {
  lot_live: "a lot is still being bid on. Close it first.",
  captures_in_flight: "a capture is still in progress at PayPal. Try again in a few seconds.",
  night_closed: "the night is over.",
  timeout: "no answer from the server. Check the connection.",
};

export default function ClerkPage() {
  return (
    <Suspense>
      <Clerk />
    </Suspense>
  );
}

function Clerk() {
  const { room } = useParams<{ room: string }>();
  const search = useSearchParams();
  const [key, setKey] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const fromUrl = search.get("key");
    if (fromUrl) writeLocal(clerkKeyKey(room), fromUrl);
    setKey(fromUrl ?? readLocal(clerkKeyKey(room)));
  }, [room, search]);

  const { state, connected, error, send } = useRoom(key ? room : undefined, "clerk", { key });
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const act = async (event: string, label: string) => {
    setMsg(null);
    const r: Ack = await send(event);
    if (!r.ok) setMsg(`${label}: ${REASONS[r.reason ?? ""] ?? r.reason}`);
  };

  if (key === null || error === "clerk_key_required")
    return <Ledger><p className="p-8">Open this page with the clerk link printed when the room was created (it ends in <code>?key=…</code>).</p></Ledger>;
  if (!state) return <Ledger><p className="p-8">{error ?? "Connecting…"}</p></Ledger>;

  const lot = state.lot;
  const status = lot?.status ?? "waiting";
  const releasedIds = new Set(state.releases.filter((r) => r.status !== "voiding" && r.status !== "failed").map((r) => r.bidder_id));
  const holdsActive = state.payments.filter((p) => p.status === "active" && !releasedIds.has(p.id));
  const heldCents = holdsActive.reduce((s, p) => s + (p.authorized_cents ?? 0), 0);
  const real = state.captureRows.filter((c) => !c.simulated);
  const capturedCents = real.filter((c) => c.status === "COMPLETED").reduce((s, c) => s + c.amount_cents, 0);
  const releasedCents = state.releases.filter((r) => r.status === "VOIDED").reduce((s, r) => s + Math.max(0, r.held_cents - r.won_cents), 0);
  const live = ["open", "going_once", "going_twice"].includes(status);
  const pendingCents = real.filter((c) => c.status === "capturing" || c.status === "PENDING").reduce((s, c) => s + c.amount_cents, 0);

  return (
    <Ledger>
      <header className="flex flex-wrap items-baseline justify-between gap-4 border-b border-velvet/20 px-6 py-4">
        <h1 className="font-serif text-2xl font-semibold">{state.name}</h1>
        <p className="text-sm text-velvet/70">
          {connected ? "Live" : "Reconnecting…"} · v{state.version} · log {state.logLength} · head {state.headHash?.slice(0, 10)}
        </p>
      </header>

      <section className="grid grid-cols-2 gap-px bg-velvet/10 sm:grid-cols-4" aria-label="Summary">
        <Stat label="Raised so far" value={usd(state.totalRaisedCents)} />
        <Stat label="Holds active" value={`${holdsActive.length} · ${usd(heldCents)}`} />
        <Stat label="Captured" value={usd(capturedCents)} hint={pendingCents ? `${usd(pendingCents)} pending` : undefined} />
        <Stat
          label="Released"
          value={state.night ? `${usd(releasedCents)}` : "—"}
          hint={state.night ? `${state.night.released} holds${state.night.releasing ? `, ${state.night.releasing} releasing` : ""}${state.night.attention ? `, ${state.night.attention} need attention` : ""}` : "at the end of the night"}
        />
      </section>

      <section className="flex flex-wrap items-center gap-3 px-6 py-5">
        <div className="mr-auto">
          <p className="text-sm text-velvet/70">Lot {lot?.number} of {state.lotCount}</p>
          <p className="font-serif text-xl font-semibold">{lot?.title}</p>
          <p className="text-sm">
            {STATUS_LABEL[status]}
            {state.paused && " · paused"} · high {lot?.high ? `paddle ${lot.high.paddle} at ${usd(lot.priceCents)}` : "none"} · {lot?.bidCount ?? 0} bids
          </p>
        </div>
        {!state.night && (
          <>
        <Btn primary onClick={() => act("clerk:open", "Open lot")} disabled={status !== "waiting"}>Open lot</Btn>
        <Btn onClick={() => act("clerk:close", "Close lot")} disabled={!["open", "going_once", "going_twice"].includes(status)}>Close lot</Btn>
        {state.paused ? (
          <Btn onClick={() => act("clerk:resume", "Resume")}>Resume</Btn>
        ) : (
          <Btn onClick={() => act("clerk:pause", "Pause")}>Pause</Btn>
        )}
        <Btn onClick={() => act("clerk:next", "Next lot")} disabled={status !== "sold" && status !== "passed"}>Next lot</Btn>
          </>
        )}
        {state.night ? (
          <span className="font-serif text-base font-semibold">Night closed</span>
        ) : confirmEnd ? (
          <>
            <Btn primary onClick={() => { setConfirmEnd(false); void act("clerk:close-night", "End the night"); }}>Release all holds</Btn>
            <Btn onClick={() => setConfirmEnd(false)}>Keep going</Btn>
          </>
        ) : (
          <Btn onClick={() => setConfirmEnd(true)} disabled={live} title="Ends the auction and releases every unused hold at PayPal">End the night</Btn>
        )}
      </section>
      {msg && <p className="px-6 pb-3 text-sm" role="alert">{msg}</p>}

      <section className="grid gap-4 px-6 pb-6 lg:grid-cols-2" aria-label="AI tools">
        <AskClerk send={send} disabled={!connected} />
        <LotWriter send={send} disabled={!connected || !!state.night} />
      </section>

      <section className="px-6 pb-8">
        <h2 className="mb-2 font-serif text-lg font-semibold">Ledger</h2>
        <LedgerGrid rows={ledgerRows(state)} />
      </section>
    </Ledger>
  );
}



function Ledger({ children }: { children: React.ReactNode }) {
  return <main className="min-h-dvh bg-parchment font-serif text-velvet">{children}</main>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-parchment px-6 py-3">
      <p className="text-sm text-velvet/70">{label}{hint && <span className="text-velvet/40"> · {hint}</span>}</p>
      <p className="font-display text-3xl font-bold tabular">{value}</p>
    </div>
  );
}

function Btn({ children, primary, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={`min-h-11 rounded-full px-5 font-display text-lg font-bold disabled:opacity-40 ${
        primary ? "bg-brass text-velvet" : "border-2 border-velvet text-velvet"
      }`}
    >
      {children}
    </button>
  );
}
