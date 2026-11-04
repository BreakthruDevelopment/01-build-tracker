"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { errorInfo } from "@/lib/http";
import { regenerateSummary } from "@/lib/health-summary";
import * as tracker from "@/lib/tracker";

/**
 * Server actions for the admin UI. They run the same data functions as the API routes,
 * after requireRole("admin"), and return a result object instead of throwing, because
 * production builds hide thrown error messages from the client.
 */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

async function run<T>(n: unknown, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    if (typeof n === "number" || typeof n === "string") revalidatePath(`/apps/${n}`);
    revalidatePath("/");
    return { ok: true, data };
  } catch (err) {
    const { status, body } = errorInfo(err);
    return { ok: false, status, error: body.error };
  }
}

export async function transitionAction(n: number, input: { to: string; reason?: string }) {
  return run(n, async () => tracker.transition(await requireRole("admin"), n, input));
}

export async function setHealthUrlAction(n: number, url: string | null) {
  return run(n, async () => tracker.setHealthUrl(await requireRole("admin"), n, url));
}

export async function addNoteAction(n: number, body: string) {
  return run(n, async () => tracker.addNote(await requireRole("admin"), n, { body }));
}

export async function deleteNoteAction(n: number, id: string) {
  return run(n, async () => tracker.deleteNote(await requireRole("admin"), n, id));
}

/** Regenerate today's AI summary for one app (once per app per hour). */
export async function regenerateSummaryAction(n: number) {
  return run(n, async () => regenerateSummary(await requireRole("admin"), n));
}
