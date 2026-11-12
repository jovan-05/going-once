import { defineConfig } from "vitest/config";

// Unit tests only; e2e/ is Playwright (npm run e2e) and lab/ is the 3D playground.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
