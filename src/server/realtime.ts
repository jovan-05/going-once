/**
 * Socket.IO rooms. One socket.io room per auction room. Clients authenticate
 * with { room, role, key? (clerk), token? (paddle) } and receive:
 *   "state"  — a full role-scoped snapshot (on connect and after every change)
 *   "events" — the engine events that caused the change (public ones only for non-clerks)
 *   "host"   — the auctioneer's line for that change (text only; never money or holds)
 * Clients send intents only: "bid", "clerk:open", "clerk:close", "clerk:next",
 * "clerk:pause", "clerk:resume". Every intent is acknowledged with {ok, reason?}.
 */
import type { Server as HttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Server, type Socket } from "socket.io";
import { clerkView, paddleView, publicView, type AuctionState, type Command, type EngineEvent, type EngineEventType } from "../engine";
import { nightSummary, publicCaptures, roomCaptures, roomReleases, rowAs, type BidderRow } from "../db/db";
import type { RoomManager } from "./rooms";

export type Role = "stage" | "paddle" | "clerk";

interface SocketData {
  room: string;
  role: Role;
  bidderId: string | null;
}

const PUBLIC_EVENTS: ReadonlySet<EngineEventType> = new Set([
  "bidder_joined", "lot_opened", "bid_accepted", "soft_close_extended", "lull", "going_once",
  "going_twice", "back_to_open", "lot_sold", "lot_passed", "lot_advanced", "lot_added", "paused", "resumed",
]);
const PRIVATE_KEYS = new Set(["holdCents", "bidderId"]);

