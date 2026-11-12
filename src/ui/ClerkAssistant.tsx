"use client";
/**
 * Clerk console AI tools:
 *  - "Ask the clerk": questions in plain English, answered by an AI agent that
 *    checks PayPal live with read-only tools. Every PayPal check it made is shown.
 *  - "AI lot writer": a rough note becomes a lot draft the organiser edits and approves.
 */
import { useState } from "react";
import { usd, type Ack } from "./useRoom";

type Send = <T extends Ack = Ack>(event: string, payload?: unknown, timeoutMs?: number) => Promise<T>;
interface Step {
  tool: string;
  summary: string;
  paypal: boolean;
}
type AskReply = Ack & { answer?: string; steps?: Step[] };
interface Draft {
  title: string;
  story: string;
  startCents: number;
  incrementCents: number;
  why: string;
}
type DraftReply = Ack & { draft?: Draft };

const SUGGESTIONS = ["Has everyone who won actually paid?", "Who still has hold left?", "Is there anything I need to fix before closing?"];

export function AskClerk({ send, disabled }: { send: Send; disabled?: boolean }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<AskReply | null>(null);
  const [asked, setAsked] = useState("");

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setAsked(question.trim());
    setReply(null);
    const r = await send<AskReply>("clerk:ask", { question }, 60_000);
    setReply(r);
    setBusy(false);
  };

  return (
    <section className="rounded-xl border border-velvet/15 bg-white/40 p-5" aria-labelledby="ask-h">
      <h2 id="ask-h" className="font-display text-2xl font-bold">Ask the clerk</h2>
      <p className="text-sm text-velvet/70">An AI agent answers from the ledger and checks PayPal live. It can only read: it can&apos;t capture, void or change anything.</p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxLength={400}
          placeholder="e.g. Has everyone who won actually paid?"
          aria-label="Question for the clerk"
          className="min-h-11 flex-1 rounded-lg border border-velvet/25 bg-parchment px-3 text-base"
        />
        <button type="submit" disabled={busy || disabled || !q.trim()} className="min-h-11 rounded-full bg-brass px-5 font-display text-lg font-bold text-velvet disabled:opacity-40">
          {busy ? "Checking…" : "Ask"}
        </button>
      </form>
      <div className="mt-2 flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={busy || disabled}
            onClick={() => {
              setQ(s);
              void ask(s);
            }}
            className="min-h-9 rounded-full border border-velvet/30 px-3 text-sm hover:bg-velvet/5 disabled:opacity-40"
          >
            {s}
          </button>
        ))}
      </div>
      {(busy || reply) && (
        <div className="mt-4 rounded-lg bg-parchment p-4" aria-live="polite">
          <p className="text-sm text-velvet/60">“{asked}”</p>
          {busy && <p className="mt-2 italic">Checking the ledger and PayPal…</p>}
          {reply?.steps && reply.steps.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {reply.steps.map((s, i) => (
                <li key={i} className="flex items-baseline gap-2">
                  <span className={`shrink-0 rounded px-1.5 font-display text-xs font-bold ${s.paypal ? "bg-[#003087] text-white" : "bg-velvet/10"}`}>{s.paypal ? "PayPal" : "Ledger"}</span>
                  <span className="font-mono text-xs break-all">{s.summary}</span>
                </li>
              ))}
            </ul>
          )}
          {reply && <p className="mt-3 whitespace-pre-line">{reply.answer?.replaceAll("**", "") ?? (reply.ok ? "" : `Couldn't answer (${reply.reason ?? "error"}).`)}</p>}
        </div>
      )}
    </section>
  );
}

export function LotWriter({ send, disabled }: { send: Send; disabled?: boolean }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const write = async () => {
    if (!note.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    const r = await send<DraftReply>("clerk:draft-lot", { note }, 30_000);
    setBusy(false);
    if (r.ok && r.draft) setDraft(r.draft);
    else setMsg("The AI couldn't draft that. Add a few more details and try again.");
  };
  const add = async () => {
    if (!draft) return;
    const r = await send("clerk:add-lot", draft);
    if (r.ok) {
      setMsg(`Added “${draft.title}” to the end of the night.`);
      setDraft(null);
      setNote("");
    } else setMsg(`Couldn't add it (${r.reason}).`);
  };
  const dollars = (c: number) => String(Math.round(c / 100));

  return (
    <section className="rounded-xl border border-velvet/15 bg-white/40 p-5" aria-labelledby="lot-h">
      <h2 id="lot-h" className="font-display text-2xl font-bold">Add a lot · AI writer</h2>
      <p className="text-sm text-velvet/70">Type a rough note. The AI drafts the title, story and prices; you check them before anything is added.</p>
      <div className="mt-3 flex gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={400}
          placeholder="e.g. hand-stitched quilt, made by the Tuesday sewing group, double bed size"
          aria-label="Rough note about the lot"
          className="min-h-11 flex-1 rounded-lg border border-velvet/25 bg-parchment px-3 text-base"
        />
        <button type="button" onClick={write} disabled={busy || disabled || !note.trim()} className="min-h-11 rounded-full bg-brass px-5 font-display text-lg font-bold text-velvet disabled:opacity-40">
          {busy ? "Writing…" : "Draft it"}
        </button>
      </div>
      {draft && (
        <div className="mt-4 space-y-3 rounded-lg bg-parchment p-4">
          <label className="block text-sm text-velvet/70">
            Title
            <input value={draft.title} maxLength={80} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className="mt-1 block min-h-11 w-full rounded-lg border border-velvet/25 bg-white/60 px-3 font-serif text-lg text-velvet" />
          </label>
          <label className="block text-sm text-velvet/70">
            Story
            <textarea value={draft.story} maxLength={400} rows={2} onChange={(e) => setDraft({ ...draft, story: e.target.value })} className="mt-1 block w-full rounded-lg border border-velvet/25 bg-white/60 p-3 text-velvet" />
          </label>
          <div className="flex flex-wrap items-end gap-4">
            <label className="text-sm text-velvet/70">
              Opening price ($)
              <input inputMode="numeric" value={dollars(draft.startCents)} onChange={(e) => setDraft({ ...draft, startCents: (Number(e.target.value.replace(/\D/g, "")) || 0) * 100 })} className="mt-1 block min-h-11 w-28 rounded-lg border border-velvet/25 bg-white/60 px-3 text-velvet tabular" />
            </label>
            <label className="text-sm text-velvet/70">
              Bid step ($)
              <input inputMode="numeric" value={dollars(draft.incrementCents)} onChange={(e) => setDraft({ ...draft, incrementCents: (Number(e.target.value.replace(/\D/g, "")) || 0) * 100 })} className="mt-1 block min-h-11 w-28 rounded-lg border border-velvet/25 bg-white/60 px-3 text-velvet tabular" />
            </label>
            <p className="flex-1 text-sm text-velvet/70 italic">{draft.why || `Opens at ${usd(draft.startCents)}, steps of ${usd(draft.incrementCents)}.`}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={add} className="min-h-11 rounded-full bg-brass px-5 font-display text-lg font-bold text-velvet">
              Add to the night
            </button>
            <button type="button" onClick={() => setDraft(null)} className="min-h-11 rounded-full border-2 border-velvet px-5 font-display text-lg font-bold">
              Discard
            </button>
          </div>
        </div>
      )}
      {msg && (
        <p className="mt-3 text-sm" role="status">
          {msg}
        </p>
      )}
    </section>
  );
}
