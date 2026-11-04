import { requireRole } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { deleteNote } from "@/lib/tracker";

export const dynamic = "force-dynamic";

/** DELETE /api/apps/:n/notes/:id (admin; only the note's author). */
export async function DELETE(_request: Request, ctx: { params: Promise<{ n: string; id: string }> }) {
  try {
    const user = await requireRole("admin");
    const { n, id } = await ctx.params;
    await deleteNote(user, n, id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
