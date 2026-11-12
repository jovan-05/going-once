"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import QRCode from "qrcode";
import { SYSTEM, fill } from "@/auctioneer/templates";
import type { EngineEvent } from "@/engine";
import { Caption } from "@/ui/Caption";
import { RollingPrice } from "@/ui/RollingPrice";
import { audioRunning, playGavel, playTick, setMurmur, setMuted, unlockAudio } from "@/ui/sound";
import { CAPTURE_COPY, readLocal, usd, useRoom, writeLocal, type HostLine, type StageSnapshot } from "@/ui/useRoom";
import { initVoice, prewarm, sayLine, setSpeechMuted, subscribeVoice, type VoiceState } from "@/ui/kokoro";
import { unlockVoice } from "@/ui/voice";
import { planClips, spokenName } from "@/ui/voicePlan";
import { Stage3DLayer, stage3DMode, type Stage3DHandle, type Stage3DMode } from "@/ui/Stage3DLayer";

const LIVE = new Set(["open", "going_once", "going_twice"]);
const DOTS_LEFT: Record<string, number> = { waiting: 3, open: 3, going_once: 2, going_twice: 1, sold: 0, passed: 0 };

interface Hammer {
  lotId: string;
  paddle: number;
  name: string;
  isBot: boolean;
  amountCents: number;
  struck: boolean;
}

