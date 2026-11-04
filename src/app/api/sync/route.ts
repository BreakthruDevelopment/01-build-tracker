import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { requireRole } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { NotConfiguredError, UnauthorizedTokenError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { bearerToken, safeEqual } from "@/lib/machine-auth";
import { runSync } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 25;

/**
 * POST /api/sync: refresh the catalog and poll health. Bearer SYNC_TOKEN (the scheduled workflow)
 * or a signed-in admin ("Run sync now"). The token path is checked first.
 */
export async function POST(request: Request) {
  try {
    const secret = env().SYNC_TOKEN;
    const token = bearerToken(request);
    if (token !== null) {
      if (!secret) throw new NotConfiguredError();
      if (!safeEqual(token, secret)) throw new UnauthorizedTokenError();
    } else {
      try {
        await requireRole("admin");
      } catch (err) {
        // Signed out and no token configured: the endpoint is closed, say so.
        if (err instanceof UnauthorizedError && !secret) throw new NotConfiguredError();
        throw err;
      }
      // Session path: other *.breakthruventures.ai apps count as same-site, so Lax cookies alone
      // don't stop them posting here with the admin's session. Require our own Origin.
      const origin = request.headers.get("origin");
      if (origin !== new URL(env().APP_URL).origin) throw new ForbiddenError("Cross-origin request refused.");
    }
    return Response.json(await runSync());
  } catch (err) {
    return errorResponse(err);
  }
}
