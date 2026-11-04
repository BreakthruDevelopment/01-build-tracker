import { requireRole } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { transition } from "@/lib/tracker";

export const dynamic = "force-dynamic";

/** POST /api/apps/:n/transition (admin). Body: { to, reason? }. 404, 409 or 400 per the state machine. */
export async function POST(request: Request, ctx: { params: Promise<{ n: string }> }) {
  try {
    const user = await requireRole("admin");
    const { n } = await ctx.params;
    const result = await transition(user, n, await request.json().catch(() => ({})));
    return Response.json({ transition: result });
  } catch (err) {
    return errorResponse(err);
  }
}
