/**
 * M4 — joining and the PayPal hold.
 *
 *   start()      create bidder row → record request id → create AUTHORIZE order → approve link
 *   reconcile()  re-read the order from PayPal; if APPROVED, authorize (idempotent);
 *                when PayPal reports an authorization, add the bidder to the engine.
 *   pollPending() 2-second fallback so nothing waits on webhooks or a tunnel.
 *   webhook()    verify signature → dedupe → treat as a hint → reconcile.
 *
 * The client's return from PayPal is only a hint too: money state always comes
 * from re-reading PayPal (PAYPAL.md "Never mark money as moved from a
 * client-side callback alone").
 */
import { randomBytes, randomUUID } from "node:crypto";
import { cleanName } from "../engine";
import { getBidder, rowAs, updateBidder, type BidderRow, type DB } from "../db/db";
import { PayPalError, findLink, type PayPalClient } from "../paypal/client";
import { authOf, getAuthorization, getOrder, holdOrderBody, toCents, type Authorization, type ItemCategory, type Order } from "../paypal/orders";
import type { RoomManager } from "./rooms";

export const LIMIT_MIN_CENTS = 10_00;
export const LIMIT_MAX_CENTS = 2_000_00;
const POLL_WINDOW_MS = 30 * 60_000;

export class JoinError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
  }
}

export interface HoldServiceDeps {
  db: DB;
  rooms: RoomManager;
  paypal: PayPalClient | null;
  publicBaseUrl: string;
  itemCategory?: ItemCategory;
  webhookId?: string;
  /** A bidder's hold status changed; push fresh snapshots. */
  onChange: (roomId: string) => void;
  log?: (msg: string) => void;
}

const paypalErrorSummary = (e: unknown) =>
  e instanceof PayPalError
    ? JSON.stringify({ status: e.status, name: e.paypalName, issues: e.issues, debug_id: e.debugId })
    : e instanceof Error
      ? e.message
      : String(e);

export class HoldService {
  private locks = new Map<string, Promise<BidderRow | undefined>>();
  private pollTimer: NodeJS.Timeout | null = null;
  private category: ItemCategory;
  /** Set by the app: re-read a capture from PayPal when a PAYMENT.CAPTURE.* webhook arrives. */
  captureHint?: (captureId: string) => Promise<void>;
  /** A hold approved after the night closed: release it (set by app.ts). */
  lateHold?: (roomId: string) => Promise<unknown>;

  constructor(private readonly d: HoldServiceDeps) {
    this.category = d.itemCategory ?? "DONATION";
  }

  private log(msg: string) {
    (this.d.log ?? console.log)(`[holds] ${msg}`);
  }

  // ---------- idempotency ledger (rule 3) ----------

  private recordOp(requestId: string, kind: string, roomId: string, bidderId: string, targetId: string | null) {
    const t = Date.now();
    this.d.db
      .prepare(
        "INSERT OR IGNORE INTO paypal_ops (request_id, kind, room_id, bidder_id, target_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'sent', ?, ?)",
      )
      .run(requestId, kind, roomId, bidderId, targetId, t, t);
  }

  private finishOp(requestId: string, state: "ok" | "error", resultId: string | null, error?: unknown) {
    this.d.db
      .prepare("UPDATE paypal_ops SET state = ?, result_id = ?, error_json = ?, updated_at = ? WHERE request_id = ?")
      .run(state, resultId, error === undefined ? null : paypalErrorSummary(error), Date.now(), requestId);
  }

  private requirePayPal(): PayPalClient {
    if (!this.d.paypal) throw new JoinError("paypal_not_configured", "PayPal isn't set up on this server yet. Ask the organiser.", 503);
    return this.d.paypal;
  }

  // ---------- join ----------

  async start(roomId: string, input: { name: unknown; showName: unknown; limitCents: unknown }) {
    const engine = this.d.rooms.get(roomId);
    if (!engine) throw new JoinError("unknown_room", "This auction room doesn't exist.", 404);
    const name = cleanName(input.name);
    if (!name) throw new JoinError("name_required", "Add your first name so the auctioneer knows who's bidding.");
    const limit = input.limitCents;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < LIMIT_MIN_CENTS || limit > LIMIT_MAX_CENTS)
      throw new JoinError("invalid_limit", "Choose a spending limit between $10 and $2,000.");
    const pp = this.requirePayPal();

