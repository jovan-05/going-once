// Copies kokoro-js's self-contained browser build into public/ so the stage's
// Web Worker can load it from our own origin, outside the Next bundler.
// Runs automatically before `dev` and `build`.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";

const src = "node_modules/kokoro-js/dist/kokoro.web.js";
const dir = "public/vendor/kokoro";
if (!existsSync(src)) {
  console.warn(`[kokoro] ${src} missing; run npm install. The stage will use the browser voice.`);
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
copyFileSync(src, `${dir}/kokoro.web.js`);
copyFileSync("node_modules/kokoro-js/LICENSE", `${dir}/LICENSE`);
console.log("[kokoro] browser build copied to public/vendor/kokoro/");
