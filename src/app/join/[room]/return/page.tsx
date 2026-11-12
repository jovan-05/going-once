"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { REVEAL_KEY, readLocal, tokenKey, usd } from "@/ui/useRoom";

interface HoldStatus {
  ok: boolean;
  status?: string;
  paddle?: number | null;
  holdCents?: number | null;
  error?: string | null;
  message?: string;
}

/**
 * PayPal sends the buyer here after approval. This page never decides that
 * money moved: it asks the server to re-read the order from PayPal and waits
 * until the server reports a real authorization.
 */
export default function ReturnPage() {
  const { room } = useParams<{ room: string }>();
  const router = useRouter();
  const [s, setS] = useState<HoldStatus | null>(null);

  useEffect(() => {
    const token = readLocal(tokenKey(room));
    if (!token) {
      setS({ ok: false, message: "We couldn't find your place in this room on this phone. Join again." });
      return;
    }
    let stop = false;
    let tries = 0;
    const check = async () => {
      try {
        const r = await fetch(`/api/rooms/${encodeURIComponent(room)}/hold`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, reconcile: true }),
        });
        const j = (await r.json()) as HoldStatus;
        if (stop) return;
        setS(j);
        if (j.ok && j.status === "active") {
          try {
            sessionStorage.setItem(REVEAL_KEY(room), "1");
          } catch {
            /* ignore */
          }
          // Opened as a popup from the judge view: that view moves on by itself, so just close.
          const opener = (() => {
            try {
              return window.opener && window.opener.location.origin === window.location.origin ? window.opener : null;
            } catch {
              return null;
            }
          })();
          if (opener && window.name === "going-once-paypal") setTimeout(() => window.close(), 1_200);
          else
            void fetch(`/api/rooms/${encodeURIComponent(room)}`)
              .then((r) => r.json())
              .catch(() => ({}))
              .then((info: { mode?: string }) =>
                setTimeout(() => router.replace(`/${info.mode === "online" ? "live" : "paddle"}/${encodeURIComponent(room)}`), 1_200),
              );
          return;
        }
        if (!j.ok || j.status === "failed" || j.status === "cancelled") return;
      } catch {
        /* keep trying */
      }
      if (++tries < 60 && !stop) setTimeout(check, 2_000);
    };
    void check();
    return () => {
      stop = true;
    };
  }, [room, router]);

  const active = s?.ok && s.status === "active";
  const failed = s && (!s.ok || s.status === "failed" || s.status === "cancelled");

  return (
    <main className="mx-auto flex min-h-dvh max-w-[430px] flex-col items-center justify-center px-4 text-center" aria-live="polite">
      {active ? (
        <>
          <p className="text-lg text-smoke">PayPal is holding {usd(s.holdCents)}. Your paddle is</p>
          <p className="font-display text-[120px] leading-none font-black text-brass tabular">{s.paddle}</p>
        </>
      ) : failed ? (
        <>
          <p className="text-lg">{s.error ?? s.message ?? "PayPal didn't approve the hold. Try again or choose a lower limit."}</p>
          <Link href={`/join/${encodeURIComponent(room)}`} className="mt-6 inline-flex min-h-11 items-center rounded-full bg-brass px-6 font-display text-2xl font-bold text-velvet">
            Try again
          </Link>
        </>
      ) : (
        <p className="text-lg text-smoke">{s?.status === "pending_review" ? s.error : "Confirming your hold with PayPal…"}</p>
      )}
    </main>
  );
}
