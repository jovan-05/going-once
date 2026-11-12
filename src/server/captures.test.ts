import { beforeEach, describe, expect, it } from "vitest";
import { openDb, publicCaptures, rowAs, type CaptureRow, type DB } from "../db/db";
import { DEMO_LOTS } from "../db/seed-data";
import { PayPalError, type PayPalClient } from "../paypal/client";
import { CaptureService, captureRequestId, invoiceIdFor } from "./captures";
import { RoomManager } from "./rooms";

interface Call {
  method: string;
  path: string;
  requestId?: string;
  body?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rowExisted: boolean;
}

class FakePayPal {
  calls: Call[] = [];
  /** captures PayPal "really" made, by invoice id */
  made = new Map<string, { id: string; status: string; invoice_id: string }>();
  nextStatus = "COMPLETED";
  failNext: { err: PayPalError; butCapture: boolean } | null = null;
  n = 0;
  constructor(private db: DB) {}

  async request<T>(method: string, path: string, opts: { body?: any; requestId?: string } = {}) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const rowExisted = !!(opts.requestId && this.db.prepare("SELECT 1 FROM captures WHERE request_id = ?").get(opts.requestId));
    this.calls.push({ method, path, requestId: opts.requestId, body: opts.body, rowExisted });
    const ok = (data: unknown) => ({ status: 201, data: data as T, debugId: "d" });
    if (method === "POST" && /\/v2\/payments\/authorizations\/AUTH-\w+\/capture$/.test(path)) {
      const inv = opts.body.invoice_id as string;
      if (this.failNext) {
        const f = this.failNext;
        this.failNext = null;
        if (f.butCapture) this.made.set(inv, { id: `CAP-${++this.n}`, status: this.nextStatus, invoice_id: inv });
        throw f.err;
      }
      const existing = this.made.get(inv);
      const cap = existing ?? { id: `CAP-${++this.n}`, status: this.nextStatus, invoice_id: inv };
      this.made.set(inv, cap);
      return ok(cap);
    }
    if (method === "GET" && path.startsWith("/v2/checkout/orders/")) {
      return ok({ id: "ORDER-A", status: "COMPLETED", purchase_units: [{ payments: { captures: [...this.made.values()] } }] });
    }
    if (method === "GET" && path.startsWith("/v2/payments/captures/")) {
      const id = path.split("/").pop();
      const c = [...this.made.values()].find((x) => x.id === id);
      return ok(c);
    }
    throw new Error(`unexpected ${method} ${path}`);
  }
}

let db: DB;
let rooms: RoomManager;
let pp: FakePayPal;
let svc: CaptureService;
let changes: number;

function addRealBidder(roomId: string, id: string, holdCents: number) {
  const t = Date.now();
  db.prepare(
    "INSERT INTO bidders (id, room_id, token, name, show_name, limit_cents, status, order_id, auth_id, auth_status, authorized_cents, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, 'active', 'ORDER-A', ?, 'CREATED', ?, ?, ?)",
  ).run(id, roomId, `tok-${id}`, "Asha", holdCents, `AUTH-${id.replace(/\W/g, "")}`, holdCents, t, t);
  rooms.dispatch(roomId, { type: "add_bidder", bidder: { id, name: "Asha", showName: true, holdCents } });
}

async function sell(roomId: string, bidderId: string, amountCents: number) {
  const e = rooms.get(roomId)!;
  if (e.currentLot!.status !== "waiting") rooms.dispatch(roomId, { type: "next_lot" });
  rooms.dispatch(roomId, { type: "open_lot" });
  rooms.dispatch(roomId, { type: "bid", bidderId, lotId: e.currentLot!.id, amountCents });
  rooms.dispatch(roomId, { type: "close_lot" });
  await new Promise((r) => setTimeout(r, 10));
  return e.state.lots[e.state.currentLotIndex]!.id;
}

const row = (id: string) => rowAs<CaptureRow>(db.prepare("SELECT * FROM captures WHERE id = ?").get(id))!;
const captureCalls = () => pp.calls.filter((c) => c.method === "POST");

beforeEach(() => {
  db = openDb(":memory:");
  rooms = new RoomManager(db);
  rooms.createRoom({ id: "gala", name: "Gala", isDemo: false, lots: DEMO_LOTS });
  pp = new FakePayPal(db);
  changes = 0;
  svc = new CaptureService({ db, rooms, paypal: pp as unknown as PayPalClient, onChange: () => changes++, log: () => {} });
  rooms.onChange((roomId, events) => svc.handleEvents(roomId, events));
});