export default function StagePage() {
  const { room } = useParams<{ room: string }>();
  const reduce = useReducedMotion();
  const [caption, setCaption] = useState<{ text: string; id: number }>({ text: "", id: 0 });
  const [raised, setRaised] = useState<Record<number, number>>({});
  const [hammer, setHammer] = useState<Hammer | null>(null);
  const [curtain, setCurtain] = useState(0);
  const [sound, setSound] = useState<"locked" | "on" | "off">("locked");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // The 3D saleroom behind the 2D stage (?3d=0 off, ?3d=low for weak GPUs).
  const s3d = useRef<Stage3DHandle>(null);
  const [mode3d, setMode3d] = useState<Stage3DMode>("off");
  const [threeD, setThreeD] = useState(false);
  const leader3d = useRef<number | null>(null);
  useEffect(() => setMode3d(stage3DMode()), []);

  /** Caption and voice always carry the same words (AUCTIONEER.md). */
  const say = useCallback((line: Pick<HostLine, "text" | "tone"> & Partial<Pick<HostLine, "template" | "vars">>, voice = true) => {
    if (!line.text) return;
    setCaption((c) => ({ text: line.text, id: c.id + 1 }));
    if (voice) void sayLine(line);
  }, []);

  // The voice: Kokoro in a worker, loaded once; browser speech until it's ready or if it fails.
  const [voice, setVoice] = useState<VoiceState | null>(null);
  useEffect(() => {
    void initVoice(room);
    return subscribeVoice(setVoice);
  }, [room]);

  const onEvents = useCallback(
    (events: EngineEvent[], snap: StageSnapshot | null) => {
      if (!snap) return;
      for (const ev of events) {
        sendTo3D(ev, snap);
        if (ev.type === "bid_accepted") {
          const paddle = Number(ev.data.paddle);
          setRaised((r) => ({ ...r, [paddle]: Date.now() }));
          timers.current.push(setTimeout(() => setRaised((r) => ({ ...r, [paddle]: 0 })), 600));
          playTick();
        }
        if (ev.type === "lot_sold") {
          const paddle = Number(ev.data.paddle);
          const b = snap.bidders.find((x) => x.paddle === paddle);
          setHammer({ lotId: String(ev.data.lotId), paddle, name: b?.name ?? `Paddle ${paddle}`, isBot: !!b?.isBot, amountCents: Number(ev.data.amountCents), struck: false });
          // 1. hold still for 300ms — silence before the strike. 2. gavel + flash.
          timers.current.push(
            setTimeout(() => {
              setHammer((h) => (h ? { ...h, struck: true } : h));
              playGavel();
            }, 300),
          );
        }
        if (ev.type === "lot_advanced" || ev.type === "lot_opened") setHammer(null);
        if (ev.type === "lot_advanced") setCurtain((n) => n + 1);
      }
    },
    [say],
  );

  /** Engine event → 3D moment. Names come from the public view, so consent is already applied. */
  const sendTo3D = (ev: EngineEvent, snap: StageSnapshot) => {
    const send = (e: Parameters<Stage3DHandle["send"]>[0]) => s3d.current?.send(e);
    const who = (paddle: number) => {
      const b = snap.bidders.find((x) => x.paddle === paddle);
      return { paddle, label: b?.name ?? `Paddle ${paddle}`, isBot: !!b?.isBot };
    };
    switch (ev.type) {
      case "lot_opened":
        leader3d.current = null;
        send({ type: "lot_opened", lotNumber: Number(ev.data.number) || snap.lot?.number || 1, lotTitle: snap.lot?.title ?? "" });
        break;
      case "bid_accepted": {
        const paddle = Number(ev.data.paddle);
        const prev = leader3d.current;
        if (prev !== null && prev !== paddle) send({ type: "outbid", paddle: prev });
        leader3d.current = paddle;
        send({ type: "bid", ...who(paddle), isLeader: true });
        break;
      }
      case "lot_sold": {
        const { paddle, label } = who(Number(ev.data.paddle));
        send({ type: "hammer", paddle, label });
        break;
      }
      case "going_once":
      case "going_twice":
      case "lot_passed":
      case "paused":
      case "resumed":
        send({ type: ev.type });
        break;
    }
  };

  const onHost = useCallback((line: HostLine) => say(line), [say]);
  const { state, connected, error } = useRoom(room, "stage", {}, onEvents, onHost);

  // First snapshot: set a caption and, if we joined mid-hammer, show the result without replaying it.
  const seeded = useRef(false);
  useEffect(() => {
    if (!state || seeded.current) return;
    seeded.current = true;
    const lot = state.lot;
    if (lot?.status === "sold" && lot.high && lot.hammerCents) {
      setHammer({ lotId: lot.id, paddle: lot.high.paddle, name: lot.high.name, isBot: lot.high.isBot, amountCents: lot.hammerCents, struck: true });
      announced.current.add(lot.id);
    }
    const recent = state.host && state.host.lotId === lot?.id && Date.now() - state.host.at < 15_000 ? state.host.text : null;
    say({ text: recent ?? (lot?.status === "waiting" ? `Welcome to ${state.name}. Lot ${lot.number} opens shortly.` : lot ? lot.title : state.name), tone: "warm" }, false);
  }, [state, say]);

  // Bring the 3D room up to date once (e.g. the stage was reloaded mid-lot).
  const seeded3d = useRef(false);
  useEffect(() => {
    if (!state || mode3d === "off" || seeded3d.current) return;
    seeded3d.current = true;
    const lot = state.lot;
    if (!lot || lot.status === "waiting") return;
    s3d.current?.send({ type: "lot_opened", lotNumber: lot.number, lotTitle: lot.title });
    if (state.paused) s3d.current?.send({ type: "paused" });
    if (lot.high && lot.status !== "passed") {
      leader3d.current = lot.high.paddle;
      s3d.current?.send({ type: "bid", paddle: lot.high.paddle, label: lot.high.name, isBot: lot.high.isBot, isLeader: true });
    }
  }, [state, mode3d]);

  // Sound: on by default for the stage, but browsers need one click first.
  useEffect(() => {
    const pref = readLocal("going-once:stage-sound");
    setSpeechMuted(true); // silent until the first click (autoplay rules), like the other sounds
    const unlock = async () => {
      unlockVoice();
      if (await unlockAudio()) {
        const on = pref !== "off";
        setMuted(!on);
        setSpeechMuted(!on);
        setSound(on ? "on" : "off");
      }
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
  // "Sold" is said only when PayPal confirms the capture (rule 4), and only after the
  // strike, so it always follows "Hammer down" however fast PayPal answers.
  const announced = useRef<Set<string>>(new Set());
  useEffect(() => {
    const lot = state?.lot;
    if (!state || !lot || !hammer?.struck || hammer.lotId !== lot.id || announced.current.has(lot.id)) return;
    const cap = state.captures?.[lot.id];
    if (cap?.status === "captured" || cap?.status === "simulated") {
      announced.current.add(lot.id);
      s3d.current?.send({ type: "sold_confirmed" });
      const winner = state.bidders.find((b) => b.paddle === hammer.paddle);
      const template = cap.status === "simulated" ? SYSTEM.won : SYSTEM.sold;
      const vars = { leader: winner ? spokenName(winner) : `paddle ${hammer.paddle}`, amount: usd(cap.amountCents) };
      say({ text: fill(template, vars) ?? "", template, vars, tone: "grateful" });
    }
  }, [state, hammer, say]);

  // Pre-render every clip the next moments may need (cheap to call: cached/queued clips are skipped).
  useEffect(() => {
    if (state && voice?.status !== "failed") prewarm(planClips(state));
  }, [state, voice?.status]);

  // The closing thank-you arrives as a host line ("night_closed"), written by the AI or the fixed fallback.

  const live = !!state?.lot && LIVE.has(state.lot.status) && !state.paused;
  useEffect(() => setMurmur(live && sound === "on"), [live, sound]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const [qr, setQr] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState("");
  useEffect(() => {
    const url = `${window.location.origin}/join/${encodeURIComponent(room)}`;
    setJoinUrl(url);
    QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: "#2B0A1D", light: "#F6EDDC" } }).then(setQr, () => setQr(null));
  }, [room]);

  if (error) return <Centered>{error === "unknown_room" ? "This auction room doesn't exist." : "Can't reach the room. Retrying…"}</Centered>;
  if (!state) return <Centered>Connecting to the room…</Centered>;

  const lot = state.lot;
  const sold = lot?.status === "sold" && hammer?.lotId === lot.id;
  const cap = lot ? state.captures?.[lot.id] : undefined;
  const stamp = cap?.status === "captured" ? "Sold" : cap?.status === "simulated" ? "Won" : null;
  const price = sold ? hammer.amountCents : (lot?.priceCents ?? lot?.startCents ?? null);
  const dotsLeft = lot ? (DOTS_LEFT[lot.status] ?? 3) : 3;
  const highPaddle = lot?.high?.paddle;
  const calling = lot?.status === "going_once" ? "going once" : lot?.status === "going_twice" ? "going twice" : "";

  return (
    <main className="relative isolate flex h-dvh flex-col overflow-hidden px-[3.3vw] py-[4.4vh]">
      <Stage3DLayer ref={s3d} mode={mode3d} onReady={setThreeD} />
      {/* Lot block + QR */}
      <header className="flex items-start justify-between gap-[3vw]">
        <div className="max-w-[48vw]">
          <p className="font-display text-[1.25vw] font-bold text-smoke tabular">
            {lot ? `Lot ${lot.number} of ${state.lotCount}` : "No lots"}
            {state.paused && " · paused"}
            {!connected && " · reconnecting"}
          </p>
          <h1 className="mt-[1.2vh] font-serif text-[3.33vw] leading-[1.05] font-semibold text-balance text-parchment">{lot?.title}</h1>
          <p className="mt-[1.4vh] max-w-[60ch] font-serif text-[1.25vw] leading-snug text-smoke">{lot?.story}</p>
        </div>
        <div className="relative shrink-0">
          <aside className="flex shrink-0 flex-col items-center gap-[1vh] rounded-xl bg-curtain p-[0.9vw]">
            {qr ? (
              <img src={qr} alt={`QR code to join the auction at ${joinUrl}`} className="size-[9.4vw] rounded-md" />
            ) : (
              <div className="size-[9.4vw]" />
            )}
            <p className="font-serif text-[1.05vw] text-parchment">Scan to bid</p>
          </aside>
        {/* Sound toggle */}
        <button
          type="button"
          onClick={async (e) => {
            e.stopPropagation();
            if (!audioRunning()) await unlockAudio();
            const next = sound === "on" ? "off" : "on";
            setMuted(next === "off");
            setSpeechMuted(next === "off");
            if (next === "on") unlockVoice();
            setSound(next);
            writeLocal("going-once:stage-sound", next);
          }}
          className="absolute top-full left-1/2 mt-[0.6vh] -translate-x-1/2 rounded-full px-2 py-1 font-serif text-[0.75vw] whitespace-nowrap text-smoke/80 hover:text-parchment"
        >
          {sound === "locked" ? "Click anywhere for sound" : sound === "on" ? "Sound on · mute" : "Sound off · unmute"}
        </button>
        {voice?.status === "loading" && (
          <p role="status" className="absolute top-full left-1/2 mt-[3.4vh] -translate-x-1/2 font-serif text-[0.75vw] whitespace-nowrap text-smoke/70 italic">
            Warming up the auctioneer&apos;s voice… {voice.pct}%
          </p>
        )}
        </div>
      </header>

      {/* The price: the one bold thing */}
      <section className="relative flex flex-1 flex-col items-center justify-center">
        <p className="h-[3vh] font-serif text-[1.25vw] text-smoke italic">{lot && !lot.priceCents && (LIVE.has(lot.status) || lot.status === "waiting") ? "Opening at" : ""}</p>
        <div className="flex items-baseline gap-[2vw]">
          {/* Reduced motion: the flash becomes a plain colour swap. */}
          <span className={`font-display text-[min(14.6vw,26vh)] font-black ${sold && hammer?.struck && reduce ? "text-parchment" : "text-brass"}`}>
            <RollingPrice
              key={sold && hammer?.struck ? `flash-${hammer.lotId}` : "price"}
              cents={price}
              flash={!!(sold && hammer?.struck && !reduce)}
              label={price === null ? "No price" : `Current price ${usd(price)}`}
            />
          </span>
          <AnimatePresence>
            {sold && hammer?.struck && stamp && (
              <motion.span
                initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.4 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: reduce ? 0.2 : 0.25, ease: [0.2, 0.8, 0.2, 1] }}
                className="font-display text-[min(6.25vw,11vh)] leading-none font-black text-parchment"
              >
                {stamp}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <p className="mt-[1.5vh] h-[5vh] font-display text-[2.5vw] leading-none font-bold text-parchment tabular">
          {lot?.high ? (
            <>
              paddle {lot.high.paddle}
              {lot.high.name !== `Paddle ${lot.high.paddle}` && <span className="font-serif font-normal italic"> · {lot.high.name}</span>}
              {lot.high.isBot && <BotTag className="ml-[0.6vw] text-[1vw]" />}
            </>
          ) : lot?.status === "passed" ? (
            <span className="text-smoke">Passed</span>
          ) : null}
        </p>
      </section>

      {/* Auctioneer caption */}
      <Caption
        line={caption.text}
        id={caption.id}
        className="mx-auto mt-[1.5vh] mb-[3vh] min-h-[1.35em] max-w-[70ch] text-center font-serif text-[2.08vw] leading-snug text-balance text-parchment italic"
      />

      {/* Paddle row + countdown */}
      <footer className="flex items-end justify-between gap-[2vw]">
        {threeD ? <span className="h-[3.4vw]" aria-hidden /> :<ul className="flex flex-wrap items-end gap-[0.9vw]" aria-label="Paddles in the room">
          {state.bidders.map((b) => {
            const up = !!raised[b.paddle];
            const high = b.paddle === highPaddle;
            return (
              <li
                key={b.paddle}
                className={`relative flex size-[3.4vw] items-center justify-center rounded-full bg-curtain font-display text-[1.3vw] font-bold tabular transition-all duration-300 ${
                  high ? "text-brass" : "text-parchment"
                }`}
                style={{
                  transform: up && !reduce ? "translateY(-1.2vh)" : "none",
                  // brass ring for the high bidder + a brass glow for 600ms when a paddle is raised
                  boxShadow:
                    [high && "0 0 0 0.2vw var(--brass)", up && "0 0 2.2vw 0.4vw color-mix(in srgb, var(--brass) 55%, transparent)"]
                      .filter(Boolean)
                      .join(", ") || "none",
                }}
              >
                {b.paddle}
                {b.isBot && <BotTag className="absolute -top-[0.7vw] -right-[0.9vw] text-[0.65vw]" />}
              </li>
            );
          })}
        </ul>}
        <div className="flex items-center gap-[1vw]" aria-label={calling || "bidding"}>
          <span className="font-serif text-[1.25vw] text-smoke italic">{calling}</span>
          <div className="flex gap-[0.6vw]" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={`size-[1vw] rounded-full transition-all duration-500 ${i < dotsLeft ? "scale-100 bg-brass" : "scale-75 bg-curtain"}`}
              />
            ))}
          </div>
        </div>
      </footer>

      {/* Receipt ticket */}
      <AnimatePresence>
        {sold && hammer?.struck && (
          <motion.div
            key={`ticket-${hammer.lotId}`}
            initial={reduce ? { opacity: 0 } : { y: "120%" }}
            animate={reduce ? { opacity: 1 } : { y: 0 }}
            exit={reduce ? { opacity: 0 } : { y: "120%" }}
            transition={{ duration: 0.5, delay: reduce ? 0 : 0.35, ease: [0.2, 0.8, 0.2, 1] }}
            className="absolute bottom-[4.4vh] left-1/2 flex h-[3.4vw] w-[34vw] -translate-x-1/2 items-center justify-between gap-[1vw] rounded-lg bg-parchment px-[1.4vw] text-velvet shadow-2xl"
            role="status"
          >
            <span className="font-display text-[1.4vw] font-bold whitespace-nowrap">
                Paddle {hammer.paddle}
                {hammer.name !== `Paddle ${hammer.paddle}` && <span className="font-serif font-normal"> · {hammer.name}</span>}
                {hammer.isBot && <BotTag className="ml-2 text-[0.7vw]" />}
            </span>
            <span className="flex flex-col items-center font-serif text-[0.85vw] leading-tight text-velvet/80" aria-live="polite">
              <span className={cap?.status === "captured" ? "font-semibold text-velvet" : ""}>{CAPTURE_COPY[cap?.status ?? "capturing"]}</span>
              {cap?.captureId && <span className="font-mono text-[0.7vw] text-velvet/70">PayPal {cap.captureId}</span>}
            </span>
            <span className="font-display text-[1.4vw] font-black tabular">{usd(hammer.amountCents)}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* End of the night: the thank-you roll */}
      <AnimatePresence>
        {state.night && (
          <motion.section
            key="night"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: reduce ? 0.2 : 1.2 }}
            className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-velvet px-[6vw] text-center"
            aria-live="polite"
          >
            <p className="font-display text-[1.6vw] font-bold text-smoke">{state.name}</p>
            <h2 className="mt-[1vh] font-display text-[7vw] leading-none font-black text-brass">Thank you</h2>
            <p className="mt-[2.5vh] font-serif text-[2.4vw] text-parchment">
              Together you raised <span className="font-display font-black text-brass tabular">{usd(state.night.raisedCents)}</span> tonight.
            </p>
            <ul className="mt-[4vh] w-full max-w-[64vw] space-y-[1.2vh]">
              {state.lots
                .filter((l) => l.status === "sold")
                .map((l, i) => {
                  const w = state.bidders.find((b) => b.paddle === l.winnerPaddle);
                  return (
                    <motion.li
                      key={l.id}
                      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: reduce ? 0 : 0.9 + i * 0.35, duration: 0.5 }}
                      className="flex items-baseline justify-between gap-[2vw] border-b border-curtain pb-[1vh] font-serif text-[1.6vw]"
                    >
                      <span className="truncate text-left text-parchment">{l.title}</span>
                      <span className="shrink-0 text-smoke">
                        paddle {l.winnerPaddle}
                        {w && w.name !== `Paddle ${w.paddle}` && <span className="italic"> · {w.name}</span>}
                        {w?.isBot && <BotTag className="ml-[0.5vw] text-[0.8vw]" />}
                        <span className="ml-[1.5vw] font-display font-bold text-brass tabular">{usd(l.hammerCents)}</span>
                      </span>
                    </motion.li>
                  );
                })}
            </ul>
            <p className="mt-[4vh] font-serif text-[1.4vw] text-smoke">
              {state.night.releasing
                ? "Releasing everyone's unused holds at PayPal…"
                : state.night.attention
                  ? "Unused holds are being released; the organiser is checking one or two by hand."
                  : "Every unused hold has been released at PayPal. Nobody pays for what they didn't win."}
            </p>
            {state.isDemo && <p className="mt-[1vh] font-serif text-[1vw] text-smoke/70">Demo room: bids by BOT bidders used simulated holds.</p>}
          </motion.section>
        )}
      </AnimatePresence>

      {/* Curtain wipe between lots */}
      <AnimatePresence>
        {curtain > 0 && !threeD && (
          <motion.div
            key={`curtain-${curtain}`}
            aria-hidden
            className="pointer-events-none absolute inset-0 z-20 bg-curtain"
            initial={reduce ? { opacity: 0 } : { x: "-100%" }}
            animate={reduce ? { opacity: [0, 1, 0] } : { x: ["-100%", "0%", "0%", "100%"] }}
            transition={{ duration: reduce ? 0.6 : 1.1, times: reduce ? [0, 0.5, 1] : [0, 0.4, 0.55, 1], ease: "easeInOut" }}
            onAnimationComplete={() => setCurtain(0)}
          />
        )}
      </AnimatePresence>

    </main>
  );
}

function BotTag({ className = "" }: { className?: string }) {
  return <span className={`inline-block rounded bg-smoke px-[0.3em] align-middle font-display leading-tight font-bold text-velvet ${className}`}>BOT</span>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="flex h-dvh items-center justify-center font-serif text-3xl text-smoke">{children}</main>;
}
