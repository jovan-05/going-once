import { beforeEach, describe, expect, it } from "vitest";
import { openDb, roomReleases, type DB } from "../db/db";
import { DEMO_LOTS } from "../db/seed-data";
import { PayPalError, type PayPalClient } from "../paypal/client";
import { CloseService, voidRequestId } from "./close";
import { RoomManager } from "./rooms";

/** Authorizations as PayPal "really" holds them. */
class FakePayPal {
  auths = new Map<string, string>();
  calls: { method: string; path: string; requestId?: string; rowExisted: boolean }[] = [];
  /** Next void: throw after (or instead of) voiding. */
  failNext: { status: number; butVoid: boolean } | null = null;
  constructor(private db: DB) {}

  async request<T>(method: string, path: string, opts: { requestId?: string } = {}) {
    const rowExisted = !!(opts.requestId && this.db.prepare("SELECT 1 FROM paypal_ops WHERE request_id = ? AND kind = 'void'").get(opts.requestId));
    this.calls.push({ method, path, requestId: opts.requestId, rowExisted });
    const id = decodeURIComponent(path.split("/")[4]!);
    if (method === "GET") return { status: 200, data: { id, status: this.auths.get(id) ?? "CREATED" } as T, debugId: "d" };
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      if (f.butVoid) this.auths.set(id, "VOIDED");
      throw new PayPalError(f.status, method, path, "INTERNAL_SERVER_ERROR", "boom", [], "dbg");
    }
    if (this.auths.get(id) === "VOIDED") throw new PayPalError(422, method, path, "UNPROCESSABLE_ENTITY", "voided", [{ issue: "AUTHORIZATION_ALREADY_VOIDED" }], "dbg");
    this.auths.set(id, "VOIDED");
    return { status: 200, data: { id, status: "VOIDED" } as T, debugId: "d" };
  }
}

let db: DB;
let rooms: RoomManager;
let pp: FakePayPal;
let settled = true;
let svc: CloseService;
const ROOM = "night";

function addBidder(id: string, opts: { authId?: string; simulated?: boolean; hold?: number } = {}) {
  const hold = opts.hold ?? 300_00;
  const t = Date.now();
  db.prepare(
    "INSERT INTO bidders (id, room_id, token, name, show_name, limit_cents, status, simulated, auth_id, auth_status, authorized_cents, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, 'active', ?, ?, ?, ?, ?, ?)",
  ).run(id, ROOM, `tok-${id}`, id, hold, opts.simulated ? 1 : 0, opts.authId ?? null, opts.authId ? "CREATED" : null, hold, t, t);
  rooms.dispatch(ROOM, { type: "add_bidder", bidder: { id, name: id, showName: true, holdCents: hold, simulatedHold: !!opts.simulated } });
}

beforeEach(() => {
  db = openDb(":memory:");
  rooms = new RoomManager(db);
  rooms.createRoom({ id: ROOM, name: "Night", isDemo: true, lots: DEMO_LOTS });
  pp = new FakePayPal(db);
  settled = true;
  svc = new CloseService({ db, rooms, paypal: pp as unknown as PayPalClient, captures: { settled: () => settled }, onChange: () => {}, log: () => {} });
});

describe("closing the night", () => {
  it("voids every open hold once, with the request id stored first, and records PayPal's status", async () => {
    addBidder("asha", { authId: "AUTH-A" });
    addBidder("ben", { authId: "AUTH-B" });
    addBidder("test", { simulated: true });
    pp.auths.set("AUTH-B", "PARTIALLY_CAPTURED"); // won a lot earlier: void releases the rest

    const r = await svc.closeNight(ROOM);
    expect(r).toEqual({ ok: true, released: 3, attention: 0 });
    const voids = pp.calls.filter((c) => c.method === "POST");
    expect(voids.map((c) => c.path).sort()).toEqual(["/v2/payments/authorizations/AUTH-A/void", "/v2/payments/authorizations/AUTH-B/void"]);
    expect(voids.every((c) => c.rowExisted)).toBe(true);
    expect(voids.find((c) => c.path.includes("AUTH-A"))?.requestId).toBe(voidRequestId("AUTH-A"));
    const rows = Object.fromEntries(roomReleases(db, ROOM).map((x) => [x.bidder_id, x.status]));
    expect(rows).toEqual({ asha: "VOIDED", ben: "VOIDED", test: "simulated" });

    // Closing again sends nothing new.
    const before = pp.calls.length;
    await svc.closeNight(ROOM);
    expect(pp.calls.filter((c) => c.method === "POST").length).toBe(2);
    expect(pp.calls.length).toBe(before);
  });

  it("after a lost response, trusts PayPal's record instead of sending a new void", async () => {
    addBidder("asha", { authId: "AUTH-A" });
    pp.failNext = { status: 500, butVoid: true };
    const r = await svc.closeNight(ROOM);
    expect(r.ok && r.attention).toBe(0);
    expect(roomReleases(db, ROOM)[0]!.status).toBe("VOIDED");
    expect(pp.calls.filter((c) => c.method === "POST").length).toBe(1);
  });

  it("marks a hold that couldn't be released for attention, and retries it with the same request id", async () => {
    addBidder("asha", { authId: "AUTH-A" });
    pp.failNext = { status: 500, butVoid: false };
    const r1 = await svc.closeNight(ROOM);
    expect(r1).toEqual({ ok: true, released: 0, attention: 1 });
    expect(roomReleases(db, ROOM)[0]!.status).toBe("failed");
    const r2 = await svc.closeNight(ROOM);
    expect(r2).toEqual({ ok: true, released: 1, attention: 0 });
    const ids = pp.calls.filter((c) => c.method === "POST").map((c) => c.requestId);
    expect(ids).toEqual([voidRequestId("AUTH-A"), voidRequestId("AUTH-A")]);
  });

  it("skips a hold PayPal already finished (fully captured)", async () => {
    addBidder("asha", { authId: "AUTH-A" });
    pp.auths.set("AUTH-A", "CAPTURED");
    await svc.closeNight(ROOM);
    expect(roomReleases(db, ROOM)[0]!.status).toBe("CAPTURED");
    expect(pp.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("refuses while a lot is live or a capture is in flight", async () => {
    addBidder("asha", { authId: "AUTH-A" });
    rooms.dispatch(ROOM, { type: "open_lot" });
    expect(await svc.closeNight(ROOM)).toEqual({ ok: false, reason: "lot_live" });
    rooms.dispatch(ROOM, { type: "close_lot" });
    settled = false;
    expect(await svc.closeNight(ROOM)).toEqual({ ok: false, reason: "captures_in_flight" });
    expect(pp.calls.length).toBe(0);
    expect(rooms.isClosed(ROOM)).toBe(false);
  });

  it("after close, the room takes no new lots, bids or guests", async () => {
    addBidder("asha", { authId: "AUTH-A" });
    await svc.closeNight(ROOM);
    expect(rooms.dispatch(ROOM, { type: "open_lot" }).reason).toBe("night_closed");
    expect(rooms.dispatch(ROOM, { type: "next_lot" }).reason).toBe("night_closed");
    expect(rooms.dispatch(ROOM, { type: "add_bidder", bidder: { id: "late", name: "Late", showName: true, holdCents: 100_00, simulatedHold: true } }).reason).toBe("night_closed");
  });
});
