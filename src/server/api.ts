/**
 * Plain-Node API routes, handled before Next so they share the process (and
 * the RoomManager) with Socket.IO.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEMO_EVENT_NAME, DEMO_LOTS } from "../db/seed-data";
import { HoldService, JoinError } from "./holds";
import { CLOUD_VOICES, PREVIEW_LINES, type TtsService } from "../auctioneer/tts";
import type { DemoDirector } from "./bots";
import type { RoomManager } from "./rooms";

const MAX_BODY = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new JoinError("too_large", "Request too large", 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  try {
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    throw new JoinError("bad_json", "Malformed request");
  }
}

/** At most a few demo rooms per visitor in a short window, so /demo can't be used to fill the disk. */
const DEMO_WINDOW_MS = 10 * 60_000;
const DEMO_PER_WINDOW = 6;

export function createApi(deps: { rooms: RoomManager; holds: HoldService; allowTestBidders: boolean; demo?: DemoDirector; tts?: TtsService | null }) {
  const { rooms, holds } = deps;
  const demoStarts = new Map<string, number[]>();

  return async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/api/")) return false;
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true }), true;

      if (method === "POST" && url.pathname === "/api/paypal/webhook") {
        const raw = await readBody(req);
        const r = await holds.webhook(raw, req.headers);
        res.writeHead(r.status, { "Content-Type": "text/plain" }).end(r.body);
        return true;
      }

      // /api/rooms/:room
      if (parts[1] === "rooms" && parts[2]) {
        const roomId = parts[2];
        const engine = rooms.get(roomId);
        if (!engine) return send(res, 404, { ok: false, code: "unknown_room", message: "This auction room doesn't exist." }), true;

        if (method === "GET" && parts.length === 3) {
          return send(res, 200, { ok: true, id: engine.state.id, name: engine.state.name, isDemo: engine.state.isDemo, closed: rooms.isClosed(roomId), mode: rooms.mode(roomId) }), true;
        }
        if (method === "POST" && parts[3] === "join" && parts.length === 4) {
          if (rooms.isClosed(roomId)) return send(res, 409, { ok: false, code: "night_closed", message: "This auction has ended. Thank you for coming!" }), true;
          const b = await json(req);
          const r = await holds.start(roomId, { name: b.name, showName: b.showName, limitCents: b.limitCents });
          return send(res, 200, { ok: true, ...r }), true;
        }
        if (method === "POST" && parts[3] === "hold" && parts.length === 4) {
          const b = await json(req);
          const token = typeof b.token === "string" ? b.token : "";
          const before = holds.statusByToken(roomId, token);
          if (!before) return send(res, 404, { ok: false, code: "unknown_bidder", message: "We couldn't find your place in this room. Join again." }), true;
          if (b.reconcile === true) await holds.reconcile(before.bidderId).catch(() => undefined);
          return send(res, 200, { ok: true, ...holds.statusByToken(roomId, token) }), true;
        }
      }

      // The cloud voice: is it on, and which voices can /voices offer?
      if (method === "GET" && url.pathname === "/api/tts/info") {
        const t = deps.tts;
        return send(res, 200, { ok: true, enabled: !!t, label: t?.label ?? null, defaultVoice: t?.defaultVoice ?? null, voices: t ? CLOUD_VOICES : [], previewLines: PREVIEW_LINES }), true;
      }
      // Audio for one auctioneer line. Only lines the server said (see TtsService.allowed).
      if (method === "POST" && url.pathname === "/api/tts") {
        if (!deps.tts) return send(res, 404, { ok: false, code: "tts_off" }), true;
        const b = await json(req);
        const room = typeof b.room === "string" ? b.room.slice(0, 64) : "";
        const text = typeof b.text === "string" ? b.text : "";
        const wav = await deps.tts.audio(room, text, typeof b.voice === "string" ? b.voice : undefined);
        if (!wav) return send(res, 404, { ok: false, code: "no_audio" }), true;
        res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length, "Cache-Control": "private, max-age=3600" });
        res.end(wav);
        return true;
      }

      // Public: the sandbox test-buyer login for judges (sandbox only; set in .env, shown on /demo).
      if (method === "GET" && url.pathname === "/api/demo/info") {
        const email = process.env.DEMO_BUYER_EMAIL?.trim() || null;
        const password = process.env.DEMO_BUYER_PASSWORD?.trim() || null;
        return send(res, 200, { ok: true, buyer: email && password ? { email, password } : null }), true;
      }

      // Public: a fresh demo room with five labelled bots (DEMO.md). Never touches other rooms.
      if (method === "POST" && url.pathname === "/api/demo") {
        if (!deps.demo) return send(res, 404, { ok: false }), true;
        // Behind Render's proxy the socket address is the proxy; the client is the first X-Forwarded-For entry.
        const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
        const ip = (fwd || req.socket.remoteAddress || "?").replace(/^::ffff:/, "");
        const now = Date.now();
        const recent = (demoStarts.get(ip) ?? []).filter((t) => now - t < DEMO_WINDOW_MS);
        if (recent.length >= DEMO_PER_WINDOW)
          return send(res, 429, { ok: false, code: "slow_down", message: "You've started several demo rooms just now. Use one of those, or try again in a few minutes." }), true;
        demoStarts.set(ip, [...recent, now]);
        const id = `demo-${randomBytes(4).toString("hex")}`;
        const b = await json(req).catch(() => ({}) as Record<string, unknown>);
        const mode = b.mode === "online" ? "online" : "room";
        const { clerkToken } = rooms.createRoom({ id, name: DEMO_EVENT_NAME, isDemo: true, lots: DEMO_LOTS, mode });
        deps.demo.seedBots(id);
        return send(res, 200, { ok: true, id, clerkToken, mode }), true;
      }

      // Dev-only: a fresh scratch demo room (never in production).
      if (method === "POST" && url.pathname === "/api/dev/rooms") {
        if (!deps.allowTestBidders) return send(res, 404, { ok: false }), true;
        const b = await json(req);
        const id = typeof b.id === "string" && /^[a-z0-9-]{3,40}$/.test(b.id) ? b.id : `scratch-${Date.now().toString(36)}`;
        if (rooms.get(id)) return send(res, 409, { ok: false, code: "exists" }), true;
        const { clerkToken } = rooms.createRoom({ id, name: DEMO_EVENT_NAME, isDemo: true, lots: DEMO_LOTS });
        return send(res, 200, { ok: true, id, clerkToken }), true;
      }

      // Dev-only: simulated-hold test bidders in demo rooms (never in production).
      if (method === "POST" && parts[1] === "dev" && parts[2] === "rooms" && parts[3] && parts[4] === "test-bidder") {
        if (!deps.allowTestBidders) return send(res, 404, { ok: false }), true;
        const b = await json(req);
        const hold = typeof b.holdCents === "number" ? b.holdCents : 500_00;
        return send(res, 200, { ok: true, ...holds.addTestBidder(parts[3], typeof b.name === "string" ? b.name : "Tester", hold) }), true;
      }

      send(res, 404, { ok: false, code: "not_found" });
      return true;
    } catch (e) {
      if (e instanceof JoinError) return send(res, e.httpStatus, { ok: false, code: e.code, message: e.message }), true;
      console.error("[api]", e instanceof Error ? e.message : e);
      send(res, 500, { ok: false, code: "server_error", message: "Something went wrong on our side. Try again." });
      return true;
    }
  };
}
