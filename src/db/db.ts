/**
 * SQLite via Node's built-in `node:sqlite` (no native addon to compile).
 * One process, synchronous calls — fine at auction scale.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  is_demo       INTEGER NOT NULL DEFAULT 0,
  clerk_token   TEXT NOT NULL,
  engine_json   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- One row per person who started joining. They enter the engine (get a paddle)
-- only once PayPal reports an authorization.
CREATE TABLE IF NOT EXISTS bidders (
  id               TEXT PRIMARY KEY,
  room_id          TEXT NOT NULL REFERENCES rooms(id),
  token            TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  show_name        INTEGER NOT NULL,
  limit_cents      INTEGER NOT NULL,
  status           TEXT NOT NULL,   -- creating_order | awaiting_approval | authorizing | active | pending_review | cancelled | failed
  simulated        INTEGER NOT NULL DEFAULT 0,
  item_category    TEXT,
  order_id         TEXT UNIQUE,
  approve_url      TEXT,
  order_status     TEXT,
  auth_id          TEXT UNIQUE,
  auth_status      TEXT,
  authorized_cents INTEGER,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bidders_room ON bidders(room_id);
CREATE INDEX IF NOT EXISTS bidders_status ON bidders(status);

-- Every PayPal write is recorded here BEFORE it is sent (rule 3).
CREATE TABLE IF NOT EXISTS paypal_ops (
  request_id  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,        -- create_order | authorize | capture | void
  room_id     TEXT,
  bidder_id   TEXT,
  target_id   TEXT,                 -- order id / authorization id the call acts on
  state       TEXT NOT NULL,        -- sent | ok | error
  result_id   TEXT,
  error_json  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- One row per sold lot. Inserted (with its request id) BEFORE the capture call.
CREATE TABLE IF NOT EXISTS captures (
  id            TEXT PRIMARY KEY,      -- {room}:{lot}
  room_id       TEXT NOT NULL,
  lot_id        TEXT NOT NULL,
  bidder_id     TEXT NOT NULL,
  auth_id       TEXT,
  order_id      TEXT,
  amount_cents  INTEGER NOT NULL,
  request_id    TEXT NOT NULL UNIQUE,
  invoice_id    TEXT NOT NULL,
  capture_id    TEXT UNIQUE,
  status        TEXT NOT NULL,         -- capturing | COMPLETED | PENDING | DECLINED | FAILED | failed | simulated
  error         TEXT,
  simulated     INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS captures_room ON captures(room_id);
CREATE INDEX IF NOT EXISTS captures_status ON captures(status);

-- End of the night (M9): once a row exists, the room takes no new lots, bids or guests.
CREATE TABLE IF NOT EXISTS nights (
  room_id    TEXT PRIMARY KEY,
  closed_at  INTEGER NOT NULL
);

-- One row per bidder at close: the void that releases the rest of their hold.
-- Inserted (with its request id) BEFORE the void call (rule 3).
CREATE TABLE IF NOT EXISTS releases (
  bidder_id     TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL,
  auth_id       TEXT,
  request_id    TEXT UNIQUE,
  held_cents    INTEGER NOT NULL,      -- authorized amount
  won_cents     INTEGER NOT NULL,      -- captured / owed at close
  status        TEXT NOT NULL,         -- voiding | VOIDED | CAPTURED | failed | simulated
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS releases_room ON releases(room_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  id             TEXT PRIMARY KEY,
  event_type     TEXT NOT NULL,
  resource_type  TEXT,
  resource_id    TEXT,
  received_at    INTEGER NOT NULL
);
`;

export function openDb(path = process.env.DATABASE_PATH ?? "./data/going-once.db"): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  // Added after launch: "room" (guests in the hall) or "online" (everyone bids from home).
  try {
    db.exec("ALTER TABLE rooms ADD COLUMN mode TEXT NOT NULL DEFAULT 'room'");
  } catch {
    /* column already there */
  }
  return db;
}

export interface RoomRow {
  id: string;
  name: string;
  is_demo: number;
  clerk_token: string;
  engine_json: string;
  created_at: number;
  updated_at: number;
}

export type BidderStatus =
  | "creating_order"
  | "awaiting_approval"
  | "authorizing"
  | "active"
  | "pending_review"
  | "cancelled"
  | "failed";

