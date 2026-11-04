import { errorResponse } from "@/lib/http";
import { listBoard } from "@/lib/tracker";

export const dynamic = "force-dynamic";

/** GET /api/board: public projection of all apps. No notes, no user data. */
export async function GET() {
  try {
    return Response.json({ apps: await listBoard() });
  } catch (err) {
    return errorResponse(err);
  }
}
