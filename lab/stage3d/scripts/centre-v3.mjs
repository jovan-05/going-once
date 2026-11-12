// Lab-only: quick centre-clear check for v3 at the wide shot and the rest shot.
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto("http://localhost:5179/v3.html");
await page.evaluate(() => window.__lab.ready());
await page.waitForTimeout(300);
const short = (r) => r.intrusions.map((i) => `${i.what} x${i.box.x0}-${i.box.x1} y${i.box.y0}-${i.box.y1}`);
const wide = await page.evaluate(() => window.__labCentre());
await page.evaluate(() => window.__lab.actions.open());
await page.waitForTimeout(1800);
const rest = await page.evaluate(() => window.__labCentre());
console.log(JSON.stringify({ wide: short(wide), rest: short(rest) }, null, 1));
await browser.close();
