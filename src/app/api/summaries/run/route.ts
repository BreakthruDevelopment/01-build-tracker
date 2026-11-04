import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/rbac";
import { env } from "@/lib/env";
import { errorResponse } from "@/lib/http";
import { regenerateSummary, runDailySummaries } from "@/lib/health-summary";
import { parseJsonBody, readBodyCapped } from "@/lib/machine-auth";
import { authorizeTokenOrAdmin } from "@/lib/machine-route-auth";
import { appNumber } from "@/lib/tracker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 25;

const body = z.object({ n: appNumber.optional() }).strict();

/**
 * POST /api/summaries/run: bearer SYNC_TOKEN (the daily workflow) or a signed-in admin.
 * No body: summarize up to 6 apps that lack today's summary and return {done, remaining}.
 * Admin only, body {n}: regenerate one app (once per app per hour).
 */
export async function POST(request: Request) {
  try {
    const caller = await authorizeTokenOrAdmin(request, env().SYNC_TOKEN);
    const bytes = await readBodyCapped(request, 1024);
    const { n } = bytes.length === 0 ? {} : body.parse(parseJsonBody(bytes));
    if (n === undefined) return Response.json(await runDailySummaries(caller.kind === "admin" ? caller.actor : "system"));
    if (caller.kind !== "admin") throw new ForbiddenError("Only an admin can regenerate a summary.");
    return Response.json(await regenerateSummary(caller.actor, n));
  } catch (err) {
    return errorResponse(err);
  }
}