export interface BidderRow {
  id: string;
  room_id: string;
  token: string;
  name: string;
  show_name: number;
  limit_cents: number;
  status: BidderStatus;
  simulated: number;
  item_category: string | null;
  order_id: string | null;
  approve_url: string | null;
  order_status: string | null;
  auth_id: string | null;
  auth_status: string | null;
  authorized_cents: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/** Narrow helper: node:sqlite returns null-prototype objects typed as unknown records. */
export function rowAs<T>(row: unknown): T | undefined {
  return (row ?? undefined) as T | undefined;
}

export function updateBidder(db: DB, id: string, patch: Partial<Omit<BidderRow, "id">>) {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
  db.prepare(`UPDATE bidders SET ${sets} WHERE id = ?`).run(
    ...keys.map((k) => (patch[k] ?? null) as string | number | null),
    Date.now(),
    id,
  );
}

export function getBidder(db: DB, id: string) {
  return rowAs<BidderRow>(db.prepare("SELECT * FROM bidders WHERE id = ?").get(id));
}

export type CaptureStatus = "capturing" | "COMPLETED" | "PENDING" | "DECLINED" | "FAILED" | "failed" | "simulated";

export interface CaptureRow {
  id: string;
  room_id: string;
  lot_id: string;
  bidder_id: string;
  auth_id: string | null;
  order_id: string | null;
  amount_cents: number;
  request_id: string;
  invoice_id: string;
  capture_id: string | null;
  status: CaptureStatus;
  error: string | null;
  simulated: number;
  attempts: number;
  created_at: number;
  updated_at: number;
}

/** What any screen may see about a lot's capture (no bidder ids). */
export interface PublicCapture {
  lotId: string;
  status: "capturing" | "captured" | "pending" | "attention" | "simulated";
  captureId: string | null;
  amountCents: number;
}

export function publicCaptureStatus(s: CaptureStatus): PublicCapture["status"] {
  switch (s) {
    case "COMPLETED":
      return "captured";
    case "PENDING":
      return "pending";
    case "capturing":
      return "capturing";
    case "simulated":
      return "simulated";
    default:
      return "attention";
  }
}

export function roomCaptures(db: DB, roomId: string): CaptureRow[] {
  return db.prepare("SELECT * FROM captures WHERE room_id = ? ORDER BY created_at").all(roomId) as unknown as CaptureRow[];
}

export function publicCaptures(db: DB, roomId: string): Record<string, PublicCapture> {
  const out: Record<string, PublicCapture> = {};
  for (const r of roomCaptures(db, roomId))
    out[r.lot_id] = { lotId: r.lot_id, status: publicCaptureStatus(r.status), captureId: r.capture_id, amountCents: r.amount_cents };
  return out;
}

export type ReleaseStatus = "voiding" | "VOIDED" | "CAPTURED" | "failed" | "simulated";

export interface ReleaseRow {
  bidder_id: string;
  room_id: string;
  auth_id: string | null;
  request_id: string | null;
  held_cents: number;
  won_cents: number;
  status: ReleaseStatus;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

export function roomReleases(db: DB, roomId: string): ReleaseRow[] {
  return db.prepare("SELECT * FROM releases WHERE room_id = ? ORDER BY created_at").all(roomId) as unknown as ReleaseRow[];
}

export function nightClosedAt(db: DB, roomId: string): number | null {
  return rowAs<{ closed_at: number }>(db.prepare("SELECT closed_at FROM nights WHERE room_id = ?").get(roomId))?.closed_at ?? null;
}

/** What any screen may see about the end of the night (no bidder ids). */
export interface NightSummary {
  closedAt: number;
  raisedCents: number;
  lotsSold: number;
  released: number;
  releasing: number;
  attention: number;
}

export function nightSummary(db: DB, roomId: string, raisedCents: number, lotsSold: number): NightSummary | null {
  const closedAt = nightClosedAt(db, roomId);
  if (closedAt === null) return null;
  const rows = roomReleases(db, roomId);
  return {
    closedAt,
    raisedCents,
    lotsSold,
    released: rows.filter((r) => r.status === "VOIDED" || r.status === "CAPTURED" || r.status === "simulated").length,
    releasing: rows.filter((r) => r.status === "voiding").length,
    attention: rows.filter((r) => r.status === "failed").length,
  };
}
