// Lab-only: screenshots of v2.html with the mock overlay off, during the demo lot.
// Usage: node scripts/shot-v2.mjs [outDir]
import { chromium } from "playwright";
const out = process.argv[2] ?? "assets";
const browser = await chromium.launch({ headless: false, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:5179/v2.html");
await page.evaluate(() => window.__lab.ready());
await page.evaluate(() => { document.getElementById("mock").hidden = true; document.getElementById("panel").style.display = "none"; });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/v2-idle.png` });
await page.evaluate(() => window.__lab.actions.demo());
for (const [ms, n] of [[6000, "v2-bids"], [9000, "v2-late-bid"], [13400, "v2-hammer"]]) {
  await page.waitForTimeout(ms - (n === "v2-bids" ? 0 : n === "v2-late-bid" ? 6000 : 9000));
  await page.screenshot({ path: `${out}/${n}.png` });
}
console.log(JSON.stringify({ stats: await page.evaluate(() => window.__lab.stats()), errors }));
await browser.close();
