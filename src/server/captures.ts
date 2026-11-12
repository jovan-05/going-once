/**
 * M6 — capture on sold (PAYPAL.md "Win a lot").
 *
 * When the engine emits lot_sold, capture exactly the hammer price from the
 * winner's authorization with final_capture: false. Rules:
 *   - The capture row (with its PayPal-Request-Id) is written BEFORE the call (rule 3).
 *   - A lost/unclear response is resolved by re-reading the order and matching
 *     our invoice_id; only if PayPal has no such capture do we resend, with the
 *     SAME request id. Never a new request id for the same lot.
 *   - Status comes from PayPal (rule 4): the UI says "Sold" only for COMPLETED.
 *   - PENDING captures are polled until they settle; webhooks are hints.
 *   - Simulated holds (bots/test bidders, demo rooms only) never touch PayPal.
 */
import {
  getBidder,
  publicCaptureStatus,
  rowAs,
  type CaptureRow,
  type CaptureStatus,
  type DB,
} from "../db/db";
import type { EngineEvent } from "../engine";
import { PayPalError, type PayPalClient } from "../paypal/client";
import { getOrder, usd, type Order } from "../paypal/orders";
import type { RoomManager } from "./rooms";

interface Capture {
  id: string;
  status: string;
  status_details?: { reason?: string };
  invoice_id?: string;
  amount?: { currency_code: string; value: string };
}

const SETTLED: ReadonlySet<CaptureStatus> = new Set(["COMPLETED", "DECLINED", "FAILED", "failed", "simulated"]);
const RECONCILE_AFTER_MS = 5_000;
const MAX_ATTEMPTS = 5;

export interface CaptureServiceDeps {
  db: DB;
  rooms: RoomManager;
  paypal: PayPalClient | null;
  onChange: (roomId: string) => void;
  log?: (msg: string) => void;
}

const summary = (e: unknown) =>
  e instanceof PayPalError
    ? `HTTP ${e.status} ${e.paypalName ?? ""} ${e.issues.join(",")} debug_id=${e.debugId ?? "n/a"}`
    : e instanceof Error
      ? e.message
      : String(e);

/** PayPal's invoice_id must be unique across the merchant account, so it carries part of the bidder's random id. */
export const invoiceIdFor = (roomId: string, lotId: string, bidderId: string) => `${roomId}-${lotId}-${bidderId.slice(0, 8)}`.slice(0, 127);
export const captureRequestId = (roomId: string, lotId: string, bidderId: string) => `capture:${roomId}:${lotId}:${bidderId}`;

