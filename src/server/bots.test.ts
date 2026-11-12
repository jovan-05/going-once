import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db/db";
import { DEMO_LOTS } from "../db/seed-data";
import { highBid, minNextBid, type EngineEvent } from "../engine";
import { DemoDirector, PERSONAS } from "./bots";
import { RoomManager } from "./rooms";

/** Small deterministic RNG so runs are repeatable. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

let rooms: RoomManager;
let demo: DemoDirector;
let events: EngineEvent[];

function setup(seed = 1, roomId = "demo-t") {
  rooms = new RoomManager(openDb(":memory:"));
  demo = new DemoDirector({ rooms, rng: seeded(seed), timing: { advanceMs: 3_000, openMs: 1_000, firstOpenMs: 1_000 } });
  events = [];
  rooms.onChange((id, evs) => {
    events.push(...evs);
    demo.handleEvents(id, evs);
  });
  rooms.createRoom({ id: roomId, name: "Demo", isDemo: true, lots: DEMO_LOTS });
  rooms.start(100);
  return roomId;
}

beforeEach(() => vi.useFakeTimers({ now: 1_700_000_000_000 }));
afterEach(() => {
  demo?.stop();
  rooms?.stop();
  vi.useRealTimers();
});

describe("demo bots", () => {
  it("adds five labelled bots with simulated holds, only in demo rooms", () => {
    const id = setup();
    demo.seedBots(id);
    const bots = Object.values(rooms.get(id)!.state.bidders);
    expect(bots.map((b) => b.name).sort()).toEqual(PERSONAS.map((p) => p.name).sort());
    expect(bots.every((b) => b.isBot && b.simulatedHold)).toBe(true);

    rooms.createRoom({ id: "real", name: "Real", isDemo: false, lots: DEMO_LOTS });
    expect(() => demo.seedBots("real")).toThrow(/bots_only_in_demo/);
  });

  it("runs a lot on its own: bots bid at the minimum, within their holds, and it sells", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const id = setup(seed, `demo-${seed}`);
      demo.seedBots(id);
      demo.start(id);
      vi.advanceTimersByTime(120_000);
      const bids = events.filter((e) => e.type === "bid_accepted");
      const lot = rooms.get(id)!.state.lots[0]!;
      expect(["sold", "passed"]).toContain(lot.status);
      if (lot.status === "sold") expect(bids.length).toBeGreaterThan(0);
      // every bid was exactly one increment above the previous (the minimum)
      for (let i = 1; i < lot.bids.length; i++) expect(lot.bids[i]!.amountCents - lot.bids[i - 1]!.amountCents).toBe(lot.incrementCents);
      for (const b of Object.values(rooms.get(id)!.state.bidders)) expect(b.wonCents).toBeLessThanOrEqual(b.holdCents);
      demo.stop();
      rooms.stop();
    }
  });

  it("lets a human who keeps bidding win the lot", () => {
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const id = setup(seed, `demo-h${seed}`);
      demo.seedBots(id);
      expect(rooms.dispatch(id, { type: "add_bidder", bidder: { id: "judge", name: "Judge", showName: true, holdCents: 1000_00, simulatedHold: true } }).ok).toBe(true);
      // the first human in opens lot 1 shortly
      vi.advanceTimersByTime(1_100);
      const lot = () => rooms.get(id)!.currentLot!;
      expect(lot().status).toBe("open");
      // the judge bids whenever they're not the high bidder, after a human pause
      for (let t = 0; t < 120 && lot().status !== "sold" && lot().status !== "passed"; t++) {
        if (highBid(lot())?.bidderId !== "judge" && t % 3 === 0) rooms.dispatch(id, { type: "bid", bidderId: "judge", lotId: lot().id, amountCents: minNextBid(lot()) });
        vi.advanceTimersByTime(1_000);
      }
      expect(lot().status).toBe("sold");
      expect(lot().winnerId).toBe("judge");
      demo.stop();
      rooms.stop();
    }
  });

  it("autopilot moves to the next lot and opens it", () => {
    const id = setup(7);
    demo.seedBots(id);
    demo.start(id);
    vi.advanceTimersByTime(120_000);
    const types = events.map((e) => e.type);
    expect(types).toContain("lot_advanced");
    expect(types.filter((t) => t === "lot_opened").length).toBeGreaterThanOrEqual(2);
  });

  it("leaves rooms without bots alone", () => {
    const id = setup(8);
    rooms.dispatch(id, { type: "add_bidder", bidder: { id: "h", name: "H", showName: true, holdCents: 100_00, simulatedHold: true } });
    vi.advanceTimersByTime(10_000);
    expect(rooms.get(id)!.currentLot!.status).toBe("waiting");
    expect(demo.isDirected(id)).toBe(false);
  });
});
