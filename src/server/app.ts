/**
 * Wires the process together without Next, so tests can boot the real-time
 * server on a random port. `server.ts` adds Next on top.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { openDb, type DB } from "../db/db";
import { PayPalClient, configFromEnv } from "../paypal/client";
import type { ItemCategory } from "../paypal/orders";
import { aiFromEnv, type AiClient } from "../auctioneer/ai";
import { AuctioneerService } from "../auctioneer/host";
import { SYSTEM, fill } from "../auctioneer/templates";
import { TtsService, ttsFromEnv, type TtsEngine } from "../auctioneer/tts";
import { formatUsd, publicName } from "../engine";
import { createApi } from "./api";
import { DemoDirector, type DemoTiming } from "./bots";
import { ClerkAgent } from "./clerkAgent";
import { cleanText, draftLot } from "../auctioneer/lotWriter";
import { randomBytes } from "node:crypto";
import { CaptureService } from "./captures";
import { CloseService } from "./close";
import { HoldService } from "./holds";
import { attachRealtime } from "./realtime";
import { RoomManager } from "./rooms";

export interface AppOptions {
  db?: DB;
  paypal?: PayPalClient | null;
  publicBaseUrl?: string;
  allowTestBidders?: boolean;
  fallback?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  tickMs?: number;
  pollMs?: number;
  /** undefined = from env (AI_API_KEY); null = no AI, bank only. */
  ai?: AiClient | null;
  /** undefined = from env (SMALLEST_API_KEY); null = no cloud voice. */
  tts?: { engine: TtsEngine; voice: string; maxChars?: number } | null;
  /** Demo bots/autopilot timing (tests speed it up). */
  demoTiming?: Partial<DemoTiming>;
}

export function paypalFromEnv(): PayPalClient | null {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    console.warn("[paypal] PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set — joining with a real hold is disabled.");
    return null;
  }
  return new PayPalClient(configFromEnv()); // throws unless the host is the sandbox (rule 1)
}

export function createAppServer(opts: AppOptions = {}) {
  const db = opts.db ?? openDb();
  const rooms = new RoomManager(db);
  let refresh: (roomId: string) => void = () => {};
  const paypal = opts.paypal === undefined ? paypalFromEnv() : opts.paypal;
  const holds = new HoldService({
    db,
    rooms,
    paypal,
    publicBaseUrl: opts.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:3000",
    itemCategory: (process.env.PAYPAL_ITEM_CATEGORY as ItemCategory | undefined) ?? "DONATION",
    webhookId: process.env.PAYPAL_WEBHOOK_ID || undefined,
    onChange: (roomId) => refresh(roomId),
  });
  const captures = new CaptureService({ db, rooms, paypal, onChange: (roomId) => refresh(roomId) });
  rooms.onChange((roomId, events) => captures.handleEvents(roomId, events));
  holds.captureHint = (captureId) => captures.refreshByCaptureId(captureId);
  const close = new CloseService({ db, rooms, paypal, captures, onChange: (roomId) => refresh(roomId) });
  holds.lateHold = (roomId) => close.closeNight(roomId);
  close.onClosed = (roomId) => void host?.thankYou(roomId);
  // The cloud voice (smallest.ai), if configured. It may voice only lines the server said,
  // plus the Sold/Won line of a lot that really sold (the stage builds that one).
  const ttsCfg = opts.tts === undefined ? ttsFromEnv() : opts.tts;
  const soldLines = (roomId: string) => {
    const s = rooms.get(roomId)?.state;
    if (!s) return [];
    return s.lots.flatMap((l) => {
      const w = l.winnerId ? s.bidders[l.winnerId] : undefined;
      if (l.status !== "sold" || !w || l.hammerCents === null) return [];
      const n = publicName(w);
      const vars = { leader: n === `Paddle ${w.paddle}` ? `paddle ${w.paddle}` : n, amount: formatUsd(l.hammerCents) };
      return [fill(SYSTEM.sold, vars), fill(SYSTEM.won, vars)].filter((x): x is string => !!x);
    });
  };
  const tts = ttsCfg ? new TtsService(ttsCfg.engine, ttsCfg.voice, soldLines, ttsCfg.maxChars) : null;
  if (tts) rooms.onChange((roomId, events) => {
    if (events.some((e) => e.type === "lot_sold")) for (const t of soldLines(roomId).slice(-2)) tts.warm(roomId, t);
  });

  const demo = new DemoDirector({ rooms, timing: opts.demoTiming, onFinished: (roomId) => close.closeNight(roomId) });
  const ai = opts.ai === undefined ? aiFromEnv() : opts.ai;
  const agent = new ClerkAgent({ db, rooms, paypal, ai });
  const api = createApi({ rooms, holds, allowTestBidders: !!opts.allowTestBidders, demo, tts });

  const server: Server = createServer(async (req, res) => {
    if (await api(req, res)) return;
    if (opts.fallback) return opts.fallback(req, res);
    res.writeHead(404).end();
  });
  let host: AuctioneerService | null = null;
  const rt = attachRealtime(server, rooms, {
    lastLine: (roomId) => host?.lastLine(roomId),
    voicePlan: (roomId) => host?.voicePlan(roomId),
    closeNight: (roomId) => close.closeNight(roomId),
    myRelease: (bidderId) => close.bidderRelease(bidderId),
    askClerk: (roomId, question) => agent.ask(roomId, question),
    draftLot: (note) => draftLot(ai, note),
    addLot: (roomId, l) => {
      const title = typeof l.title === "string" ? cleanText(l.title, 80) : "";
      const story = typeof l.story === "string" ? cleanText(l.story, 400) : "";
      const startCents = Number(l.startCents);
      const incrementCents = Number(l.incrementCents);
      const id = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "lot"}-${randomBytes(3).toString("hex")}`;
      const r = rooms.dispatch(roomId, { type: "add_lot", lot: { id, title, story, startCents, incrementCents } });
      if (r.ok) host?.prepare(roomId);
      return { ok: r.ok, reason: r.reason };
    },
    onStageJoin: (roomId) => {
      if (!rooms.isClosed(roomId)) host?.prepare(roomId);
    },
  });
  refresh = rt.refresh;
  // Registered after the realtime layer, so screens get the new state before the line about it.
  host = new AuctioneerService({ rooms, ai, emit: (roomId, line) => {
      tts?.said(roomId, line.text);
      rt.sayLine(roomId, line);
    }, onPlanChange: (roomId) => refresh(roomId) });
  rooms.onChange((roomId, events) => host?.handleEvents(roomId, events));
  // Bots react after the screens and the auctioneer have heard about a change.
  rooms.onChange(demo.handleEvents);
  // Line banks are written only for rooms in use: when a stage opens one or a guest joins
  // (never for every old room at boot: that would burst the AI's free-tier rate limit).

  rooms.start(opts.tickMs ?? 200);
  holds.startPolling(opts.pollMs ?? 2_000);
  captures.startPolling(opts.pollMs ?? 2_000);
  captures.resumeMissing();
  close.resume();

  const shutdown = async () => {
    rooms.stop();
    demo.stop();
    holds.stopPolling();
    captures.stopPolling();
    await rt.io.close();
    db.close();
  };
  return { server, db, rooms, holds, captures, closer: close, host, demo, io: rt.io, close: shutdown };
}
