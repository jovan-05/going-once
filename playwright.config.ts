import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

/**
 * One smoke test of the demo room (CLAUDE.md). It runs the real server with an
 * in-memory database and no .env, so PayPal and the AI are off and nothing
 * leaves the machine: bots, engine, sockets, stage and judge view only.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  retries: 0,
  use: { baseURL: `http://localhost:${PORT}`, ...devices["Desktop Chrome"], viewport: { width: 1600, height: 900 } },
  webServer: {
    command: "node scripts/copy-kokoro.mjs && npx tsx server.ts",
    url: `http://localhost:${PORT}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: { PORT: String(PORT), DATABASE_PATH: ":memory:", NODE_ENV: "development", NEXT_DIST_DIR: ".next-e2e", AI_API_KEY: "", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "" },
  },
});
