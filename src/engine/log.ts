import { sha256Hex } from "./hash";
import type { EngineEvent, EventLogEntry } from "./types";

export const GENESIS_HASH = "0".repeat(64);

/** Canonical JSON: object keys sorted, so the hash doesn't depend on insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function entryHash(e: Omit<EventLogEntry, "hash">): string {
  return sha256Hex(canonicalJson({ seq: e.seq, at: e.at, type: e.type, data: e.data, prevHash: e.prevHash }));
}

export function appendToLog(log: EventLogEntry[], ev: EngineEvent): EventLogEntry {
  const prev = log[log.length - 1];
  const base = { seq: log.length, at: ev.at, type: ev.type, data: ev.data, prevHash: prev ? prev.hash : GENESIS_HASH };
  const entry: EventLogEntry = { ...base, hash: entryHash(base) };
  log.push(entry);
  return entry;
}

/** Returns the index of the first broken entry, or -1 if the chain is intact. */
export function verifyLog(log: readonly EventLogEntry[]): number {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < log.length; i++) {
    const e = log[i]!;
    if (e.seq !== i || e.prevHash !== prevHash || e.hash !== entryHash(e)) return i;
    prevHash = e.hash;
  }
  return -1;
}
