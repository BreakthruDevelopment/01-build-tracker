import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export type StateKey = "last_sync" | "last_ingest";

/** Record a small JSON summary under a key; /admin reads `last_sync` and `last_ingest` from here. */
export async function setTrackerState(key: StateKey, value: Record<string, unknown>): Promise<void> {
  const now = new Date();
  await db()
    .insert(schema.trackerState)
    .values({ key, value: { at: now.toISOString(), ...value }, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.trackerState.key,
      set: { value: { at: now.toISOString(), ...value }, updatedAt: now },
    });
}

export async function getTrackerState(key: StateKey): Promise<Record<string, unknown> | null> {
  const [row] = await db().select().from(schema.trackerState).where(eq(schema.trackerState.key, key));
  return row?.value ?? null;
}
