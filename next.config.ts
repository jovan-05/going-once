import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The e2e server uses its own build folder, so it can run beside `npm run dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  devIndicators: false,
  // Phones on the LAN load dev assets from this machine's IP.
  allowedDevOrigins: (process.env.DEV_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  // Cross-origin isolation on the pages that run Kokoro, so its WebAssembly
  // can use several threads (SharedArrayBuffer). "credentialless" still lets
  // the worker fetch the model from Hugging Face and the runtime from jsDelivr.
  async headers() {
    const isolated = [
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
    ];
    return ["/stage/:path*", "/voices", "/kokoro-worker.js", "/vendor/kokoro/:path*"].map((source) => ({ source, headers: isolated }));
  },
};

export default nextConfig;
