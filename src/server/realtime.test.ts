/**
 * M3 check, automated: stage, clerk and two paddles stay in sync over real
 * sockets; a paddle that drops and reconnects gets its full state back.
 */
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import { openDb } from "../db/db";
import { DEMO_LOTS } from "../db/seed-data";
import { createAppServer } from "./app";

type Snap = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let app: ReturnType<typeof createAppServer>;
let base = "";
let clerkKey = "";
const sockets: Socket[] = [];

function client(auth: Record<string, unknown>) {
  const s = connect(base, { path: "/socket.io", auth, transports: ["websocket"], forceNew: true, reconnection: false });
  sockets.push(s);
  return s;
}

/** Resolves with the next "state" snapshot that satisfies `pred`. */
function waitState(s: Socket, pred: (x: Snap) => boolean = () => true, ms = 4_000): Promise<Snap> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      s.off("state", on);
      reject(new Error("timed out waiting for state"));
    }, ms);
    const on = (x: Snap) => {
      if (pred(x)) {
        clearTimeout(t);
        s.off("state", on);
        resolve(x);
      }
    };
    s.on("state", on);
  });
}

const emit = (s: Socket, ev: string, payload: unknown = {}) =>
  new Promise<{ ok: boolean; reason?: string }>((resolve) => s.emit(ev, payload, resolve));

async function testBidder(name: string, holdCents: number) {
  const r = await fetch(`${base}/api/dev/rooms/sync/test-bidder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, holdCents }),
  });
  return (await r.json()) as { ok: boolean; token: string; paddle: number };
}

beforeAll(async () => {
  app = createAppServer({ db: openDb(":memory:"), paypal: null, allowTestBidders: true, tickMs: 50, pollMs: 60_000 });
  const created = app.rooms.createRoom({
    id: "sync",
    name: "Sync test",
    isDemo: true,
    lots: DEMO_LOTS.slice(0, 2),
    config: { lullMs: 300, silenceMs: 600, callStepMs: 200, lotDurationMs: 30_000 },
  });
  clerkKey = created.clerkToken;
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  await app.close();
  await new Promise((r) => app.server.close(r));
});

describe("real-time rooms", () => {
  it("keeps stage, clerk and paddles in sync and restores a reconnecting paddle", async () => {
    const asha = await testBidder("Asha", 500_00);
    const ben = await testBidder("Ben", 500_00);
    expect([asha.paddle, ben.paddle]).toEqual([1, 2]);

    const stage = client({ room: "sync", role: "stage" });
    const clerk = client({ room: "sync", role: "clerk", key: clerkKey });
    const pa = client({ room: "sync", role: "paddle", token: asha.token });
    const pb = client({ room: "sync", role: "paddle", token: ben.token });
    const first = await Promise.all([stage, clerk, pa, pb].map((s) => waitState(s)));
    expect(first.map((x) => x.role)).toEqual(["stage", "clerk", "paddle", "paddle"]);
    expect(first[2]!.me.paddle).toBe(1);
    expect(first[3]!.me.paddle).toBe(2);

    // paddles may not run the room
    expect(await emit(pa, "clerk:open")).toEqual({ ok: false, reason: "forbidden" });

    // clerk opens → every screen sees the same version and status
    const opened = [stage, clerk, pa, pb].map((s) => waitState(s, (x) => x.lot?.status === "open"));
    expect(await emit(clerk, "clerk:open")).toEqual({ ok: true });
    const o = await Promise.all(opened);
    expect(new Set(o.map((x) => x.version)).size).toBe(1);

    // Asha bids → stage shows paddle 1 high; Ben sees he's not high
    const lotId = o[0]!.lot.id as string;
    const afterBid = [stage, pa, pb].map((s) => waitState(s, (x) => x.lot?.priceCents === 200_00));
    expect(await emit(pa, "bid", { lotId, amountCents: 200_00 })).toEqual({ ok: true });
    const [st, a, b] = await Promise.all(afterBid);
    expect(st!.lot.high).toMatchObject({ paddle: 1, name: "Asha" });
    expect(a!.me.isHigh).toBe(true);
    expect(b!.me.isHigh).toBe(false);
    expect(JSON.stringify(st)).not.toMatch(/holdCents|remainingCents|token/);

    // stale bid at the same price is refused
    expect(await emit(pb, "bid", { lotId, amountCents: 200_00 })).toMatchObject({ ok: false, reason: "below_minimum" });

    // kill Asha's paddle, reopen it with the same token → full state comes back
    pa.disconnect();
    const pa2 = client({ room: "sync", role: "paddle", token: asha.token });
    const restored = await waitState(pa2);
    expect(restored.me).toMatchObject({ paddle: 1, isHigh: true, remainingCents: 500_00 });
    expect(restored.lot.priceCents).toBe(200_00);

    // the clock sells the lot; everyone sees "sold" and Asha's remaining hold drops
    const sold = [stage, clerk, pa2, pb].map((s) => waitState(s, (x) => x.lot?.status === "sold", 6_000));
    const all = await Promise.all(sold);
    expect(all[0]!.lot.high.paddle).toBe(1);
    expect(all[2]!.me.remainingCents).toBe(300_00);
    expect(all[1]!.allBidders.find((x: Snap) => x.paddle === 1).wonCents).toBe(200_00);
  }, 20_000);

  it("refuses a clerk without the key and unknown rooms", async () => {
    const bad = client({ room: "sync", role: "clerk", key: "nope" });
    await expect(new Promise((_, rej) => bad.on("connect_error", (e) => rej(e)))).rejects.toThrow("clerk_key_required");
    const none = client({ room: "missing", role: "stage" });
    await expect(new Promise((_, rej) => none.on("connect_error", (e) => rej(e)))).rejects.toThrow("unknown_room");
  });
});
