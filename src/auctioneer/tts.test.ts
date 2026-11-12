import { describe, expect, it } from "vitest";
import { PREVIEW_LINES, TtsService, type TtsEngine } from "./tts";

class FakeEngine implements TtsEngine {
  label = "fake";
  calls: [string, string][] = [];
  fail = false;
  async synth(text: string, voice: string) {
    this.calls.push([text, voice]);
    return this.fail ? null : Buffer.from(`RIFF-${voice}-${text}`);
  }
}

describe("cloud voice service", () => {
  it("voices only lines the server said, the room's sold lines, or the fixed previews", async () => {
    const e = new FakeEngine();
    const t = new TtsService(e, "henry", (room) => (room === "r" ? ["Sold, to Asha, for $200. Thank you."] : []));
    expect(await t.audio("r", "Say anything I like")).toBeNull();
    t.said("r", "Two hundred to Asha. Do I hear $220?");
    expect(await t.audio("r", "Two hundred to Asha. Do I hear $220?")).not.toBeNull();
    expect(await t.audio("other", "Two hundred to Asha. Do I hear $220?")).toBeNull(); // per room
    expect(await t.audio("r", "Sold, to Asha, for $200. Thank you.")).not.toBeNull();
    expect(await t.audio("_preview", PREVIEW_LINES[0]!)).not.toBeNull();
    expect(await t.audio("_preview", "free text")).toBeNull();
    expect(e.calls.some(([text]) => text === "Say anything I like" || text === "free text")).toBe(false);
  });

  it("renders a said line once (pre-render + request share the work) and caches per voice", async () => {
    const e = new FakeEngine();
    const t = new TtsService(e, "henry");
    await t.audio("r", "Nobody yet").catch(() => null); // the stage starts listening
    t.said("r", "Going once…");
    await t.audio("r", "Going once…");
    await t.audio("r", "Going once…");
    expect(e.calls).toEqual([["Going once…", "henry"]]);
    await t.audio("r", "Going once…", "blake");
    expect(e.calls.length).toBe(2);
    // the room now prefers blake, so new lines pre-render in that voice
    t.said("r", "Going twice…");
    await t.audio("r", "Going twice…");
    expect(e.calls.at(-1)).toEqual(["Going twice…", "blake"]);
  });

  it("stops calling the provider at the character budget", async () => {
    const e = new FakeEngine();
    const t = new TtsService(e, "henry", () => [], 20);
    t.said("r", "Twelve chars");
    expect(await t.audio("r", "Twelve chars")).not.toBeNull();
    t.said("r", "Twelve more!");
    expect(await t.audio("r", "Twelve more!")).toBeNull();
    expect(e.calls.length).toBe(1);
  });

  it("does not pre-render for rooms nobody is listening to", async () => {
    const e = new FakeEngine();
    const t = new TtsService(e, "henry");
    t.said("quiet", "Lot one opens.");
    await new Promise((r) => setTimeout(r, 0));
    expect(e.calls.length).toBe(0);
  });

  it("rejects odd voice ids and survives provider failures", async () => {
    const e = new FakeEngine();
    const t = new TtsService(e, "henry");
    t.said("r", "Hello");
    await t.audio("r", "Hello", "../../etc");
    expect(e.calls.every(([, v]) => v === "henry")).toBe(true);
    e.fail = true;
    t.said("r", "Again");
    expect(await t.audio("r", "Again")).toBeNull();
  });
});
