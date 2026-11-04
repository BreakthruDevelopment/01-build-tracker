import { z } from "zod";

/**
 * SSRF guard for the admin-set health URL (spec "Threat model"): https only, default port,
 * no credentials, and the host must be under an allow-listed domain.
 */
export const HEALTH_HOST_SUFFIXES = [
  "breakthruventures.ai",
  "execute-api.us-east-2.amazonaws.com",
  "azurecontainerapps.io",
  "run.app",
  "sslip.io",
] as const;

export function isAllowedHealthHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return HEALTH_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
}

/** The normalized URL, or null when it is not acceptable. */
export function parseHealthUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  if (!isAllowedHealthHost(url.hostname)) return null;
  return url.toString();
}

export const healthUrlSchema = z
  .string()
  .trim()
  .max(500)
  .transform((value, ctx) => {
    const normalized = parseHealthUrl(value);
    if (!normalized) {
      ctx.addIssue({
        code: "custom",
        message: "Health URL must be https on an allowed host (*.breakthruventures.ai or a cloud default host).",
      });
      return z.NEVER;
    }
    return normalized;
  });
