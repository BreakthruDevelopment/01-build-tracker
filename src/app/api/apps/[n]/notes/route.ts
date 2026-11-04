import { requireRole } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { addNote } from "@/lib/tracker";

export const dynamic = "force-dynamic";

/** POST /api/apps/:n/notes (admin). Body: { body }. */
export async function POST(request: Request, ctx: { params: Promise<{ n: string }> }) {
  try {
    const user = await requireRole("admin");
    const { n } = await ctx.params;
    const note = await addNote(user, n, await request.json().catch(() => ({})));
    return Response.json({ note }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
