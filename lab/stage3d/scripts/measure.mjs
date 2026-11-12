// Lab-only measurement: opens the playground in Chromium at 1920x1080, reports
// console errors, GPU, load time, fps / draw calls / triangles during the demo
// lot and stress test, GPU-resource and JS-heap growth over 200 bids, reduced
// motion, and saves screenshots. Runs headed by default: headless Chromium on
// Windows adds 0.5-1 s capture stalls that a real window does not have.
// Usage: node scripts/measure.mjs [url] [--headless] [--shots=dir] [--only=phase]
import { chromium } from "playwright";

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http")) ?? "http://localhost:5179/";
const headed = !args.includes("--headless");
const shotsDir = (args.find((a) => a.startsWith("--shots=")) ?? "--shots=assets").slice(8);
const only = (args.find((a) => a.startsWith("--only=")) ?? "").slice(7);

const browser = await chromium.launch({
  headless: !headed,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-precise-memory-info", "--js-flags=--expose-gc"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const wait = (ms) => page.waitForTimeout(ms);
const stats = () => page.evaluate(() => window.__lab.stats());
const act = (name) => page.evaluate((n) => window.__lab.actions[n](), name);
const shot = (name) => page.screenshot({ path: `${shotsDir}/${name}.png` });

async function sample(ms) {
  const out = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await wait(250);
    out.push(await stats());
  }
  return out;
}
async function frameTimes(ms) {
  return page.evaluate(async (ms) => {
    const d = [];
    let last = performance.now();
    const t0 = last;
    while (performance.now() - t0 < ms) {
      await new Promise((r) => requestAnimationFrame(r));
      const n = performance.now();
      d.push(n - last);
      last = n;
    }
    d.sort((a, b) => a - b);
    const q = (p) => +d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(1);
    return { avgFps: +(d.length / (ms / 1000)).toFixed(1), p50ms: q(0.5), p95ms: q(0.95), p99ms: q(0.99), maxMs: q(1), over33ms: d.filter((x) => x > 33.4).length, frames: d.length };
  }, ms);
}
function summary(samples) {
  const busy = samples.filter((s) => s && s.rendering === "continuous");
  const fps = busy.map((s) => s.fps).filter((f) => f > 0);
  return {
    fpsMin: Math.min(...fps),
    fpsMedian: fps.sort((a, b) => a - b)[Math.floor(fps.length / 2)],
    callsMax: Math.max(...samples.map((s) => s.calls)),
    trisMax: Math.max(...samples.map((s) => s.triangles)),
  };
}

await page.goto(url);
await page.evaluate(() => window.__lab.ready());
const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
});
const report = { gpu, loadMs: Math.round(await page.evaluate(() => window.__lab.loadMs())) };
await wait(600);
if (!only || only === "idle") await shot("lab-idle");

if (!only || only === "demo") {
  await act("demo");
  const demoSamples = [];
  const marks = { 2000: "lab-first-bid", 5800: "lab-bids", 9000: "lab-late-bid", 13380: "lab-hammer", 14800: "lab-sold" };
  const t0 = Date.now();
  for (const [ms, name] of Object.entries(marks)) {
    while (Date.now() - t0 < Number(ms)) {
      await wait(200);
      demoSamples.push(await stats());
    }
    await shot(name);
  }
  demoSamples.push(...(await sample(2500)));
  report.demo = summary(demoSamples);
}

if (!only || only === "stress") {
  await act("open");
  await wait(1300);
  await act("stress");
  const [ft, st] = await Promise.all([frameTimes(5400), sample(5400)]);
  report.stress = { ...summary(st), frameTimes: ft };
  await shot("lab-stress-end");
}

if (!only || only === "demoframes") {
  await act("demo");
  report.demoFrameTimes = await frameTimes(16500);
}

if (!only || only === "reduced") {
  await page.click("#t-reduced"); // disposes and recreates the stage
  await page.evaluate(() => window.__lab.ready());
  await act("demo");
  const t0 = Date.now();
  const st = [];
  while (Date.now() - t0 < 13600) { await wait(250); st.push(await stats()); }
  await shot("lab-reduced-hammer");
  st.push(...(await sample(2500)));
  report.reduced = summary(st);
  await page.click("#t-reduced");
  await page.evaluate(() => window.__lab.ready());
}

if (!only || only === "memory") {
  const heap = async () => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("HeapProfiler.collectGarbage");
    await cdp.send("HeapProfiler.collectGarbage");
    const { usedSize } = await cdp.send("Runtime.getHeapUsage");
    await cdp.detach();
    return usedSize;
  };
  await act("open");
  await wait(1500);
  const before = { heap: await heap(), ...(await stats()) };
  await act("bids200");
  await wait(21500);
  await act("passed");
  await wait(5000);
  const after = { heap: await heap(), ...(await stats()) };
  report.memory = {
    heapBeforeKB: Math.round(before.heap / 1024),
    heapAfterKB: Math.round(after.heap / 1024),
    geometries: `${before.geometries} -> ${after.geometries}`,
    textures: `${before.textures} -> ${after.textures}`,
  };
}

if (!only || only === "idle") {
  await wait(11000);
  report.idle = await stats();
}

if (only === "final") {
  // The deliverable screenshot: mock overlay on, control panel hidden.
  await page.evaluate(() => (document.getElementById("panel").style.display = "none"));
  await act("demo");
  await wait(9000); // just after the late bid, the leader paddle up in the spotlight
  await page.screenshot({ path: "assets/screenshot-1920.png" });
  await page.evaluate(() => (document.getElementById("panel").style.display = ""));
}

report.consoleErrors = errors;
console.log(JSON.stringify(report, null, 2));
await browser.close();
