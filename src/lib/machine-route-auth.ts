import "server-only";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { type CurrentUser, requireRole } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { NotConfiguredError, UnauthorizedTokenError } from "@/lib/errors";
import { bearerToken, safeEqual } from "@/lib/machine-auth";

export type RouteCaller = { kind: "token" } | { kind: "admin"; actor: CurrentUser };

/**
 * Auth for routes that accept a bearer secret (the scheduled workflow) or a signed-in admin
 * (a button in the UI). The token path is checked first.
 *
 * - Token sent: 503 when the secret is unset, 401 when it is wrong.
 * - No token: an admin session is required (401 signed out, 403 not admin), and when the secret is
 *   unset and nobody is signed in the endpoint answers 503, so it is plainly closed.
 * - The session path also requires our own Origin: other *.breakthruventures.ai apps count as
 *   same-site, so Lax cookies alone don't stop them posting here with the admin's session.
 */
export async function authorizeTokenOrAdmin(request: Request, secret: string | undefined): Promise<RouteCaller> {
  const token = bearerToken(request);
  if (token !== null) {
    if (!secret) throw new NotConfiguredError();
    if (!safeEqual(token, secret)) throw new UnauthorizedTokenError();
    return { kind: "token" };
  }
  let actor: CurrentUser;
  try {
    actor = await requireRole("admin");
  } catch (err) {
    if (err instanceof UnauthorizedError && !secret) throw new NotConfiguredError();
    throw err;
  }
  const origin = request.headers.get("origin");
  if (origin !== new URL(env().APP_URL).origin) throw new ForbiddenError("Cross-origin request refused.");
  return { kind: "admin", actor };
}
