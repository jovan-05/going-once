"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { ClerkView, EngineEvent, PaddleView, PublicView } from "@/engine";

export type Role = "stage" | "paddle" | "clerk";

export interface ClerkPaymentRow {
  id: string;
  name: string;
  show_name: number;
  limit_cents: number;
  status: string;
  simulated: number;
  item_category: string | null;
  order_id: string | null;
  order_status: string | null;
  auth_id: string | null;
  auth_status: string | null;
  authorized_cents: number | null;
  error: string | null;
  created_at: number;
}

export interface PublicCapture {
  lotId: string;
  status: "capturing" | "captured" | "pending" | "attention" | "simulated";
  captureId: string | null;
  amountCents: number;
}
export interface ClerkCaptureRow {
  id: string;
  lot_id: string;
  bidder_id: string;
  amount_cents: number;
  capture_id: string | null;
  status: string;
  error: string | null;
  simulated: number;
}
/** A line from the auctioneer (server/auctioneer host.ts). */
export interface HostLine {
  id: number;
  lotId: string | null;
  event: string;
  text: string;
  template: string;
  vars: Partial<Record<"amount" | "next" | "leader" | "target" | "start" | "lot" | "number", string>>;
  tone: "warm" | "playful" | "urgent" | "grateful";
  source: "ai" | "bank" | "system";
  at: number;
}
/** End of the night (M9); null while the auction is on. */
export interface NightSummary {
  closedAt: number;
  raisedCents: number;
  lotsSold: number;
  released: number;
  releasing: number;
  attention: number;
}
export interface ReleaseRow {
  bidder_id: string;
  auth_id: string | null;
  held_cents: number;
  won_cents: number;
  status: "voiding" | "VOIDED" | "CAPTURED" | "failed" | "simulated";
  error: string | null;
}
type WithCaptures = { captures: Record<string, PublicCapture>; host: HostLine | null; night: NightSummary | null };
/** Templates the stage pre-renders audio for (current lot, then the next). */
export interface VoicePlan {
  lots: { lotId: string; startCents: number; incrementCents: number; templates: string[] }[];
}
export type StageSnapshot = PublicView & WithCaptures & { role: "stage"; voicePlan: VoicePlan | null };
export type PaddleSnapshot = PaddleView &
  WithCaptures & {
    role: "paddle";
    join: { status: string; error: string | null } | null;
    myRelease: { status: ReleaseRow["status"]; heldCents: number; wonCents: number } | null;
  };
export type ClerkSnapshot = ClerkView & WithCaptures & { role: "clerk"; payments: ClerkPaymentRow[]; captureRows: ClerkCaptureRow[]; releases: ReleaseRow[] };

/** Ticket / receipt copy for a capture. Never claims success before PayPal does (rule 4). */
export const CAPTURE_COPY: Record<PublicCapture["status"], string> = {
  capturing: "Capturing…",
  captured: "Captured",
  pending: "Capture pending at PayPal",
  attention: "Payment needs attention",
  simulated: "Simulated hold · no payment taken",
};

type SnapshotFor<R extends Role> = R extends "clerk" ? ClerkSnapshot : R extends "paddle" ? PaddleSnapshot : StageSnapshot;

export type Ack = { ok: boolean; reason?: string };

export const tokenKey = (room: string) => `going-once:token:${room}`;
/** sessionStorage flag: play the paddle-number flip once after joining. */
export const REVEAL_KEY = (room: string) => `going-once:reveal:${room}`;
export const clerkKeyKey = (room: string) => `going-once:clerk:${room}`;

export function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writeLocal(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode: the session still works, it just won't survive a reload */
  }
}

export function useRoom<R extends Role>(
  room: string | undefined,
  role: R,
  auth: { token?: string | null; key?: string | null } = {},
  onEvents?: (events: EngineEvent[], snapshot: SnapshotFor<R> | null) => void,
  onHost?: (line: HostLine) => void,
) {
  const [state, setState] = useState<SnapshotFor<R> | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastEvents, setLastEvents] = useState<EngineEvent[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const onEventsRef = useRef(onEvents);
  onEventsRef.current = onEvents;
  const onHostRef = useRef(onHost);
  onHostRef.current = onHost;
  const stateRef = useRef<SnapshotFor<R> | null>(null);

  useEffect(() => {
    if (!room) return;
    const s = io({ path: "/socket.io", auth: { room, role, token: auth.token ?? undefined, key: auth.key ?? undefined }, transports: ["websocket", "polling"] });
    socketRef.current = s;
    s.on("connect", () => {
      setConnected(true);
      setError(null);
    });
    s.on("disconnect", () => setConnected(false));
    s.on("connect_error", (e) => setError(e.message));
    s.on("state", (snap: SnapshotFor<R>) => {
      stateRef.current = snap;
      setState(snap);
    });
    // The server emits "state" before "events", so the snapshot passed here already reflects them.
    s.on("events", (evs: EngineEvent[]) => {
      setLastEvents(evs);
      onEventsRef.current?.(evs, stateRef.current);
    });
    s.on("host", (line: HostLine) => onHostRef.current?.(line));
    return () => {
      s.disconnect();
      socketRef.current = null;
    };
  }, [room, role, auth.token, auth.key]);

  const send = useCallback(<T extends Ack = Ack>(event: string, payload?: unknown, timeoutMs = 5_000) => {
    return new Promise<T>((resolve) => {
      const s = socketRef.current;
      if (!s?.connected) return resolve({ ok: false, reason: "offline" } as T);
      s.timeout(timeoutMs).emit(event, payload ?? {}, (err: Error | null, ack: T) => resolve(err ? ({ ok: false, reason: "timeout" } as T) : ack));
    });
  }, []);

  return { state, connected, error, lastEvents, send };
}

export const usd = (cents: number | null | undefined) =>
  cents === null || cents === undefined
    ? "—"
    : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export const STATUS_LABEL: Record<string, string> = {
  waiting: "Waiting to open",
  open: "Bidding open",
  going_once: "Going once",
  going_twice: "Going twice",
  sold: "Hammer down",
  passed: "Passed",
};

export const REJECT_COPY: Record<string, string> = {
  below_minimum: "Someone got there first. Try the new price.",
  already_high_bidder: "You already have the top bid.",
  exceeds_hold: "That's above your remaining hold.",
  above_max_jump: "That jump is too big for this lot.",
  no_live_lot: "Bidding on this lot has closed.",
  wrong_lot: "The lot changed. Try again.",
  paused: "The auction is paused for a moment.",
  not_a_bidder: "Join the room to bid.",
  offline: "You're offline. Reconnecting…",
  timeout: "No answer from the room. Try again.",
};
