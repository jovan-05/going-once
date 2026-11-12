import { createStage3D, getStage3DCentreReport, getStage3DStats, type Stage3D, type Stage3DEvent } from "./stage3d";

const MODEL_URL = "/models/saleroom-v5.glb";

const frame = document.getElementById("frame") as HTMLElement;
const mock = document.getElementById("mock") as HTMLElement;
const readout = document.getElementById("readout") as HTMLElement;
const priceEl = document.getElementById("mock-price") as HTMLElement;
const leaderEl = document.getElementById("mock-leader") as HTMLElement;
const captionEl = document.getElementById("mock-caption") as HTMLElement;
const tReduced = document.getElementById("t-reduced") as HTMLInputElement;
const tLow = document.getElementById("t-low") as HTMLInputElement;
const tMock = document.getElementById("t-mock") as HTMLInputElement;
const tRavi = document.getElementById("t-ravi") as HTMLInputElement;
const inN = document.getElementById("paddle-n") as HTMLInputElement;
const inName = document.getElementById("paddle-name") as HTMLInputElement;

tReduced.checked = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let canvas = document.getElementById("stage3d") as HTMLCanvasElement;
let stage: Stage3D;
let loadMs = 0;
let loadError = "";

function mount(): void {
  // A fresh canvas per instance: reduced motion is a creation option.
  const fresh = document.createElement("canvas");
  fresh.id = "stage3d";
  fresh.setAttribute("aria-hidden", "true");
  canvas.replaceWith(fresh);
  canvas = fresh;
  const t0 = performance.now();
  loadError = "";
  stage = createStage3D(canvas, {
    modelUrl: MODEL_URL,
    reducedMotion: tReduced.checked,
    quality: tLow.checked ? "low" : "high",
  });
  sizeToFrame();
  stage.ready.then(
    () => {
      loadMs = performance.now() - t0;
    },
    (err: unknown) => {
      loadError = err instanceof Error ? err.message : String(err);
      console.warn(loadError);
    },
  );
}

function sizeToFrame(): void {
  const r = frame.getBoundingClientRect();
  stage.resize(r.width, r.height);
}
new ResizeObserver(sizeToFrame).observe(frame);

// ---- a tiny stand-in for the engine → Stage3D event mapping ----------------
let leader: number | null = null;
let price = 1000;
let lotNo = 3;
const names: Record<number, string> = { 14: "Asha", 7: "Ravi", 21: "Paddle 21", 9: "Jon", 33: "Priya" };

function send(e: Stage3DEvent): void {
  stage.handle(e);
}

function bid(paddle: number, label?: string, isBot = false): void {
  const name = label ?? names[paddle] ?? `Paddle ${paddle}`;
  send({ type: "bid", paddle, label: name, isBot, isLeader: true });
  if (leader !== null && leader !== paddle) send({ type: "outbid", paddle: leader });
  leader = paddle;
  price += 40;
  priceEl.textContent = `$${price.toLocaleString("en-US")}`;
  const who = isBot ? "BOT" : /^paddle\s*\d+$/i.test(name) ? "" : name;
  leaderEl.textContent = who ? `paddle ${paddle} · ${who}` : `paddle ${paddle}`;
}

function randomPaddle(): number {
  let p = leader ?? 0;
  while (p === leader) p = 1 + Math.floor(Math.random() * 60);
  return p;
}

let script: number[] = [];
function cancelScript(): void {
  script.forEach((id) => clearTimeout(id));
  script = [];
}
function at(ms: number, fn: () => void): void {
  script.push(window.setTimeout(fn, ms));
}

function openLot(): void {
  leader = null;
  price = 1000;
  priceEl.textContent = "$1,000";
  leaderEl.textContent = "Opening bid";
  captionEl.textContent = "“Lot three, a weekend in the Nilgiris. Who’ll start me at a thousand?”";
  send({ type: "lot_opened", lotNumber: lotNo, lotTitle: "A weekend in the Nilgiris" });
}

