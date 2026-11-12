"use client";

import { useEffect, useState } from "react";
import {
  KOKORO_VOICES,
  chooseCloudVoice,
  chooseVoice,
  clip,
  cloudClip,
  cloudInfo,
  currentVoice,
  initKokoro,
  storedCloudVoice,
  subscribeVoice,
  type CloudInfo,
  type VoiceState,
} from "@/ui/kokoro";
import { playClips, unlockAudio } from "@/ui/sound";

const SAMPLE =
  "Lot three: a cooking class for six. Who'll start me at one hundred and twenty dollars? Going once… going twice… Sold, to Asha, for two hundred dollars. Thank you!";

/**
 * Preview and pick the auctioneer's voice. With a cloud voice configured on
 * the server (smallest.ai), those voices are offered; otherwise Kokoro, which
 * runs in this browser. The choice is saved in this browser, so do this on the
 * computer that shows the stage.
 */
export default function VoicesPage() {
  const [cloud, setCloud] = useState<CloudInfo | null | undefined>(undefined);
  useEffect(() => {
    void cloudInfo().then((i) => setCloud(i?.enabled ? i : null));
  }, []);
  if (cloud === undefined) return <Frame><p className="mt-4 text-smoke">Checking voices…</p></Frame>;
  return cloud ? <CloudVoices info={cloud} /> : <KokoroVoices />;
}

function Frame({ children, credit }: { children: React.ReactNode; credit?: string }) {
  return (
    <main className="min-h-dvh bg-velvet px-4 py-8 font-serif text-parchment sm:px-10">
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-4xl font-black text-brass">The auctioneer&apos;s voice</h1>
        {children}
        {credit && <p className="mt-8 text-xs text-smoke/70">{credit}</p>}
      </div>
    </main>
  );
}

function VoiceList({
  voices,
  chosen,
  busy,
  disabled,
  onPreview,
  onChoose,
}: {
  voices: { id: string; label: string }[];
  chosen: string;
  busy: string | null;
  disabled: boolean;
  onPreview: (id: string) => void;
  onChoose: (id: string) => void;
}) {
  return (
    <ul className="mt-6 grid gap-3 sm:grid-cols-2">
      {voices.map((v) => {
        const isChosen = v.id === chosen;
        return (
          <li key={v.id} className={`flex items-center justify-between gap-3 rounded-xl bg-curtain p-4 ${isChosen ? "ring-2 ring-brass" : ""}`}>
            <div>
              <p className="font-display text-xl font-bold">{v.label.split(" · ")[0]}</p>
              <p className="text-sm text-smoke">{v.label.split(" · ")[1]}</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={disabled || busy !== null}
                onClick={() => onPreview(v.id)}
                className="min-h-11 rounded-full border-2 border-parchment px-4 font-display font-bold disabled:opacity-40"
              >
                {busy === v.id ? "Rendering…" : "Preview"}
              </button>
              <button
                type="button"
                onClick={() => onChoose(v.id)}
                aria-pressed={isChosen}
                className={`min-h-11 rounded-full px-4 font-display font-bold ${isChosen ? "bg-brass text-velvet" : "border-2 border-brass text-brass"}`}
              >
                {isChosen ? "Chosen" : "Use"}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function CloudVoices({ info }: { info: CloudInfo }) {
  const [chosen, setChosen] = useState(() => storedCloudVoice(info));
  const [line, setLine] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stop, setStop] = useState<(() => void) | null>(null);

  const preview = async (id: string) => {
    stop?.();
    setError(null);
    await unlockAudio();
    setBusy(id);
    const a = await cloudClip("_preview", info.previewLines[line] ?? "", id, 10_000);
    setBusy(null);
    if (!a) return setError("That voice couldn't be rendered just now. Try another, or try again in a moment.");
    const p = playClips([{ ...a, pauseMs: 0 }]);
    setStop(() => p.stop);
  };

  return (
    <Frame credit={`Voice: smallest.ai (${info.label ?? "Lightning"}), rendered on our server. Without it, the stage falls back to the browser's voice.`}>
      <p className="mt-2 text-smoke">
        Pick the warmest, most theatrical voice. The choice is saved in this browser, so do this on the computer that shows the stage.
      </p>
      <fieldset className="mt-6">
        <legend className="text-sm text-smoke">Sample line</legend>
        <div className="mt-2 flex flex-col gap-2">
          {info.previewLines.map((l, i) => (
            <label key={l} className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg p-3 ${line === i ? "bg-curtain" : ""}`}>
              <input type="radio" name="line" checked={line === i} onChange={() => setLine(i)} className="mt-1 accent-[var(--brass)]" />
              <span className="italic">{l}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="mt-3 text-parchment">
          {error}
        </p>
      )}
      <VoiceList
        voices={info.voices}
        chosen={chosen}
        busy={busy}
        disabled={false}
        onPreview={preview}
        onChoose={(id) => {
          chooseCloudVoice(id);
          setChosen(id);
        }}
      />
    </Frame>
  );
}

function KokoroVoices() {
  const [voice, setVoice] = useState<VoiceState | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [text, setText] = useState(SAMPLE);
  const [stop, setStop] = useState<(() => void) | null>(null);

  useEffect(() => {
    initKokoro();
    const off = subscribeVoice((s) => {
      setVoice(s);
      setChosen(s.voice);
    });
    setChosen(currentVoice());
    return off;
  }, []);

  const preview = async (id: string) => {
    stop?.();
    await unlockAudio();
    setBusy(id);
    const samples = await clip(text.trim().slice(0, 300), 5_000, id);
    setBusy(null);
    if (!samples) return;
    const p = playClips([{ samples, sr: 24_000, pauseMs: 0 }]);
    setStop(() => p.stop);
  };

  return (
    <Frame credit="Voice model: Kokoro-82M (Apache 2.0), via kokoro-js, running in this browser.">
      <p className="mt-2 text-smoke">
        Preview the Kokoro voices and pick the warmest, most theatrical one. The choice is saved in this browser, so do this on the computer that shows the stage.
      </p>
      <p role="status" className="mt-4 text-sm text-smoke">
        {voice?.status === "loading" && `Warming up the voices… ${voice.pct}% (first time only; the model is cached afterwards)`}
        {voice?.status === "ready" && `Voices ready (${voice.device === "webgpu" ? "graphics card" : "WebAssembly"}). Each preview takes a moment to render.`}
        {voice?.status === "failed" && `Kokoro couldn't load here (${voice.error ?? "unknown error"}). The stage will use the browser's voice.`}
      </p>
      <label className="mt-6 block text-sm text-smoke" htmlFor="sample">
        Sample line
      </label>
      <textarea
        id="sample"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={300}
        rows={3}
        className="mt-1 w-full rounded-lg bg-curtain p-3 text-parchment"
      />
      <VoiceList voices={KOKORO_VOICES} chosen={chosen} busy={busy} disabled={voice?.status !== "ready"} onPreview={preview} onChoose={chooseVoice} />
    </Frame>
  );
}
