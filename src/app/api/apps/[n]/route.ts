import { requireRole } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { getApp, setHealthUrl } from "@/lib/tracker";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ n: string }> };

/** GET /api/apps/:n: public detail (history shows "system" or "admin" only). */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const { n } = await ctx.params;
    return Response.json({ app: await getApp(n) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/apps/:n (admin). Body: { health_url: string | null }. */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const user = await requireRole("admin");
    const { n } = await ctx.params;
    const body = (await request.json().catch(() => null)) as { health_url?: unknown } | null;
    if (!body || typeof body !== "object" || !("health_url" in body)) {
      return Response.json({ error: "health_url is required (a string, or null to clear)" }, { status: 400 });
    }
    return Response.json({ app: await setHealthUrl(user, n, body.health_url) });
  } catch (err) {
    return errorResponse(err);
  }
}