function publicEvents(events: EngineEvent[]): EngineEvent[] {
  return events
    .filter((e) => PUBLIC_EVENTS.has(e.type))
    .map((e) => ({ ...e, data: Object.fromEntries(Object.entries(e.data).filter(([k]) => !PRIVATE_KEYS.has(k))) }));
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Payment rows for the clerk (never includes the bidder's secret token). */
export function clerkPayments(rooms: RoomManager, roomId: string) {
  const rows = rooms.db
    .prepare("SELECT * FROM bidders WHERE room_id = ? ORDER BY created_at")
    .all(roomId) as unknown as BidderRow[];
  return rows.map(({ token: _token, ...r }) => r);
}

export interface RealtimeOptions {
  lastLine?: (roomId: string) => unknown;
  voicePlan?: (roomId: string) => unknown;
  /** End of the night (M9). */
  closeNight?: (roomId: string) => Promise<{ ok: boolean; reason?: string }>;
  myRelease?: (bidderId: string) => { status: string; held_cents: number; won_cents: number } | null;
  /** "Ask the clerk": the AI agent with read-only PayPal tools. */
  askClerk?: (roomId: string, question: string) => Promise<unknown>;
  /** AI lot writer: a draft from a rough note (nothing is added). */
  draftLot?: (note: string) => Promise<unknown>;
  /** Add an approved lot. */
  addLot?: (roomId: string, lot: { title: unknown; story: unknown; startCents: unknown; incrementCents: unknown }) => { ok: boolean; reason?: string };
  /** A big screen opened this room (the auctioneer warms its lines). */
  onStageJoin?: (roomId: string) => void;
}

/** End-of-night summary for every screen; null while the night is on. */
function nightFor(rooms: RoomManager, roomId: string, state: AuctionState) {
  const sold = state.lots.filter((l) => l.status === "sold");
  return nightSummary(rooms.db, roomId, sold.reduce((s, l) => s + (l.hammerCents ?? 0), 0), sold.length);
}

export function attachRealtime(httpServer: HttpServer, rooms: RoomManager, opts: RealtimeOptions = {}) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    serveClient: false,
    // Let Next's dev HMR websocket through instead of destroying it.
    destroyUpgrade: false,
    connectionStateRecovery: { maxDisconnectionDuration: 60_000 },
  });

  const keyFor = (room: string) => `room:${room}`;

  function snapshotFor(s: Socket) {
    const d = s.data as SocketData;
    const engine = rooms.get(d.room);
    if (!engine) return null;
    const captures = publicCaptures(rooms.db, d.room);
    const host = opts.lastLine?.(d.room) ?? null;
    const night = nightFor(rooms, d.room, engine.state);
    if (d.role === "clerk")
      return {
        role: "clerk",
        ...clerkView(engine.state),
        payments: clerkPayments(rooms, d.room),
        captures,
        captureRows: roomCaptures(rooms.db, d.room),
        releases: roomReleases(rooms.db, d.room),
        night,
        host,
      };
    if (d.role === "paddle") {
      const row = d.bidderId ? rooms.db.prepare("SELECT status, error FROM bidders WHERE id = ?").get(d.bidderId) : undefined;
      const join = rowAs<{ status: string; error: string | null }>(row) ?? null;
      const r = d.bidderId ? (opts.myRelease?.(d.bidderId) ?? null) : null;
      const myRelease = r ? { status: r.status, heldCents: r.held_cents, wonCents: r.won_cents } : null;
      return { role: "paddle", ...paddleView(engine.state, d.bidderId && engine.state.bidders[d.bidderId] ? d.bidderId : null), join, captures, night, myRelease, host };
    }
    return { role: "stage", ...publicView(engine.state), captures, night, host, voicePlan: opts.voicePlan?.(d.room) ?? null };
  }

  async function broadcast(roomId: string, events: EngineEvent[]) {
    const sockets = await io.in(keyFor(roomId)).fetchSockets();
    const pub = publicEvents(events);
    for (const s of sockets) {
      const sock = io.sockets.sockets.get(s.id);
      if (!sock) continue;
      sock.emit("state", snapshotFor(sock));
      const evs = (sock.data as SocketData).role === "clerk" ? events : pub;
      if (evs.length) sock.emit("events", evs);
    }
  }

  // Remember each room's latest broadcast so an auctioneer line about a change never overtakes the state it describes.
  const lastBroadcast = new Map<string, Promise<void>>();
  rooms.onChange((roomId, events) => {
    lastBroadcast.set(roomId, broadcast(roomId, events).catch(() => undefined));
  });

  io.use((socket, next) => {
    const a = socket.handshake.auth as { room?: unknown; role?: unknown; key?: unknown; token?: unknown };
    const room = typeof a.room === "string" ? a.room : "";
    const role = a.role === "clerk" || a.role === "paddle" || a.role === "stage" ? a.role : null;
    if (!room || !role || !rooms.get(room)) return next(new Error("unknown_room"));
    if (role === "clerk") {
      const expected = rooms.clerkToken(room);
      if (!expected || typeof a.key !== "string" || !safeEqual(a.key, expected)) return next(new Error("clerk_key_required"));
    }
    let bidderId: string | null = null;
    if (role === "paddle" && typeof a.token === "string" && a.token.length <= 100) {
      const row = rowAs<{ id: string }>(rooms.db.prepare("SELECT id FROM bidders WHERE token = ? AND room_id = ?").get(a.token, room));
      bidderId = row?.id ?? null;
    }
    socket.data = { room, role, bidderId };
    next();
  });

  io.on("connection", (socket) => {
    const d = socket.data as SocketData;
    void socket.join(keyFor(d.room));
    // Reconnecting clients always get the full current state.
    socket.emit("state", snapshotFor(socket));
    if (d.role === "stage") opts.onStageJoin?.(d.room);

    type Ack = (r: { ok: boolean; reason?: string }) => void;
    const ackOf = (x: unknown): Ack => (typeof x === "function" ? (x as Ack) : () => {});

    socket.on("bid", (payload: unknown, ack: unknown) => {
      const p = (payload ?? {}) as { lotId?: unknown; amountCents?: unknown };
      if (d.role !== "paddle" || !d.bidderId) return ackOf(ack)({ ok: false, reason: "not_a_bidder" });
      if (typeof p.lotId !== "string" || typeof p.amountCents !== "number") return ackOf(ack)({ ok: false, reason: "invalid_amount" });
      const r = rooms.dispatch(d.room, { type: "bid", bidderId: d.bidderId, lotId: p.lotId, amountCents: p.amountCents });
      ackOf(ack)({ ok: r.ok, reason: r.reason });
    });

    const clerkCmd = (name: string, cmd: Command) =>
      socket.on(name, (_p: unknown, ack: unknown) => {
        if (d.role !== "clerk") return ackOf(ack)({ ok: false, reason: "forbidden" });
        const r = rooms.dispatch(d.room, cmd);
        ackOf(ack)({ ok: r.ok, reason: r.reason });
      });
    clerkCmd("clerk:open", { type: "open_lot" });
    clerkCmd("clerk:close", { type: "close_lot" });
    clerkCmd("clerk:next", { type: "next_lot" });
    clerkCmd("clerk:pause", { type: "pause" });
    clerkCmd("clerk:resume", { type: "resume" });
    socket.on("clerk:ask", async (p: unknown, ack: unknown) => {
      if (d.role !== "clerk") return ackOf(ack)({ ok: false, reason: "forbidden" });
      const q = typeof (p as { question?: unknown })?.question === "string" ? (p as { question: string }).question : "";
      const r = opts.askClerk ? await opts.askClerk(d.room, q) : { ok: false, answer: "Not available." };
      (typeof ack === "function" ? ack : () => {})(r);
    });
    socket.on("clerk:draft-lot", async (p: unknown, ack: unknown) => {
      if (d.role !== "clerk") return ackOf(ack)({ ok: false, reason: "forbidden" });
      const note = typeof (p as { note?: unknown })?.note === "string" ? (p as { note: string }).note : "";
      const draft = opts.draftLot ? await opts.draftLot(note) : null;
      (typeof ack === "function" ? ack : () => {})(draft ? { ok: true, draft } : { ok: false, reason: "no_draft" });
    });
    socket.on("clerk:add-lot", (p: unknown, ack: unknown) => {
      if (d.role !== "clerk") return ackOf(ack)({ ok: false, reason: "forbidden" });
      const b = (p ?? {}) as { title?: unknown; story?: unknown; startCents?: unknown; incrementCents?: unknown };
      ackOf(ack)(opts.addLot ? opts.addLot(d.room, { title: b.title, story: b.story, startCents: b.startCents, incrementCents: b.incrementCents }) : { ok: false, reason: "unavailable" });
    });
    socket.on("clerk:close-night", async (_p: unknown, ack: unknown) => {
      if (d.role !== "clerk") return ackOf(ack)({ ok: false, reason: "forbidden" });
      if (!opts.closeNight) return ackOf(ack)({ ok: false, reason: "unavailable" });
      const r = await opts.closeNight(d.room);
      ackOf(ack)({ ok: r.ok, reason: r.reason });
    });
  });

  /** Push a fresh snapshot without an engine change (e.g. a hold status moved). */
  const refresh = (roomId: string) => void broadcast(roomId, []);

  /** An auctioneer line, to every screen in the room (AUCTIONEER.md: captions match what is spoken). */
  const sayLine = (roomId: string, line: unknown) =>
    void (lastBroadcast.get(roomId) ?? Promise.resolve()).then(() => io.to(keyFor(roomId)).emit("host", line));

  return { io, refresh, sayLine };
}
