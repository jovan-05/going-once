/**
 * End of the night (M9, PAYPAL.md "End of night"): release every hold.
 *
 * Verified in the sandbox spike: voiding an authorization after partial
 * captures is allowed and releases the uncaptured remainder. So closing is the
 * same for everyone: void each open authorization once.
 *
 * - Refused while a lot is live or a capture is still in flight, so a void can
 *   never race a capture.
 * - Each void's PayPal-Request-Id (`void:{auth}`) is stored in `releases` and
 *   `paypal_ops` before the call (rule 3). Retries reuse it.
 * - On any error, PayPal decides: we re-read the authorization and record what
 *   it says (VOIDED / CAPTURED), never guess.
 * - Running close again is safe: finished rows are skipped, open ones retried.
 */
import { rowAs, roomReleases, type BidderRow, type DB, type ReleaseRow } from "../db/db";
import { LIVE_STATUSES } from "../engine";
import { PayPalError, type PayPalClient } from "../paypal/client";
import type { CaptureService } from "./captures";
import type { RoomManager } from "./rooms";

interface Authorization {
  id: string;
  status: string; // CREATED | CAPTURED | PARTIALLY_CAPTURED | VOIDED | EXPIRED | DENIED | PENDING
}

const summary = (e: unknown) =>
  e instanceof PayPalError
    ? `HTTP ${e.status} ${e.paypalName ?? ""} ${e.issues.join(",")} (debug_id ${e.debugId ?? "n/a"})`
    : e instanceof Error
      ? e.message
      : String(e);

export const voidRequestId = (authId: string) => `void:${authId}`;

/** Authorization states where nothing is left to release. */
const DONE: Record<string, "VOIDED" | "CAPTURED"> = { VOIDED: "VOIDED", EXPIRED: "VOIDED", CAPTURED: "CAPTURED", DENIED: "VOIDED" };

export type CloseResult = { ok: true; released: number; attention: number } | { ok: false; reason: string };

export class CloseService {
  private running = new Map<string, Promise<CloseResult>>();
  /** Set by app.ts once the auctioneer exists: the closing thank-you. */
  onClosed?: (roomId: string) => void;

  constructor(
    private readonly d: {
      db: DB;
      rooms: RoomManager;
      paypal: PayPalClient | null;
      captures: Pick<CaptureService, "settled">;
      onChange: (roomId: string) => void;
      /** Called once, when a room's night is first closed (the auctioneer's thank-you). */
      onClosed?: (roomId: string) => void;
      log?: (m: string) => void;
    },
  ) {}

  private log(m: string) {
    (this.d.log ?? console.log)(`[close] ${m}`);
  }

  /** Close the night: no more lots, then release every hold. Safe to call again. */
  closeNight(roomId: string): Promise<CloseResult> {
    const running = this.running.get(roomId);
    if (running) return running;
    const p = this.run(roomId).finally(() => this.running.delete(roomId));
    this.running.set(roomId, p);
    return p;
  }

  private async run(roomId: string): Promise<CloseResult> {
    const engine = this.d.rooms.get(roomId);
    if (!engine) return { ok: false, reason: "unknown_room" };
    const lot = engine.currentLot;
    if (lot && LIVE_STATUSES.includes(lot.status)) return { ok: false, reason: "lot_live" };
    if (!this.d.captures.settled(roomId)) return { ok: false, reason: "captures_in_flight" };

    const db = this.d.db;
    const first = Number(db.prepare("INSERT OR IGNORE INTO nights (room_id, closed_at) VALUES (?, ?)").run(roomId, Date.now()).changes) > 0;
    this.log(`${roomId}: night closed; releasing holds`);

    // One release row per guest who got as far as a hold (real or simulated).
    const bidders = db.prepare("SELECT * FROM bidders WHERE room_id = ? AND (auth_id IS NOT NULL OR simulated = 1)").all(roomId) as unknown as BidderRow[];
    const t = Date.now();
    for (const b of bidders) {
      const won = engine.state.bidders[b.id]?.wonCents ?? 0;
      const held = b.authorized_cents ?? b.limit_cents;
      if (b.simulated || !b.auth_id) {
        db.prepare("INSERT OR IGNORE INTO releases (bidder_id, room_id, auth_id, request_id, held_cents, won_cents, status, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?, 'simulated', ?, ?)").run(
          b.id, roomId, held, won, t, t,
        );
      } else {
        db.prepare("INSERT OR IGNORE INTO releases (bidder_id, room_id, auth_id, request_id, held_cents, won_cents, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'voiding', ?, ?)").run(
          b.id, roomId, b.auth_id, voidRequestId(b.auth_id), held, won, t, t,
        );
      }
    }
    this.d.onChange(roomId);
    if (first) (this.onClosed ?? this.d.onClosed)?.(roomId);

    for (const r of roomReleases(db, roomId)) if (r.status === "voiding" || r.status === "failed") await this.release(r);
    const rows = roomReleases(db, roomId);
    this.d.onChange(roomId);
    return { ok: true, released: rows.filter((r) => r.status !== "voiding" && r.status !== "failed").length, attention: rows.filter((r) => r.status === "failed").length };
  }