function runDemoLot(): void {
  cancelScript();
  openLot();
  // v4: "Ravi wins demo" swaps the two main bidders, so the winner sits on
  // the left (Ravi, paddle 7) instead of the right (Asha, paddle 14).
  const ravi = tRavi.checked;
  const a = ravi ? 7 : 14; // opens, makes the late bid, wins
  const b = ravi ? 14 : 7;
  const nameA = names[a]!;
  const nameB = names[b]!;
  const word: Record<number, string> = { 7: "seven", 14: "fourteen" };
  const cap = (t: string) => () => (captionEl.textContent = t);
  at(1600, () => bid(a));
  at(1650, cap(`“A thousand and forty to ${nameA}.”`));
  at(2700, () => bid(b));
  at(3600, () => bid(21, "Paddle 21", true));
  at(4600, () => bid(a));
  at(5500, () => bid(b));
  at(5550, cap(`“Twelve hundred to ${nameB}. Do I hear more?”`));
  at(7000, () => {
    send({ type: "going_once" });
    captionEl.textContent = "“Going once…”";
  });
  at(8300, () => {
    bid(a);
    captionEl.textContent = `“A late hand! ${nameA}, twelve-forty.”`;
  });
  at(9900, () => {
    send({ type: "going_once" });
    captionEl.textContent = "“Going once…”";
  });
  at(11300, () => {
    send({ type: "going_twice" });
    captionEl.textContent = "“Going twice…”";
  });
  at(12800, () => {
    send({ type: "hammer", paddle: a, label: nameA });
    captionEl.textContent = `“Sold, to paddle ${word[a]}.”`;
  });
  at(14300, () => {
    send({ type: "sold_confirmed" });
    leaderEl.textContent = `Sold · paddle ${a} · ${nameA}`; // the real stage shows this only after PayPal confirms
  });
}

function stress(n: number, spanMs: number): void {
  cancelScript();
  for (let i = 0; i < n; i++) at((i * spanMs) / n, () => bid(randomPaddle(), undefined, Math.random() < 0.2));
}

const actions: Record<string, () => void> = {
  open: () => {
    cancelScript();
    openLot();
  },
  bid: () => bid(randomPaddle()),
  bot: () => bid(randomPaddle(), undefined, true),
  bidn: () => {
    const n = Math.max(1, Math.min(999, Math.floor(Number(inN.value) || 1)));
    bid(n, inName.value || `Paddle ${n}`);
  },
  outbid: () => {
    if (leader !== null) send({ type: "outbid", paddle: leader });
    leader = null;
  },
  once: () => send({ type: "going_once" }),
  twice: () => send({ type: "going_twice" }),
  hammer: () => leader !== null && send({ type: "hammer", paddle: leader, label: names[leader] ?? `Paddle ${leader}` }),
  sold: () => send({ type: "sold_confirmed" }),
  passed: () => send({ type: "lot_passed" }),
  pause: () => send({ type: "paused" }),
  resume: () => send({ type: "resumed" }),
  demo: runDemoLot,
  stress: () => stress(30, 5000),
  bids200: () => stress(200, 20000),
};

document.getElementById("panel")!.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  const fn = b?.dataset.ev ? actions[b.dataset.ev] : undefined;
  if (fn) fn();
});
mock.hidden = !tMock.checked; // v3: the overlay is on, to judge the price area
tMock.addEventListener("change", () => (mock.hidden = !tMock.checked));
tLow.addEventListener("change", () => stage.setQuality(tLow.checked ? "low" : "high"));
tReduced.addEventListener("change", () => {
  cancelScript();
  stage.dispose();
  mount();
});

setInterval(() => {
  const s = getStage3DStats(stage);
  if (loadError) {
    readout.textContent = `3D off: ${loadError}`;
    return;
  }
  if (!s) return;
  readout.textContent =
    `fps ${s.fps.toString().padStart(3)}  (${s.rendering})\n` +
    `draw calls ${s.calls}   triangles ${s.triangles.toLocaleString("en-US")}\n` +
    `geometries ${s.geometries}   textures ${s.textures}\n` +
    `canvas ${canvas.width}×${canvas.height}   ready ${loadMs ? Math.round(loadMs) + " ms" : "…"}`;
}, 250);

mount();

// Hooks for scripts/measure.mjs (lab only)
declare global {
  interface Window {
    __lab: {
      actions: typeof actions;
      stats: () => ReturnType<typeof getStage3DStats>;
      loadMs: () => number;
      ready: () => Promise<void>;
      stage: () => Stage3D;
    };
  }
}
window.__lab = { actions, stats: () => getStage3DStats(stage), loadMs: () => loadMs, ready: () => stage.ready, stage: () => stage };

// v3 lab check: what crosses the price area (see scripts/shot-v3.mjs)
(window as unknown as { __labCentre: () => unknown }).__labCentre = () => getStage3DCentreReport(stage);