describe("capture on sold", () => {
  it("captures exactly the hammer price, final_capture false, request id stored first", async () => {
    addRealBidder("gala", "bidder-aaaa1111", 300_00);
    const lotId = await sell("gala", "bidder-aaaa1111", 200_00);
    const [call] = captureCalls();
    expect(captureCalls()).toHaveLength(1);
    expect(call).toMatchObject({
      path: "/v2/payments/authorizations/AUTH-bidderaaaa1111/capture",
      requestId: captureRequestId("gala", lotId, "bidder-aaaa1111"),
      rowExisted: true,
    });
    expect(call!.body).toEqual({ amount: { currency_code: "USD", value: "200.00" }, final_capture: false, invoice_id: invoiceIdFor("gala", lotId, "bidder-aaaa1111") });
    expect(row(`gala:${lotId}`)).toMatchObject({ status: "COMPLETED", capture_id: "CAP-1", amount_cents: 200_00 });
    expect(publicCaptures(db, "gala")[lotId]).toEqual({ lotId, status: "captured", captureId: "CAP-1", amountCents: 200_00 });
    expect(changes).toBeGreaterThan(0);
  });

  it("one bidder winning two lots gets two captures with distinct invoice ids", async () => {
    addRealBidder("gala", "bidder-aaaa1111", 300_00);
    const a = await sell("gala", "bidder-aaaa1111", 200_00);
    const b = await sell("gala", "bidder-aaaa1111", 60_00);
    const calls = captureCalls();
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.body.invoice_id)).size).toBe(2);
    expect(row(`gala:${a}`).capture_id).toBe("CAP-1");
    expect(row(`gala:${b}`).capture_id).toBe("CAP-2");
  });

  it("a lost response is resolved by re-reading the order, not by a second capture", async () => {
    addRealBidder("gala", "bidder-aaaa1111", 300_00);
    pp.failNext = { err: new PayPalError(503, "POST", "/capture", "SERVICE_UNAVAILABLE", "", [], "d"), butCapture: true };
    const lotId = await sell("gala", "bidder-aaaa1111", 200_00);
    expect(captureCalls()).toHaveLength(1);
    expect(pp.calls.some((c) => c.method === "GET" && c.path.startsWith("/v2/checkout/orders/"))).toBe(true);
    expect(row(`gala:${lotId}`)).toMatchObject({ status: "COMPLETED", capture_id: "CAP-1" });
  });

  it("if PayPal has no capture after a lost response, the retry reuses the same request id", async () => {
    addRealBidder("gala", "bidder-aaaa1111", 300_00);
    pp.failNext = { err: new PayPalError(503, "POST", "/capture", "SERVICE_UNAVAILABLE", "", [], "d"), butCapture: false };
    const lotId = await sell("gala", "bidder-aaaa1111", 200_00);
    expect(row(`gala:${lotId}`).status).toBe("capturing"); // never shown as Sold
    expect(publicCaptures(db, "gala")[lotId]!.status).toBe("capturing");
    await svc.captureLot("gala", lotId, "bidder-aaaa1111", 200_00); // what the poller does
    const calls = captureCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.requestId).toBe(calls[1]!.requestId);
    expect(row(`gala:${lotId}`).status).toBe("COMPLETED");
  });

  it("PENDING stays pending until PayPal reports COMPLETED", async () => {
    addRealBidder("gala", "bidder-aaaa1111", 300_00);
    pp.nextStatus = "PENDING";
    const lotId = await sell("gala", "bidder-aaaa1111", 200_00);
    expect(publicCaptures(db, "gala")[lotId]!.status).toBe("pending");
    [...pp.made.values()][0]!.status = "COMPLETED";
    await svc.refreshByCaptureId("CAP-1");
    expect(publicCaptures(db, "gala")[lotId]!.status).toBe("captured");
  });

  it("a declined capture needs attention", async () => {
    addRealBidder("gala", "bidder-aaaa1111", 300_00);
    pp.failNext = { err: new PayPalError(422, "POST", "/capture", "UNPROCESSABLE_ENTITY", "", [{ issue: "INSTRUMENT_DECLINED" }], "d"), butCapture: false };
    const lotId = await sell("gala", "bidder-aaaa1111", 200_00);
    expect(row(`gala:${lotId}`).status).toBe("DECLINED");
    expect(publicCaptures(db, "gala")[lotId]!.status).toBe("attention");
  });

  it("the same lot is never captured twice, even if lot_sold is replayed", async () => {
    addRealBidder("gala", "bidder-aaaa1111", 300_00);
    const lotId = await sell("gala", "bidder-aaaa1111", 200_00);
    await svc.captureLot("gala", lotId, "bidder-aaaa1111", 200_00);
    await Promise.all([svc.captureLot("gala", lotId, "bidder-aaaa1111", 200_00), svc.captureLot("gala", lotId, "bidder-aaaa1111", 200_00)]);
    expect(captureCalls()).toHaveLength(1);
  });

  it("on restart, a sold lot with no capture row is captured once", async () => {
    addRealBidder("gala", "bidder-aaaa1111", 300_00);
    const other = new RoomManager(db); // engine events not wired → simulates a crash before the capture row
    const e = other.get("gala")!;
    other.dispatch("gala", { type: "open_lot" });
    other.dispatch("gala", { type: "bid", bidderId: "bidder-aaaa1111", lotId: e.currentLot!.id, amountCents: 200_00 });
    other.dispatch("gala", { type: "close_lot" });
    const fresh = new CaptureService({ db, rooms: new RoomManager(db), paypal: pp as unknown as PayPalClient, onChange: () => {}, log: () => {} });
    fresh.resumeMissing();
    await new Promise((r) => setTimeout(r, 10));
    fresh.resumeMissing(); // second boot: nothing new
    await new Promise((r) => setTimeout(r, 10));
    expect(captureCalls()).toHaveLength(1);
    expect(row("gala:tea-estate").status).toBe("COMPLETED");
  });

  it("simulated holds (demo rooms) never call PayPal and are labelled", async () => {
    rooms.createRoom({ id: "demo", name: "Demo", isDemo: true, lots: DEMO_LOTS });
    rooms.dispatch("demo", { type: "add_bidder", bidder: { id: "bot1", name: "Bot", showName: true, holdCents: 500_00, isBot: true } });
    const lotId = await sell("demo", "bot1", 200_00);
    expect(pp.calls).toHaveLength(0);
    expect(publicCaptures(db, "demo")[lotId]).toMatchObject({ status: "simulated", captureId: null });
  });
});