    const id = randomUUID();
    const token = randomBytes(24).toString("base64url");
    const t = Date.now();
    this.d.db
      .prepare(
        "INSERT INTO bidders (id, room_id, token, name, show_name, limit_cents, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'creating_order', ?, ?)",
      )
      .run(id, roomId, token, name, input.showName === true ? 1 : 0, limit, t, t);

    const base = this.d.publicBaseUrl.replace(/\/+$/, "");
    const room = encodeURIComponent(roomId);
    let order: Order | undefined;
    let category = this.category;
    for (;;) {
      const requestId = `create_order:${id}:${category}`;
      this.recordOp(requestId, "create_order", roomId, id, null);
      try {
        order = (
          await pp.request<Order>("POST", "/v2/checkout/orders", {
            requestId,
            body: holdOrderBody({
              cents: limit,
              bidderId: id,
              roomName: engine.state.name,
              category,
              returnUrl: `${base}/join/${room}/return?b=${id}`,
              cancelUrl: `${base}/join/${room}?cancelled=1`,
            }),
          })
        ).data;
        this.finishOp(requestId, "ok", order.id);
        break;
      } catch (e) {
        this.finishOp(requestId, "error", null, e);
        if (e instanceof PayPalError && e.status === 422 && category === "DONATION") {
          this.log(`DONATION category refused (${paypalErrorSummary(e)}); using DIGITAL_GOODS from now on`);
          category = this.category = "DIGITAL_GOODS";
          continue;
        }
        updateBidder(this.d.db, id, { status: "failed", error: "PayPal couldn't start the hold. Try again in a moment." });
        this.log(`create order failed for ${id}: ${paypalErrorSummary(e)}`);
        throw new JoinError("paypal_error", "PayPal couldn't start the hold. Try again in a moment.", 502);
      }
    }
    const approveUrl = findLink(order.links, "payer-action", "approve");
    if (!approveUrl) throw new JoinError("paypal_error", "PayPal didn't return an approval link.", 502);
    updateBidder(this.d.db, id, { status: "awaiting_approval", order_id: order.id, order_status: order.status, approve_url: approveUrl, item_category: category });
    this.d.onChange(roomId);
    return { bidderId: id, token, approveUrl, orderId: order.id };
  }

  /** Status for the join/return page, looked up by the bidder's secret token. */
  statusByToken(roomId: string, token: string) {
    const row = rowAs<BidderRow>(this.d.db.prepare("SELECT * FROM bidders WHERE token = ? AND room_id = ?").get(token, roomId));
    if (!row) return null;
    const engine = this.d.rooms.get(roomId);
    const paddle = engine?.state.bidders[row.id]?.paddle ?? null;
    return { bidderId: row.id, status: row.status, paddle, holdCents: row.authorized_cents, error: row.error, orderId: row.order_id, authId: row.auth_id };
  }

  // ---------- reconcile ----------

  /** Serialised per bidder so a webhook, the poller and the return page never race. */
  reconcile(bidderId: string): Promise<BidderRow | undefined> {
    const running = this.locks.get(bidderId);
    if (running) return running;
    const p = this.doReconcile(bidderId).finally(() => this.locks.delete(bidderId));
    this.locks.set(bidderId, p);
    return p;
  }

  private async doReconcile(bidderId: string): Promise<BidderRow | undefined> {
    const row = getBidder(this.d.db, bidderId);
    if (!row || !row.order_id || row.status === "active" || row.status === "cancelled" || row.status === "failed") return row;
    const pp = this.requirePayPal();
    let order = (await getOrder(pp, row.order_id)).data;
    let auth = authOf(order);

    if (!auth && order.status === "APPROVED") {
      const requestId = `authorize:${bidderId}`;
      this.recordOp(requestId, "authorize", row.room_id, bidderId, order.id);
      updateBidder(this.d.db, bidderId, { status: "authorizing", order_status: order.status });
      try {
        order = (await pp.request<Order>("POST", `/v2/checkout/orders/${encodeURIComponent(order.id)}/authorize`, { requestId, body: {} })).data;
        auth = authOf(order);
        this.finishOp(requestId, "ok", auth?.id ?? null);
      } catch (e) {
        this.finishOp(requestId, "error", null, e);
        if (e instanceof PayPalError && e.issues.includes("ORDER_ALREADY_AUTHORIZED")) {
          order = (await getOrder(pp, row.order_id)).data; // resolve by re-reading, never by a new request
          auth = authOf(order);
        } else if (e instanceof PayPalError && e.issues.includes("INSTRUMENT_DECLINED")) {
          updateBidder(this.d.db, bidderId, { status: "failed", error: "PayPal declined that payment method. Try again with another card or a lower limit." });
          this.d.onChange(row.room_id);
          return getBidder(this.d.db, bidderId);
        } else {
          this.log(`authorize failed for ${bidderId}: ${paypalErrorSummary(e)}`);
          updateBidder(this.d.db, bidderId, { status: "awaiting_approval" }); // poller will retry with the same request id
          throw e;
        }
      }
    }

    if (!auth) {
      const status = order.status === "VOIDED" ? "cancelled" : "awaiting_approval";
      updateBidder(this.d.db, bidderId, { status, order_status: order.status, ...(status === "cancelled" ? { error: "The hold was cancelled." } : {}) });
      return getBidder(this.d.db, bidderId);
    }
    return this.applyAuthorization(row, order, auth);
  }

  private applyAuthorization(row: BidderRow, order: Order, auth: Authorization) {
    const cents = toCents(auth.amount);
    updateBidder(this.d.db, row.id, { order_status: order.status, auth_id: auth.id, auth_status: auth.status, authorized_cents: cents });

    if (auth.status === "CREATED" || auth.status === "PARTIALLY_CAPTURED") {
      const engine = this.d.rooms.get(row.room_id);
      if (engine && !engine.state.bidders[row.id]) {
        const r = this.d.rooms.dispatch(row.room_id, {
          type: "add_bidder",
          bidder: { id: row.id, name: row.name, showName: row.show_name === 1, holdCents: cents },
        });
        if (!r.ok) this.log(`engine refused bidder ${row.id}: ${r.reason}`);
        // Approved after the night ended: release it straight away.
        if (r.reason === "night_closed") void this.lateHold?.(row.room_id);
      }
      updateBidder(this.d.db, row.id, { status: "active", error: null });
      this.log(`bidder ${row.id} active: auth ${auth.id} ${auth.status} ${cents}c`);
    } else if (auth.status === "PENDING") {
      updateBidder(this.d.db, row.id, { status: "pending_review", error: "PayPal is still reviewing this hold. You'll get a paddle as soon as it clears." });
    } else {
      updateBidder(this.d.db, row.id, { status: "failed", error: "PayPal didn't approve the hold. Try again or choose a lower limit." });
    }
    this.d.onChange(row.room_id);
    return getBidder(this.d.db, row.id);
  }

  // ---------- poll fallback ----------

  startPolling(intervalMs = 2_000) {
    if (this.pollTimer || !this.d.paypal) return;
    let busy = false;
    this.pollTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const rows = this.d.db
          .prepare("SELECT id FROM bidders WHERE status IN ('awaiting_approval','authorizing','pending_review') AND order_id IS NOT NULL AND created_at > ?")
          .all(Date.now() - POLL_WINDOW_MS) as { id: string }[];
        for (const r of rows) await this.reconcile(r.id).catch((e) => this.log(`poll ${r.id}: ${paypalErrorSummary(e)}`));
      } finally {
        busy = false;
      }
    }, intervalMs);
    this.pollTimer.unref?.();
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // ---------- webhooks ----------

  async webhook(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<{ status: number; body: string }> {
    const pp = this.d.paypal;
    if (!pp || !this.d.webhookId) return { status: 503, body: "webhooks not configured" };
    let event: { id?: string; event_type?: string; resource_type?: string; resource?: Record<string, unknown> };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: "bad json" };
    }
    const h = (k: string) => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const transmissionId = h("paypal-transmission-id");
    if (!transmissionId || !event.id || !event.event_type) return { status: 400, body: "missing headers" };

    const verify = await pp.request<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      requestId: `verify:${transmissionId}`,
      body: {
        auth_algo: h("paypal-auth-algo"),
        cert_url: h("paypal-cert-url"),
        transmission_id: transmissionId,
        transmission_sig: h("paypal-transmission-sig"),
        transmission_time: h("paypal-transmission-time"),
        webhook_id: this.d.webhookId,
        webhook_event: event,
      },
    });
    if (verify.data.verification_status !== "SUCCESS") {
      this.log(`webhook ${event.id} failed verification`);
      return { status: 400, body: "verification failed" };
    }

    const resourceId = typeof event.resource?.id === "string" ? event.resource.id : null;
    const inserted = this.d.db
      .prepare("INSERT OR IGNORE INTO webhook_events (id, event_type, resource_type, resource_id, received_at) VALUES (?, ?, ?, ?, ?)")
      .run(event.id, event.event_type, event.resource_type ?? null, resourceId, Date.now());
    if (inserted.changes === 0) return { status: 200, body: "duplicate" };
    this.log(`webhook ${event.event_type} ${resourceId ?? ""}`); // never the payload (rule 9)

    // A webhook is a hint: find the bidder, then re-read from PayPal.
    let orderId: string | null = null;
    if (event.event_type === "CHECKOUT.ORDER.APPROVED") orderId = resourceId;
    if (event.event_type?.startsWith("PAYMENT.AUTHORIZATION.")) {
      const related = (event.resource?.supplementary_data as Authorization["supplementary_data"])?.related_ids?.order_id;
      orderId = related ?? null;
      if (event.event_type === "PAYMENT.AUTHORIZATION.VOIDED" && resourceId) {
        const auth = (await getAuthorization(pp, resourceId)).data;
        const row = rowAs<BidderRow>(this.d.db.prepare("SELECT * FROM bidders WHERE auth_id = ?").get(resourceId));
        if (row) {
          updateBidder(this.d.db, row.id, { auth_status: auth.status });
          this.d.onChange(row.room_id);
        }
      }
    }
    if (event.event_type?.startsWith("PAYMENT.CAPTURE.") && resourceId) await this.captureHint?.(resourceId);
    if (orderId) {
      const row = rowAs<BidderRow>(this.d.db.prepare("SELECT * FROM bidders WHERE order_id = ?").get(orderId));
      if (row) await this.reconcile(row.id);
    }
    return { status: 200, body: "ok" };
  }

  // ---------- dev only ----------

  /** Demo rooms only, never in production: a bidder with a clearly-labelled simulated hold, for testing sync without PayPal. */
  addTestBidder(roomId: string, name: string, holdCents: number) {
    const engine = this.d.rooms.get(roomId);
    if (!engine?.state.isDemo) throw new JoinError("not_demo", "Test bidders exist only in demo rooms.");
    const id = randomUUID();
    const token = randomBytes(24).toString("base64url");
    const t = Date.now();
    const clean = cleanName(name) || "Tester";
    this.d.db
      .prepare(
        "INSERT INTO bidders (id, room_id, token, name, show_name, limit_cents, status, simulated, authorized_cents, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, 'active', 1, ?, ?, ?)",
      )
      .run(id, roomId, token, clean, holdCents, holdCents, t, t);
    const r = this.d.rooms.dispatch(roomId, { type: "add_bidder", bidder: { id, name: clean, showName: true, holdCents, simulatedHold: true } });
    if (!r.ok) throw new JoinError(r.reason ?? "rejected", "Engine refused the test bidder.");
    return { bidderId: id, token, paddle: engine.state.bidders[id]!.paddle };
  }
}
