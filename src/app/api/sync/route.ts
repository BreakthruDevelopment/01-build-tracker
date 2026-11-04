import { env } from "@/lib/env";
import { errorResponse } from "@/lib/http";
import { authorizeTokenOrAdmin } from "@/lib/machine-route-auth";
import { runSync } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 25;

/**
 * POST /api/sync: refresh the catalog and poll health. Bearer SYNC_TOKEN (the scheduled workflow)
 * or a signed-in admin ("Run sync now"); see authorizeTokenOrAdmin for the rules.
 */
export async function POST(request: Request) {
  try {
    await authorizeTokenOrAdmin(request, env().SYNC_TOKEN);
    return Response.json(await runSync());
  } catch (err) {
    return errorResponse(err);
  }
}
