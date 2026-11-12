/**
 * Owns one AuctionEngine per room. Every mutation goes through `dispatch`,
 * which persists the engine state and notifies listeners (Socket.IO layer).
 * The server is authoritative; clients only send intents.
 */
import { randomBytes } from "node:crypto";
import { AuctionEngine, type AuctionState, type Command, type DispatchResult, type EngineEvent, type LotInput } from "../engine";
import { nightClosedAt, rowAs, type DB, type RoomRow } from "../db/db";

/** "room": guests in the hall watch the big screen. "online": everyone bids from home on /live. */
export type RoomMode = "room" | "online";

export type RoomListener = (roomId: string, events: EngineEvent[]) => void;

export class RoomManager {
  private engines = new Map<string, AuctionEngine>();
  private listeners = new Set<RoomListener>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly db: DB,
    private readonly now: () => number = Date.now,
  ) {}

  onChange(fn: RoomListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  createRoom(input: { id: string; name: string; isDemo: boolean; lots: LotInput[]; clerkToken?: string; config?: Partial<AuctionState["config"]>; mode?: RoomMode }) {
    const t = this.now();
    const engine = AuctionEngine.create({ id: input.id, name: input.name, isDemo: input.isDemo, lots: input.lots, config: input.config }, t);
    const clerkToken = input.clerkToken ?? randomBytes(12).toString("base64url");
    this.db
      .prepare("INSERT INTO rooms (id, name, is_demo, clerk_token, engine_json, created_at, updated_at, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.name, input.isDemo ? 1 : 0, clerkToken, JSON.stringify(engine.state), t, t, input.mode === "online" ? "online" : "room");
    this.engines.set(input.id, engine);
    return { engine, clerkToken };
  }

  get(roomId: string): AuctionEngine | undefined {
    const cached = this.engines.get(roomId);
    if (cached) return cached;
    const row = rowAs<RoomRow>(this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId));
    if (!row) return undefined;
    const engine = AuctionEngine.fromState(JSON.parse(row.engine_json) as AuctionState);
    this.engines.set(roomId, engine);
    return engine;
  }

  mode(roomId: string): RoomMode {
    return rowAs<{ mode: string }>(this.db.prepare("SELECT mode FROM rooms WHERE id = ?").get(roomId))?.mode === "online" ? "online" : "room";
  }

  isClosed(roomId: string) {
    return nightClosedAt(this.db, roomId) !== null;
  }

  clerkToken(roomId: string): string | undefined {
    return rowAs<{ clerk_token: string }>(this.db.prepare("SELECT clerk_token FROM rooms WHERE id = ?").get(roomId))?.clerk_token;
  }

  /** The only way state changes. Persists before notifying. */
  dispatch(roomId: string, cmd: Command): DispatchResult {
    const engine = this.get(roomId);
    if (!engine) return { ok: false, reason: "unknown_room", events: [] };
    // After the night is closed (M9) nothing new may start: no lots, bids or guests.
    if ((cmd.type === "open_lot" || cmd.type === "next_lot" || cmd.type === "bid" || cmd.type === "add_bidder" || cmd.type === "add_lot") && this.isClosed(roomId))
      return { ok: false, reason: "night_closed", events: [] };
    const result = engine.dispatch(cmd, this.now());
    if (result.events.length) {
      this.db.prepare("UPDATE rooms SET engine_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(engine.state), this.now(), roomId);
      for (const fn of this.listeners) fn(roomId, result.events);
    }
    return result;
  }

  /** Drive the clock for every loaded room. */
  start(intervalMs = 200) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const [id, engine] of this.engines) {
        const lot = engine.currentLot;
        if (lot && (lot.status === "open" || lot.status === "going_once" || lot.status === "going_twice")) this.dispatch(id, { type: "tick" });
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
