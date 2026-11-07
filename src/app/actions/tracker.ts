"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/actions/form-state";
import { requireRole } from "@/lib/auth/session";
import { regenerateSummary } from "@/lib/health-summary";
import { errorInfo } from "@/lib/http";
import { runSync } from "@/lib/sync";
import * as tracker from "@/lib/tracker";

/**
 * Server actions for the admin UI. They run the same data functions as the API routes,
 * after requireRole("admin"), and return a result object instead of throwing, because
 * production builds hide thrown error messages from the client.
 */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

/** Prefer the first field error so a form can show "https on an allowed host" rather than "Invalid input". */
function actionError(err: unknown): { status: number; error: string } {
  const { status, body } = errorInfo(err);
  if (Array.isArray(body.issues)) {
    for (const issue of body.issues) {
      if (issue && typeof issue === "object" && "message" in issue && typeof issue.message === "string" && issue.message) {
        return { status, error: issue.message };
      }
    }
  }
  return { status, error: body.error };
}

async function run<T>(n: unknown, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    if (typeof n === "number" || typeof n === "string") revalidatePath(`/apps/${n}`);
    revalidatePath("/");
    return { ok: true, data };
  } catch (err) {
    const { status, error } = actionError(err);
    return { ok: false, status, error };
  }
}

function formNumber(formData: FormData): number | null {
  const raw = formData.get("n");
  if (typeof raw !== "string" || !/^\d{1,7}$/.test(raw)) return null;
  return Number(raw);
}

function formText(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw.trim() : "";
}

function failed(error: string): FormState {
  return { error, message: null };
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

export async function transitionFormAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const n = formNumber(formData);
  if (n === null) return failed("Unknown app.");
  const to = formText(formData, "to");
  const reason = formText(formData, "reason");
  const result = await transitionAction(n, { to, reason: reason || undefined });
  if (!result.ok) return failed(result.error);
  return { error: null, message: `Moved from ${result.data.from} to ${result.data.to}.` };
}

export async function healthUrlFormAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const n = formNumber(formData);
  if (n === null) return failed("Unknown app.");
  if (formData.get("intent") === "clear") {
    const result = await setHealthUrlAction(n, null);
    return result.ok ? { error: null, message: "Health URL cleared." } : failed(result.error);
  }
  const url = formText(formData, "healthUrl");
  if (!url) return failed("Enter a health URL, or clear the current one.");
  const result = await setHealthUrlAction(n, url);
  return result.ok ? { error: null, message: "Health URL saved." } : failed(result.error);
}

export async function addNoteFormAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const n = formNumber(formData);
  if (n === null) return failed("Unknown app.");
  const body = formText(formData, "body");
  if (!body) return failed("Write a note before saving.");
  const result = await addNoteAction(n, body);
  return result.ok ? { error: null, message: "Note added." } : failed(result.error);
}

export async function deleteNoteFormAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const n = formNumber(formData);
  if (n === null) return failed("Unknown app.");
  const result = await deleteNoteAction(n, formText(formData, "id"));
  return result.ok ? { error: null, message: "Note deleted." } : failed(result.error);
}

export async function regenerateFormAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const n = formNumber(formData);
  if (n === null) return failed("Unknown app.");
  const result = await regenerateSummaryAction(n);
  return result.ok ? { error: null, message: "Summary regenerated." } : failed(result.error);
}

/** Admin "Run sync now". Same work as POST /api/sync, without putting the token in the browser. */
export async function runSyncFormAction(): Promise<FormState> {
  try {
    await requireRole("admin");
    const data = await runSync();
    revalidatePath("/", "layout");
    const catalog = data.catalog.error ? "Catalog sync failed." : `Catalog updated ${data.catalog.updated}.`;
    const health = data.health;
    return {
      error: null,
      message: `${catalog} Health: ${health.checked} checked, ${health.ok} ok, ${health.down} down, ${health.skipped} skipped.`,
    };
  } catch (err) {
    return failed(actionError(err).error);
  }
}
