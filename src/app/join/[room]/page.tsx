"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { REVEAL_KEY, readLocal, tokenKey, usd, writeLocal } from "@/ui/useRoom";

const PRESETS = [100_00, 250_00, 500_00];

export default function JoinPage() {
  return (
    <Suspense>
      <Join />
    </Suspense>
  );
}

function Join() {
  const { room } = useParams<{ room: string }>();
  const search = useSearchParams();
  const cancelled = search.get("cancelled") === "1";

  const [roomName, setRoomName] = useState<string | null>(null);
  const [roomMissing, setRoomMissing] = useState(false);
  const [mode, setMode] = useState<"room" | "online">("room");
  const [existing, setExisting] = useState<{ status: string; paddle: number | null } | null>(null);
  const [name, setName] = useState("");
  const [showName, setShowName] = useState(true);
  const [preset, setPreset] = useState<number | "custom">(250_00);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(cancelled ? "You cancelled the PayPal hold, so nothing was held. Try again or choose a lower limit." : null);
  // Inside the judge view (an iframe), PayPal can't be framed: approval opens in a popup and this page waits.
  const router = useRouter();
  const [waiting, setWaiting] = useState<Window | null>(null);
  useEffect(() => {
    if (!waiting) return;
    const token = readLocal(tokenKey(room));
    let stop = false;
    const check = async () => {
      try {
        const r = await fetch(`/api/rooms/${encodeURIComponent(room)}/hold`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, reconcile: true }),
        });
        const j = (await r.json()) as { ok: boolean; status?: string; error?: string | null };
        if (stop) return;
        if (j.ok && j.status === "active") {
          try {
            sessionStorage.setItem(REVEAL_KEY(room), "1");
          } catch {
            /* ignore */
          }
          router.replace(`/${mode === "online" ? "live" : "paddle"}/${encodeURIComponent(room)}`);
          return;
        }
        if (!j.ok || j.status === "failed" || j.status === "cancelled") {
          setWaiting(null);
          setBusy(false);
          setError(j.error ?? "PayPal didn't approve the hold. Try again or choose a lower limit.");
          return;
        }
      } catch {
        /* keep trying */
      }
      if (!stop) setTimeout(check, 2_500);
    };
    const first = setTimeout(check, 2_500);
    return () => {
      stop = true;
      clearTimeout(first);
    };
  }, [waiting, room, router, mode]);

  useEffect(() => {
    fetch(`/api/rooms/${encodeURIComponent(room)}`)
      .then((r) => r.json())
      .then((j: { ok: boolean; name?: string; mode?: string }) => {
        if (!j.ok) return setRoomMissing(true);
        setRoomName(j.name ?? room);
        setMode(j.mode === "online" ? "online" : "room");
      })
      .catch(() => setError("Can't reach the auction. Check your connection."));
    const token = readLocal(tokenKey(room));
    if (token && !cancelled) {
      fetch(`/api/rooms/${encodeURIComponent(room)}/hold`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
        .then((r) => r.json())
        .then((j: { ok: boolean; status?: string; paddle?: number | null }) => j.ok && j.status && setExisting({ status: j.status, paddle: j.paddle ?? null }))
        .catch(() => undefined);
    }
  }, [room, cancelled]);

  const limitCents = preset === "custom" ? Math.round(Number(custom) * 100) : preset;
  const limitValid = Number.isSafeInteger(limitCents) && limitCents >= 10_00 && limitCents <= 2_000_00;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Add your first name so the auctioneer knows who's bidding.");
    if (!limitValid) return setError("Choose a spending limit between $10 and $2,000.");
    setBusy(true);
    setError(null);
    // Open the popup now, while we still have the click (popup blockers).
    const framed = window.top !== window.self;
    const popup = framed ? window.open("", "going-once-paypal", "popup,width=500,height=780") : null;
    try {
      const r = await fetch(`/api/rooms/${encodeURIComponent(room)}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, showName, limitCents }),
      });
      const j = (await r.json()) as { ok: boolean; token?: string; approveUrl?: string; message?: string };
      if (!j.ok || !j.token || !j.approveUrl) throw new Error(j.message ?? "PayPal couldn't start the hold. Try again in a moment.");
      writeLocal(tokenKey(room), j.token); // before leaving for PayPal, so the return page can find us
      if (popup) {
        popup.location.href = j.approveUrl;
        setWaiting(popup);
      } else if (framed) {
        window.top!.location.assign(j.approveUrl); // popup blocked: leave the judge view for PayPal
      } else {
        window.location.assign(j.approveUrl);
      }
    } catch (err) {
      popup?.close();
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (waiting)
    return (
      <Shell>
        <p className="text-lg" role="status">Approve the hold in the PayPal window.</p>
        <p className="mt-2 text-base text-smoke">This screen moves on by itself once PayPal confirms it.</p>
        <div className="mt-6 flex gap-3">
          <button type="button" onClick={() => (waiting.closed ? undefined : waiting.focus())} className="min-h-11 rounded-full border-2 border-parchment px-5 font-display text-xl font-bold">
            Show PayPal
          </button>
          <button
            type="button"
            onClick={() => {
              if (!waiting.closed) waiting.close();
              setWaiting(null);
              setBusy(false);
            }}
            className="min-h-11 rounded-full px-5 font-display text-xl font-bold text-smoke"
          >
            Cancel
          </button>
        </div>
      </Shell>
    );

  if (roomMissing) return <Shell><p className="text-lg">This auction room doesn't exist. Check the QR code on the big screen.</p></Shell>;

  if (existing?.status === "active")
    return (
      <Shell>
        <p className="text-lg">You're in, with paddle {existing.paddle}.</p>
        <Link href={`/${mode === "online" ? "live" : "paddle"}/${encodeURIComponent(room)}`} className="mt-6 inline-flex min-h-11 items-center justify-center rounded-full bg-brass px-6 font-display text-2xl font-bold text-velvet">
          Open my paddle
        </Link>
      </Shell>
    );

  return (
    <main className="mx-auto min-h-dvh max-w-[430px] px-4 py-8">
      <p className="text-smoke">{roomName ?? " "}</p>
      <h1 className="mt-1 font-display text-5xl font-black text-parchment">Join the auction</h1>

      <form onSubmit={submit} className="mt-8 space-y-8" noValidate>
        <fieldset className="space-y-3">
          <label htmlFor="name" className="block text-lg">Your first name</label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
            autoComplete="given-name"
            className="min-h-11 w-full rounded-lg bg-curtain px-4 text-lg text-parchment placeholder:text-smoke"
            placeholder="Asha"
          />
          <label className="flex min-h-11 items-center gap-3 text-base">
            <input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} className="size-6 accent-[var(--brass)]" />
            Show my first name on the big screen
          </label>
          {!showName && <p className="text-sm text-smoke">The room will see your paddle number only.</p>}
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-lg">Your spending limit</legend>
          <div className="grid grid-cols-4 gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPreset(p)}
                aria-pressed={preset === p}
                className={`min-h-11 rounded-lg font-display text-xl font-bold tabular ${preset === p ? "bg-parchment text-velvet" : "bg-curtain text-parchment"}`}
              >
                {usd(p)}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPreset("custom")}
              aria-pressed={preset === "custom"}
              className={`min-h-11 rounded-lg font-display text-xl font-bold ${preset === "custom" ? "bg-parchment text-velvet" : "bg-curtain text-parchment"}`}
            >
              Other
            </button>
          </div>
          {preset === "custom" && (
            <input
              inputMode="decimal"
              aria-label="Custom limit in dollars"
              value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ""))}
              className="min-h-11 w-full rounded-lg bg-curtain px-4 text-lg text-parchment placeholder:text-smoke"
              placeholder="Amount in dollars, $10 to $2,000"
            />
          )}
          <p className="text-base text-smoke">
            PayPal holds this amount. You're only charged for what you win; the rest is released when the auction ends.
          </p>
        </fieldset>

        {error && <p role="alert" className="text-parchment">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="min-h-14 w-full rounded-full bg-brass font-display text-2xl font-black text-velvet disabled:opacity-60"
        >
          {busy ? "Opening PayPal…" : `Approve hold${limitValid ? ` of ${usd(limitCents)}` : ""}`}
        </button>
      </form>
    </main>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex min-h-dvh max-w-[430px] flex-col items-center justify-center px-4 text-center">{children}</main>;
}