  private set(bidderId: string, patch: Partial<Pick<ReleaseRow, "status" | "error" | "attempts">>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    this.d.db
      .prepare(`UPDATE releases SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE bidder_id = ?`)
      .run(...keys.map((k) => (patch[k] ?? null) as string | number | null), Date.now(), bidderId);
  }

  private async release(r: ReleaseRow) {
    const pp = this.d.paypal;
    if (!r.auth_id || !r.request_id) return;
    if (!pp) return this.set(r.bidder_id, { status: "failed", error: "PayPal is not configured." });

    this.d.db
      .prepare("INSERT OR IGNORE INTO paypal_ops (request_id, kind, room_id, bidder_id, target_id, state, created_at, updated_at) VALUES (?, 'void', ?, ?, ?, 'sent', ?, ?)")
      .run(r.request_id, r.room_id, r.bidder_id, r.auth_id, Date.now(), Date.now());
    this.set(r.bidder_id, { attempts: r.attempts + 1 });
    const path = `/v2/payments/authorizations/${encodeURIComponent(r.auth_id)}`;

    // Already finished at PayPal (e.g. a retry after a lost response)? Then don't send.
    const before = await this.read(path);
    if (before && DONE[before.status]) return this.finish(r, before.status);

    try {
      await pp.request("POST", `${path}/void`, { requestId: r.request_id });
      this.d.db.prepare("UPDATE paypal_ops SET state = 'ok', result_id = ?, updated_at = ? WHERE request_id = ?").run(r.auth_id, Date.now(), r.request_id);
    } catch (e) {
      this.d.db.prepare("UPDATE paypal_ops SET state = 'error', error_json = ?, updated_at = ? WHERE request_id = ?").run(summary(e), Date.now(), r.request_id);
      this.log(`void ${r.auth_id} errored: ${summary(e)} — re-reading the authorization`);
    }
    // Whatever the call said, PayPal's record decides.
    const after = await this.read(path);
    if (after && DONE[after.status]) return this.finish(r, after.status);
    this.set(r.bidder_id, {
      status: "failed",
      error: after ? `PayPal reports the hold as ${after.status}; release it in the PayPal dashboard.` : "Couldn't reach PayPal to release this hold. Close again to retry.",
    });
    this.d.onChange(r.room_id);
  }

  private async read(path: string): Promise<Authorization | null> {
    try {
      return (await this.d.paypal!.request<Authorization>("GET", path)).data;
    } catch (e) {
      this.log(`read ${path} failed: ${summary(e)}`);
      return null;
    }
  }

  private finish(r: ReleaseRow, paypalStatus: string) {
    const status = DONE[paypalStatus]!;
    this.set(r.bidder_id, { status, error: null });
    this.d.db.prepare("UPDATE bidders SET auth_status = ?, updated_at = ? WHERE id = ?").run(paypalStatus, Date.now(), r.bidder_id);
    this.log(`${r.room_id}: hold ${r.auth_id} → ${paypalStatus}`);
    this.d.onChange(r.room_id);
  }

  /** On boot: finish any close that was interrupted. */
  resume() {
    const rows = this.d.db.prepare("SELECT DISTINCT room_id FROM releases WHERE status = 'voiding'").all() as { room_id: string }[];
    for (const { room_id } of rows) void this.closeNight(room_id);
  }

  /** For callers that only need to know a room's release rows. */
  rows(roomId: string) {
    return roomReleases(this.d.db, roomId);
  }

  bidderRelease(bidderId: string) {
    return rowAs<ReleaseRow>(this.d.db.prepare("SELECT * FROM releases WHERE bidder_id = ?").get(bidderId)) ?? null;
  }
}
