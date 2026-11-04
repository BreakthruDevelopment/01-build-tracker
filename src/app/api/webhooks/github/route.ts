import { env } from "@/lib/env";
import { NotConfiguredError, UnauthorizedTokenError } from "@/lib/errors";
import { handleGithubEvent } from "@/lib/github-webhook";
import { errorResponse } from "@/lib/http";
import { log } from "@/lib/log";
import { parseJsonBody, readBodyCapped, verifyGithubSignature } from "@/lib/machine-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 1024 * 1024; // 1 MB, per the spec

/**
 * POST /api/webhooks/github (GitHub, HMAC). The body is read once as bytes, the signature is
 * checked over exactly those bytes, and only then is it parsed. Never logs the body or signature.
 */
export async function POST(request: Request) {
  try {
    const secret = env().GITHUB_WEBHOOK_SECRET;
    if (!secret) throw new NotConfiguredError();
    const bytes = await readBodyCapped(request, MAX_BODY);
    if (!verifyGithubSignature(bytes, request.headers.get("x-hub-signature-256"), secret)) {
      log.warn("webhook.bad_signature");
      throw new UnauthorizedTokenError();
    }
    const outcome = await handleGithubEvent(
      request.headers.get("x-github-event") ?? "",
      request.headers.get("x-github-delivery"),
      parseJsonBody(bytes),
    );
    return Response.json(outcome.body, { status: outcome.status });
  } catch (err) {
    return errorResponse(err);
  }
}
