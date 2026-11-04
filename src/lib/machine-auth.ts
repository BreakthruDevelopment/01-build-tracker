import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { PayloadTooLargeError, UnauthorizedTokenError, NotConfiguredError, BadRequestError } from "@/lib/errors";

/** Compare two secrets in constant time regardless of length (hash both to equal-length digests). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** The token from `Authorization: Bearer <token>`, or null when absent or malformed. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/** Throws 503 when the secret is unset, 401 when the bearer token is missing or wrong. */
export function requireBearer(request: Request, secret: string | undefined): void {
  if (!secret) throw new NotConfiguredError();
  const token = bearerToken(request);
  if (!token || !safeEqual(token, secret)) throw new UnauthorizedTokenError();
}

/**
 * Read the request body exactly once, as bytes, refusing anything over `limit` bytes.
 * Checks Content-Length first, then counts while streaming so a lying header can't get past.
 */
export async function readBodyCapped(request: Request, limit: number): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLargeError(limit);
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError(limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Parse a UTF-8 JSON body; 400 when it isn't valid JSON. */
export function parseJsonBody(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BadRequestError("Body must be valid JSON");
  }
}

/** `sha256=<hex>` HMAC over the raw bytes, compared in constant time. */
export function verifyGithubSignature(bytes: Buffer, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(bytes).digest("hex"));
  const given = Buffer.from(header.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}
