import { env } from "@/lib/env";
import { errorResponse } from "@/lib/http";
import { applyIngest } from "@/lib/ingest";
import { parseJsonBody, readBodyCapped, requireBearer } from "@/lib/machine-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 64 * 1024; // 64 KB, per the spec

/** POST /api/ingest (ops monitor, bearer INGEST_TOKEN): the nightly report. 503 when the token is unset. */
export async function POST(request: Request) {
  try {
    requireBearer(request, env().INGEST_TOKEN);
    const bytes = await readBodyCapped(request, MAX_BODY);
    const result = await applyIngest(parseJsonBody(bytes));
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return errorResponse(err);
  }
}
