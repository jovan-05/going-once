/**
 * M4 logic against a scripted fake PayPal (the real sandbox run is manual —
 * see docs/BUILD_PLAN.md M4 checks). Verifies idempotency, re-read on lost
 * responses, and that a paddle appears only after a real authorization.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, getBidder, type DB } from "../db/db";
import { DEMO_LOTS } from "../db/seed-data";
import { PayPalError, type PayPalClient } from "../paypal/client";
import { HoldService } from "./holds";
import { RoomManager } from "./rooms";

interface Call {
  method: string;
  path: string;
  requestId?: string;
  opRecordedBeforeCall: boolean;
  body?: unknown;
}

class FakePayPal {
  calls: Call[] = [];
  orderStatus = "PAYER_ACTION_REQUIRED";
  authorized = false;
  /** Make the next authorize throw this, once. */
  authorizeFailure: PayPalError | null = null;
  rejectDonation = false;

  constructor(private db: DB) {}

  private order() {
    return {
      id: "ORDER-1",
      status: this.authorized ? "COMPLETED" : this.orderStatus,
      links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1" }],
      purchase_units: [
        {
          payments: this.authorized
            ? { authorizations: [{ id: "AUTH-1", status: "CREATED", amount: { currency_code: "USD", value: "250.00" } }] }
            : undefined,
        },
      ],
    };
  }

  async request<T>(method: string, path: string, opts: { body?: unknown; requestId?: string } = {}) {
    const recorded = opts.requestId ? !!this.db.prepare("SELECT 1 FROM paypal_ops WHERE request_id = ?").get(opts.requestId) : false;
    this.calls.push({ method, path, requestId: opts.requestId, opRecordedBeforeCall: recorded, body: opts.body });
    const ok = (data: unknown) => ({ status: 200, data: data as T, debugId: "dbg" });

    if (method === "POST" && path === "/v2/checkout/orders") {
      const cat = (opts.body as any).purchase_units[0].items[0].category; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (this.rejectDonation && cat === "DONATION")
        throw new PayPalError(422, method, path, "UNPROCESSABLE_ENTITY", "nope", [{ issue: "INVALID_PARAMETER_VALUE" }], "dbg1");
      return ok(this.order());
    }
    if (method === "GET" && path === "/v2/checkout/orders/ORDER-1") return ok(this.order());
    if (method === "POST" && path === "/v2/checkout/orders/ORDER-1/authorize") {
      if (this.authorizeFailure) {
        const e = this.authorizeFailure;
        this.authorizeFailure = null;
        throw e;
      }
      this.authorized = true;
      return ok(this.order());
    }
    throw new Error(`unexpected ${method} ${path}`);
  }
}

let db: DB;
let rooms: RoomManager;
let pp: FakePayPal;
let holds: HoldService;
let changes: string[];

beforeEach(() => {
  db = openDb(":memory:");
  rooms = new RoomManager(db);
  rooms.createRoom({ id: "gala", name: "Gala", isDemo: false, lots: DEMO_LOTS });
  pp = new FakePayPal(db);
  changes = [];
  holds = new HoldService({
    db,
    rooms,
    paypal: pp as unknown as PayPalClient,
    publicBaseUrl: "http://localhost:3000",
    onChange: (r) => changes.push(r),
    log: () => {},
  });
});

const join = () => holds.start("gala", { name: "  Asha\u0000 Rao ", showName: true, limitCents: 250_00 });

