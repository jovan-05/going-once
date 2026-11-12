// Lab-only: v5 screenshots through the demo lot, plus the centre-clear check.
// Usage: node scripts/shot-v5.mjs [outDir]   (dev server on port 5179)
import { chromium } from "playwright";

const out = process.argv[2] ?? "assets";
const browser = await chromium.launch({ headless: false, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:5179/v5.html");
await page.evaluate(() => window.__lab.ready());
await page.evaluate(() => (document.getElementById("panel").style.display = "none"));
const mock = (on) => page.evaluate((v) => (document.getElementById("mock").hidden = !v), on);
const centre = () => page.evaluate(() => window.__labCentre());
const t0 = { v: 0 };
const until = async (ms) => {
  const left = ms - (Date.now() - t0.v);
  if (left > 0) await page.waitForTimeout(left);
};
const shot = async (name, overlay = true) => {
  await mock(overlay);
  await page.screenshot({ path: `${out}/v5-${name}.png` });
};
const report = {};

await page.waitForTimeout(800);
report.centreWide = await centre();

await page.evaluate(() => window.__lab.actions.demo());
t0.v = Date.now();
await until(1900); // first bid: paddle up, ring, heads turning
report.centreRest = await centre();
await shot("bid", false);
await until(2150);
await shot("bid-overlay");
await until(3950); // bot bid
await shot("bot-bid");
await until(8650); // late bid
await shot("late-bid", false);
await until(12600); // going twice: gavel lifted, house hushed
await shot("going-twice", false);
await shot("going-twice-overlay");
await until(13880); // hammer: impact in close-up
await shot("hammer-impact", false);
await until(14000);
await shot("hammer-overlay");
await until(15900); // winner medium shot, gold dust falling
await shot("sold-dust", false);
await until(16400);
await shot("sold-dust-overlay");
await until(20500); // curtains drawn
await shot("between-lots");
report.stats = await page.evaluate(() => window.__lab.stats());
report.errors = errors;
console.log(JSON.stringify(report, null, 1));
await browser.close();
