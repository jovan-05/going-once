/**
 * `npm run seed` resets the database and loads the demo event.
 * On boot, `ensureSeeded` loads it only if the room is missing.
 */
import { rmSync } from "node:fs";
import { DEMO_EVENT_NAME, DEMO_LOTS } from "./seed-data";
import { openDb } from "./db";
import { RoomManager } from "../server/rooms";

export const SEED_ROOM = "riverside";

export function ensureSeeded(rooms: RoomManager) {
  if (rooms.get(SEED_ROOM)) return;
  const { clerkToken } = rooms.createRoom({
    id: SEED_ROOM,
    name: DEMO_EVENT_NAME,
    isDemo: true,
    lots: DEMO_LOTS,
    clerkToken: process.env.CLERK_KEY || undefined,
  });
  const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  console.log(`[seed] room "${SEED_ROOM}" created. Clerk: ${base}/clerk/${SEED_ROOM}?key=${clerkToken}`);
}

const isMain = process.argv[1] && /seed\.ts$/.test(process.argv[1]);
if (isMain) {
  const path = process.env.DATABASE_PATH ?? "./data/going-once.db";
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  const db = openDb(path);
  ensureSeeded(new RoomManager(db));
  db.close();
  console.log(`[seed] database reset at ${path}`);
}