describe("join and hold", () => {
  it("creates a $ hold order with the request id stored first, and returns the approval link", async () => {
    const r = await join();
    expect(r.approveUrl).toContain("checkoutnow");
    const create = pp.calls[0]!;
    expect(create).toMatchObject({ method: "POST", path: "/v2/checkout/orders", opRecordedBeforeCall: true });
    const body = create.body as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body.intent).toBe("AUTHORIZE");
    expect(body.purchase_units[0].amount.value).toBe("250.00");
    expect(body.purchase_units[0].custom_id).toBe(r.bidderId);
    expect(body.payment_source.paypal.experience_context.return_url).toBe(`http://localhost:3000/join/gala/return?b=${r.bidderId}`);
    const row = getBidder(db, r.bidderId)!;
    expect(row).toMatchObject({ status: "awaiting_approval", order_id: "ORDER-1", name: "Asha Rao", show_name: 1, item_category: "DONATION" });
    expect(rooms.get("gala")!.state.bidders[r.bidderId]).toBeUndefined(); // no paddle before authorization
  });

  it("falls back to DIGITAL_GOODS when PayPal refuses DONATION, with a new request id", async () => {
    pp.rejectDonation = true;
    const r = await join();
    expect(pp.calls.map((c) => c.requestId)).toEqual([`create_order:${r.bidderId}:DONATION`, `create_order:${r.bidderId}:DIGITAL_GOODS`]);
    expect(getBidder(db, r.bidderId)!.item_category).toBe("DIGITAL_GOODS");
  });

  it("does nothing until the buyer approves; then authorizes once and assigns a paddle", async () => {
    const r = await join();
    await holds.reconcile(r.bidderId);
    expect(pp.calls.filter((c) => c.path.endsWith("/authorize"))).toHaveLength(0);
    expect(getBidder(db, r.bidderId)!.status).toBe("awaiting_approval");

    pp.orderStatus = "APPROVED";
    // webhook, poller and return page all fire at once → one authorize call
    await Promise.all([holds.reconcile(r.bidderId), holds.reconcile(r.bidderId), holds.reconcile(r.bidderId)]);
    const auths = pp.calls.filter((c) => c.path.endsWith("/authorize"));
    expect(auths).toHaveLength(1);
    expect(auths[0]).toMatchObject({ requestId: `authorize:${r.bidderId}`, opRecordedBeforeCall: true });

    const row = getBidder(db, r.bidderId)!;
    expect(row).toMatchObject({ status: "active", auth_id: "AUTH-1", auth_status: "CREATED", authorized_cents: 250_00 });
    const bidder = rooms.get("gala")!.state.bidders[r.bidderId]!;
    expect(bidder).toMatchObject({ paddle: 1, holdCents: 250_00, simulatedHold: false, isBot: false });
    expect(holds.statusByToken("gala", r.token)).toMatchObject({ status: "active", paddle: 1, holdCents: 250_00 });
    expect(changes).toContain("gala");

    // later reconciles are no-ops
    const n = pp.calls.length;
    await holds.reconcile(r.bidderId);
    expect(pp.calls.length).toBe(n);
  });

  it("a lost authorize response is resolved by re-reading the order, never a new request", async () => {
    const r = await join();
    pp.orderStatus = "APPROVED";
    pp.authorized = false;
    // first attempt: PayPal actually authorized, but we only saw a 5xx-style failure
    pp.authorizeFailure = new PayPalError(503, "POST", "/authorize", "SERVICE_UNAVAILABLE", "", [], "dbg");
    await expect(holds.reconcile(r.bidderId)).rejects.toThrow();
    pp.authorized = true; // PayPal's truth
    await holds.reconcile(r.bidderId);
    const authCalls = pp.calls.filter((c) => c.path.endsWith("/authorize"));
    expect(authCalls).toHaveLength(1); // re-read found the authorization; no second authorize
    expect(getBidder(db, r.bidderId)!.status).toBe("active");
  });

  it("ORDER_ALREADY_AUTHORIZED → re-read and continue", async () => {
    const r = await join();
    pp.orderStatus = "APPROVED";
    pp.authorizeFailure = new PayPalError(422, "POST", "/authorize", "UNPROCESSABLE_ENTITY", "", [{ issue: "ORDER_ALREADY_AUTHORIZED" }], "dbg");
    // PayPal has it authorized server-side even though our call errored
    const origGet = pp.request.bind(pp);
    pp.request = (async (m: string, p: string, o?: object) => {
      if (m === "POST" && p.endsWith("/authorize")) {
        const res = origGet(m, p, o);
        pp.authorized = true;
        return res;
      }
      return origGet(m, p, o);
    }) as typeof pp.request;
    await holds.reconcile(r.bidderId);
    expect(getBidder(db, r.bidderId)).toMatchObject({ status: "active", auth_id: "AUTH-1" });
  });

  it("INSTRUMENT_DECLINED shows a clear message and no paddle", async () => {
    const r = await join();
    pp.orderStatus = "APPROVED";
    pp.authorizeFailure = new PayPalError(422, "POST", "/authorize", "UNPROCESSABLE_ENTITY", "", [{ issue: "INSTRUMENT_DECLINED" }], "dbg");
    await holds.reconcile(r.bidderId);
    const row = getBidder(db, r.bidderId)!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/declined/);
    expect(rooms.get("gala")!.state.bidders[r.bidderId]).toBeUndefined();
  });

  it("validates input", async () => {
    await expect(holds.start("gala", { name: "", showName: true, limitCents: 100_00 })).rejects.toMatchObject({ code: "name_required" });
    await expect(holds.start("gala", { name: "A", showName: true, limitCents: 5_00 })).rejects.toMatchObject({ code: "invalid_limit" });
    await expect(holds.start("gala", { name: "A", showName: true, limitCents: 10_000_00 })).rejects.toMatchObject({ code: "invalid_limit" });
    await expect(holds.start("nope", { name: "A", showName: true, limitCents: 100_00 })).rejects.toMatchObject({ code: "unknown_room" });
    expect(pp.calls).toHaveLength(0);
  });

  it("refuses to join without PayPal configured", async () => {
    const h = new HoldService({ db, rooms, paypal: null, publicBaseUrl: "x", onChange: () => {}, log: () => {} });
    await expect(h.start("gala", { name: "A", showName: true, limitCents: 100_00 })).rejects.toMatchObject({ code: "paypal_not_configured" });
  });

  it("test bidders exist only in demo rooms (rule 6)", () => {
    expect(() => holds.addTestBidder("gala", "T", 100_00)).toThrow(/demo/);
  });
});
