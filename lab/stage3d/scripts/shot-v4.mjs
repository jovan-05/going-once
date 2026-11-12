// Lab-only: v3 screenshots through the demo lot, plus the centre-clear check
// (nothing may cross the price area) at the wide shot, the rest shot and the
// hammer push-in. Usage: node scripts/shot-v3.mjs [outDir]
import { chromium } from "playwright";

const out = process.argv[2] ?? "assets";
const browser = await chromium.launch({ headless: false, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:5179/v4.html");
await page.evaluate(() => window.__lab.ready());
await page.evaluate(() => (document.getElementById("panel").style.display = "none"));
const mock = (on) => page.evaluate((v) => (document.getElementById("mock").hidden = !v), on);
const centre = () => page.evaluate(() => window.__labCentre());
const label = () =>
  page.evaluate(() => {
    const l = [...document.querySelectorAll("#frame div[aria-hidden] > div")][0];
    if (!l) return null;
    const r = l.getBoundingClientRect();
    const spans = [...l.querySelectorAll("span")].map((s) => ({ text: s.textContent, px: getComputedStyle(s).fontSize, shown: s.style.display !== "none" }));
    return { opacity: l.style.opacity, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), spans };
  });
const t0 = { v: 0 };
const until = async (ms) => {
  const left = ms - (Date.now() - t0.v);
  if (left > 0) await page.waitForTimeout(left);
};
const report = {};

await page.waitForTimeout(800);
report.centreWide = await centre();
await mock(true);
await page.screenshot({ path: `${out}/v4-idle.png` });

await page.evaluate(() => window.__lab.actions.demo());
t0.v = Date.now();
await until(1950); // first bid, paddle up
report.centreRest = await centre();
report.labelFirstBid = await label();
await page.screenshot({ path: `${out}/v4-bid-raised.png` });
await until(3950); // bot bid from paddle 21 just raised
report.labelBot = await label();
await page.screenshot({ path: `${out}/v4-bot-bid.png` });
await until(5250); // previous leader settled, glow on
await mock(false);
await page.screenshot({ path: `${out}/v4-settled-nooverlay.png` });
await mock(true);
await until(8650); // late bid
await page.screenshot({ path: `${out}/v4-late-bid.png` });
await until(13870); // hammer: close-up on the strike
report.centreHammer = await centre();
await page.screenshot({ path: `${out}/v4-hammer-sweep.png` });
await until(15700); // winner medium shot
await mock(false);
await page.screenshot({ path: `${out}/v4-hammer-nooverlay.png` });
await mock(true);
await until(19600); // after sold_confirmed: curtains drawn
await page.screenshot({ path: `${out}/v4-between-lots.png` });
report.stats = await page.evaluate(() => window.__lab.stats());
report.errors = errors;
console.log(JSON.stringify(report, null, 1));
await browser.close();