export class CaptureService {
  private inflight = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: CaptureServiceDeps) {}

  private log(m: string) {
    (this.d.log ?? console.log)(`[captures] ${m}`);
  }

  private row(id: string) {
    return rowAs<CaptureRow>(this.d.db.prepare("SELECT * FROM captures WHERE id = ?").get(id));
  }

  private update(id: string, patch: Partial<Pick<CaptureRow, "capture_id" | "status" | "error" | "attempts">>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    this.d.db
      .prepare(`UPDATE captures SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (patch[k] ?? null) as string | number | null), Date.now(), id);
  }

  /** Serialise all work on one capture row. */
  private once(id: string, fn: () => Promise<void>) {
    const running = this.inflight.get(id);
    if (running) return running;
    const p = fn()
      .catch((e) => this.log(`${id}: ${summary(e)}`))
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  /** Called with every batch of engine events. */
  handleEvents(roomId: string, events: EngineEvent[]) {
    for (const ev of events) {
      if (ev.type !== "lot_sold") continue;
      void this.captureLot(roomId, String(ev.data.lotId), String(ev.data.bidderId), Number(ev.data.amountCents));
    }
  }

  captureLot(roomId: string, lotId: string, bidderId: string, amountCents: number): Promise<void> {
    const id = `${roomId}:${lotId}`;
    return this.once(id, async () => {
      const existing = this.row(id);
      if (existing && existing.status !== "capturing") return; // already handled (e.g. after a restart)

      const bidder = getBidder(this.d.db, bidderId);
      const engineBidder = this.d.rooms.get(roomId)?.state.bidders[bidderId];
      const simulated = !bidder || bidder.simulated === 1 || !!engineBidder?.simulatedHold;
      const requestId = captureRequestId(roomId, lotId, bidderId);
      const invoiceId = invoiceIdFor(roomId, lotId, bidderId);

      if (!existing) {
        const t = Date.now();
        this.d.db
          .prepare(
            `INSERT INTO captures (id, room_id, lot_id, bidder_id, auth_id, order_id, amount_cents, request_id, invoice_id, status, simulated, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, roomId, lotId, bidderId, bidder?.auth_id ?? null, bidder?.order_id ?? null, amountCents, requestId, invoiceId, simulated ? "simulated" : "capturing", simulated ? 1 : 0, t, t);
        this.d.onChange(roomId);
      }
      if (simulated) return;
      await this.sendCapture(id);
    });
  }

  /** POST the capture with the stored request id; on an unclear outcome, reconcile by re-reading. */
  private async sendCapture(id: string) {
    const row = this.row(id);
    if (!row || row.status !== "capturing") return;
    const pp = this.d.paypal;
    if (!pp || !row.auth_id) {
      this.update(id, { status: "failed", error: pp ? "No PayPal authorization for this bidder." : "PayPal is not configured." });
      this.d.onChange(row.room_id);
      return;
    }
    this.d.db
      .prepare("INSERT OR IGNORE INTO paypal_ops (request_id, kind, room_id, bidder_id, target_id, state, created_at, updated_at) VALUES (?, 'capture', ?, ?, ?, 'sent', ?, ?)")
      .run(row.request_id, row.room_id, row.bidder_id, row.auth_id, Date.now(), Date.now());
    this.update(id, { attempts: row.attempts + 1 });
    try {
      const res = await pp.request<Capture>("POST", `/v2/payments/authorizations/${encodeURIComponent(row.auth_id)}/capture`, {
        requestId: row.request_id,
        body: { amount: usd(row.amount_cents), final_capture: false, invoice_id: row.invoice_id },
      });
      this.d.db.prepare("UPDATE paypal_ops SET state = 'ok', result_id = ?, updated_at = ? WHERE request_id = ?").run(res.data.id, Date.now(), row.request_id);
      this.apply(row, res.data);
    } catch (e) {
      this.d.db.prepare("UPDATE paypal_ops SET state = 'error', error_json = ?, updated_at = ? WHERE request_id = ?").run(summary(e), Date.now(), row.request_id);
      this.log(`capture ${id} errored: ${summary(e)} — re-reading the order`);
      // Whatever happened, PayPal decides: look for our invoice_id on the order.
      const found = await this.findOnOrder(row).catch(() => undefined);
      if (found) return this.apply(row, found);
      if (e instanceof PayPalError && e.status >= 400 && e.status < 500 && e.status !== 409 && e.status !== 429) {
        const declined = e.issues.some((i) => /DECLINED|INSTRUMENT/.test(i));
        this.update(id, { status: declined ? "DECLINED" : "failed", error: `${e.paypalName ?? "error"} ${e.issues.join(", ")} (debug_id ${e.debugId ?? "n/a"})` });
        this.d.onChange(row.room_id);
      }
      // Network/5xx with nothing on the order: stay "capturing"; the poller retries with the same request id.
    }
  }

  private async findOnOrder(row: CaptureRow): Promise<Capture | undefined> {
    if (!this.d.paypal || !row.order_id) return undefined;
    const order: Order = (await getOrder(this.d.paypal, row.order_id)).data;
    return order.purchase_units?.flatMap((u) => u.payments?.captures ?? []).find((c) => c.invoice_id === row.invoice_id);
  }

  private apply(row: CaptureRow, c: Capture) {
    const status = (["COMPLETED", "PENDING", "DECLINED", "FAILED"].includes(c.status) ? c.status : "PENDING") as CaptureStatus;
    this.update(row.id, {
      capture_id: c.id,
      status,
      error: status === "PENDING" ? (c.status_details?.reason ?? "PayPal is still processing this capture.") : status === "COMPLETED" ? null : (c.status_details?.reason ?? null),
    });
    this.log(`${row.id} → capture ${c.id} ${c.status} (${publicCaptureStatus(status)})`);
    this.d.onChange(row.room_id);
  }

  /** Re-read one capture from PayPal (poller and webhook hint). */
  async refreshByCaptureId(captureId: string) {
    const row = rowAs<CaptureRow>(this.d.db.prepare("SELECT * FROM captures WHERE capture_id = ?").get(captureId));
    if (!row || !this.d.paypal) return;
    await this.once(row.id, async () => {
      const c = (await this.d.paypal!.request<Capture>("GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`)).data;
      if (c.status !== row.status) this.apply(row, c);
    });
  }

  /** Every 2s: settle PENDING captures, and resolve "capturing" rows left by a crash or lost response. */
  startPolling(intervalMs = 2_000) {
    if (this.timer || !this.d.paypal) return;
    let busy = false;
    this.timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const rows = this.d.db.prepare("SELECT * FROM captures WHERE status IN ('capturing','PENDING')").all() as unknown as CaptureRow[];
        for (const r of rows) {
          if (r.status === "PENDING" && r.capture_id) await this.refreshByCaptureId(r.capture_id);
          else if (r.status === "capturing" && !this.inflight.has(r.id) && Date.now() - r.updated_at > RECONCILE_AFTER_MS) {
            await this.once(r.id, async () => {
              const found = await this.findOnOrder(r);
              if (found) return this.apply(r, found);
              if (r.attempts >= MAX_ATTEMPTS) {
                this.update(r.id, { status: "failed", error: `No capture after ${r.attempts} attempts; check PayPal.` });
                this.d.onChange(r.room_id);
                return;
              }
              await this.sendCapture(r.id); // same request id
            });
          }
        }
      } finally {
        busy = false;
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** On boot: any lot the engine sold without a capture row (crash in between) gets captured now. */
  resumeMissing() {
    const rooms = this.d.db.prepare("SELECT id FROM rooms").all() as { id: string }[];
    for (const { id: roomId } of rooms) {
      const engine = this.d.rooms.get(roomId);
      for (const lot of engine?.state.lots ?? []) {
        if (lot.status !== "sold" || !lot.winnerId || lot.hammerCents === null) continue;
        if (this.row(`${roomId}:${lot.id}`)) continue;
        this.log(`resuming missed capture for ${roomId}:${lot.id}`);
        void this.captureLot(roomId, lot.id, lot.winnerId, lot.hammerCents);
      }
    }
  }

  /** Has every lot sold in this room settled (no capture still in flight)? */
  settled(roomId: string) {
    return (this.d.db.prepare("SELECT status FROM captures WHERE room_id = ?").all(roomId) as { status: CaptureStatus }[]).every((r) => SETTLED.has(r.status));
  }
}
