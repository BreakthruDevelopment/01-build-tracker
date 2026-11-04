import { ZodError } from "zod";
import { AiError } from "@/lib/ai/types";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { HttpError } from "@/lib/errors";
import { log } from "@/lib/log";

export type ErrorInfo = { status: number; body: { error: string; issues?: unknown } };

/** Map known errors to a status and a client-safe body; never leak stack traces or internals. */
export function errorInfo(err: unknown): ErrorInfo {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError || err instanceof HttpError) {
    return { status: err.status, body: { error: err.message } };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: "Invalid input",
        issues: err.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    };
  }
  if (err instanceof AiError) {
    const status = err.kind === "input_rejected" ? 400 : err.kind === "quota" ? 429 : 502;
    return { status, body: { error: err.message } };
  }
  log.error("request.failed", { error: err instanceof Error ? err.message : String(err) });
  return { status: 500, body: { error: "Something went wrong" } };
}

export function errorResponse(err: unknown): Response {
  const { status, body } = errorInfo(err);
  return Response.json(body, { status });
}
