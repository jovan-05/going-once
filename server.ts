/**
 * Custom server: our API + Socket.IO + Next.js in one process (CLAUDE.md stack).
 *   npm run dev    → dev mode
 *   npm start      → production (after `npm run build`)
 */
import next from "next";
import { createAppServer } from "./src/server/app";
import { ensureSeeded } from "./src/db/seed";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "0.0.0.0";

const nextApp = next({ dev, hostname, port });
const handle = nextApp.getRequestHandler();

await nextApp.prepare();

const app = createAppServer({
  allowTestBidders: dev && process.env.ALLOW_TEST_BIDDERS === "1",
  // Recording the demo video: slower bots, so every auctioneer line can finish (e.g. 2 = half speed).
  demoTiming: Number(process.env.DEMO_REACT_SCALE) > 0 ? { reactScale: Number(process.env.DEMO_REACT_SCALE) } : undefined,
  fallback: (req, res) => handle(req, res),
});
ensureSeeded(app.rooms);

// Next dev's HMR websocket shares this server with Socket.IO.
const upgrade = (nextApp as unknown as { getUpgradeHandler?: () => (...a: unknown[]) => void }).getUpgradeHandler?.();
if (upgrade) {
  app.server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/socket.io")) upgrade(req, socket, head);
  });
}

app.server.listen(port, hostname, () => {
  console.log(`> Going Once ready on http://localhost:${port} (${dev ? "dev" : "production"})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().finally(() => process.exit(0));
  });
}
