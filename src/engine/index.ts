export * from "./types";
export * from "./engine";
export * from "./views";
export * from "./names";
export { verifyLog, canonicalJson, GENESIS_HASH } from "./log";

export const formatUsd = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
