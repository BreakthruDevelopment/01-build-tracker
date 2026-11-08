import "server-only";
import { lookup } from "node:dns/promises";
import { eq, ne, sql } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { ConflictError } from "@/lib/errors";
import { parseHealthUrl } from "@/lib/health-url";
import { isPublicIp } from "@/lib/ip-guard";
import { log } from "@/lib/log";
import { setTrackerState } from "@/lib/tracker-state";
import { systemTransition } from "@/lib/tracker";

export const CATALOG_URL = "https://raw.githubusercontent.com/BreakthruDevelopment/ai-dev-os/main/catalog.yaml";
const CATALOG_MAX_BYTES = 512 * 1024;
const HEALTH_MAX_BYTES = 16 * 1024;
/**
 * Scale-to-zero apps (Azure Container Apps, Cloud Run) can need 10 s or more for the first request
 * after idle. Attempt 1 (6 s) wakes the app; one retry (13 s) follows after a short backoff. Worst case is
 * 6 + 0.5 + 13 = 19.5 s, inside the sync deadline. Catalog sync runs concurrently, so it doesn't eat into it.
 */
const HEALTH_ATTEMPT_TIMEOUTS_MS = [6000, 13000];
const HEALTH_BACKOFF_MS = [500];
const CATALOG_TIMEOUT_MS = 4000;
/**
 * Platform limits: Lambda 29 s and API Gateway / the workflow's curl 30 s, both including startup
 * (maxDuration is 25 s but does nothing on Lambda). 21 s leaves a few seconds to record results.
 */
const SYNC_DEADLINE_MS = 21000;
/** The catalog has at most 30 apps; check them all at once so cold apps don't queue behind each other. */
const CONCURRENCY = 30;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const catalogSchema = z.object({
  apps: z
    .array(
      z.object({
        n: z.number().int().min(1).max(30),
        repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
        name: z.string().min(1).max(200),
        subdomain: z.string().regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i),
        live_cloud: z.enum(["aws", "azure", "gcp", "oci"]),
      }),
    )
    .min(1)
    .max(30),
});

/** Read a response body up to `limit` bytes; `truncated` is true when more was available. */
async function readCapped(res: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      truncated = true;
      chunks.push(value.subarray(0, value.byteLength - (total - limit)));
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

export async function syncCatalog(deadline: AbortSignal): Promise<{ updated: number; error?: string }> {
  try {
    const res = await fetch(CATALOG_URL, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([AbortSignal.timeout(CATALOG_TIMEOUT_MS), deadline]),
    });
    if (res.status !== 200) throw new Error(`catalog fetch returned ${res.status}`);
    const { text, truncated } = await readCapped(res, CATALOG_MAX_BYTES);
    if (truncated) throw new Error("catalog too large");
    const catalog = catalogSchema.parse(parseYaml(text));

    // Names, subdomains, clouds and repos only. Status is deliberately not in this statement.
    const changed = await db().transaction(async (tx) => {
      let count = 0;
      for (const a of catalog.apps) {
        const rows = await tx
          .insert(schema.app)
          .values({ n: a.n, repo: a.repo, name: a.name, subdomain: a.subdomain, liveCloud: a.live_cloud })
          .onConflictDoUpdate({
            target: schema.app.n,
            set: { repo: a.repo, name: a.name, subdomain: a.subdomain, liveCloud: a.live_cloud },
            setWhere: sql`(${schema.app.repo}, ${schema.app.name}, ${schema.app.subdomain}, ${schema.app.liveCloud})
              is distinct from (${a.repo}, ${a.name}, ${a.subdomain}, ${a.live_cloud}::cloud_name)`,
          })
          .returning({ n: schema.app.n });
        count += rows.length;
      }
      return count;
    });
    return { updated: changed };
  } catch (err) {
    log.warn("sync.catalog_failed", { error: err instanceof Error ? err.message : String(err) });
    return { updated: 0, error: "catalog sync failed" };
  }
}

// ---------------------------------------------------------------------------
// Health polling
// ---------------------------------------------------------------------------

type HealthResult =
  | { kind: "skipped"; reason: string }
  | { kind: "checked"; health: "ok" | "degraded" | "down"; version: string | null; ms: number };

/** Race a promise against an abort signal (DNS lookups can't be aborted directly). */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Resolve every address for the host and require all of them to be public. */
async function assertPublicHost(
  hostname: string,
  signal: AbortSignal,
  resolve: (h: string) => Promise<{ address: string }[]> = (h) => lookup(h, { all: true, verbatim: true }),
): Promise<void> {
  const addresses = await raceSignal(resolve(hostname), signal);
  if (addresses.length === 0 || !addresses.every((a) => isPublicIp(a.address))) {
    throw new BlockedError("address");
  }
}

class BlockedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface HealthDeps {
  fetch?: typeof fetch;
  lookup?: (hostname: string) => Promise<{ address: string }[]>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  attemptTimeoutsMs?: number[];
  backoffMs?: number[];
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    if (signal.aborted) return done();
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Health check tolerant of cold starts: an attempt that throws (connection error, timeout) or answers
 * 5xx without a "degraded" body is retried after a backoff. 4xx, redirects and refused hosts are not.
 * The app is reported down only when every attempt fails; a success reports the latency of that attempt only.
 */
export async function checkHealth(
  rawUrl: string,
  deadline: AbortSignal,
  deps: HealthDeps = {},
  appN?: number,
): Promise<HealthResult> {
  const timeouts = deps.attemptTimeoutsMs ?? HEALTH_ATTEMPT_TIMEOUTS_MS;
  const backoff = deps.backoffMs ?? HEALTH_BACKOFF_MS;
  const sleep = deps.sleep ?? defaultSleep;
  let { retryable, ...result } = await checkHealthOnce(rawUrl, deadline, timeouts[0] ?? 6000, deps);
  for (let i = 1; i < timeouts.length && retryable; i++) {
    // The last real answer beats a skip: a real 5xx followed by the deadline is still a failure.
    if (deadline.aborted) return result;
    log.info("sync.health_retry", { n: appN ?? null, attempt: i + 1 });
    await sleep(backoff[i - 1] ?? 500, deadline);
    if (deadline.aborted) return result;
    const next = await checkHealthOnce(rawUrl, deadline, timeouts[i], deps);
    if (next.kind === "skipped" && next.reason === "sync_deadline") return result;
    ({ retryable, ...result } = next);
  }
  return result;
}

/**
 * One guarded health check (issue 2 SSRF review): re-validate the URL against the allow-list,
 * refuse private/loopback/link-local resolutions (on every attempt), never follow redirects, cap time
 * and size. A residual DNS-rebinding window exists between our lookup and fetch's own; the allow-listed
 * suffixes are either ours or deterministic/public hosting, which keeps that acceptable.
 */
type Attempt = HealthResult & { retryable: boolean };

async function checkHealthOnce(rawUrl: string, deadline: AbortSignal, timeoutMs: number, deps: HealthDeps): Promise<Attempt> {
  const url = parseHealthUrl(rawUrl);
  if (!url) return { kind: "skipped", reason: "url_not_allowed", retryable: false };
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), deadline]);
  const started = Date.now();
  try {
    await assertPublicHost(new URL(url).hostname, signal, deps.lookup);
    const res = await (deps.fetch ?? fetch)(url, {
      redirect: "manual",
      cache: "no-store",
      signal,
      headers: { accept: "application/json", "user-agent": "build-tracker-sync" },
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "skipped", reason: "redirect_refused", retryable: false };
    }
    const { text } = await readCapped(res, HEALTH_MAX_BYTES);
    const ms = Date.now() - started;
    let body: { status?: unknown; version?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") body = parsed as typeof body;
    } catch {
      // A 200 that isn't JSON is up but not trustworthy: degraded.
    }
    const version = typeof body.version === "string" ? body.version.slice(0, 100) : null;
    if (res.status !== 200) {
      // The template's /api/health answers 503 + status "degraded" when its database is down:
      // the app itself is up, so that's degraded rather than down.
      const health = body.status === "degraded" ? "degraded" : "down";
      return { kind: "checked", health, version, ms, retryable: health === "down" && res.status >= 500 };
    }
    return { kind: "checked", health: body.status === "ok" ? "ok" : "degraded", version, ms, retryable: false };
  } catch (err) {
    if (err instanceof BlockedError) return { kind: "skipped", reason: "private_address", retryable: false };
    // No DNS record yet (an app still being set up) says nothing about the app's health.
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ENOTFOUND" || code === "ENODATA") return { kind: "skipped", reason: "dns_not_found", retryable: false };
    if (deadline.aborted) return { kind: "skipped", reason: "sync_deadline", retryable: false };
    return { kind: "checked", health: "down", version: null, ms: Date.now() - started, retryable: true };
  }
}

async function pollApps(deadline: AbortSignal) {
  const apps = await db().select().from(schema.app).where(ne(schema.app.status, "planned"));
  const summary = { checked: 0, ok: 0, down: 0, skipped: 0 };
  const queue = [...apps];

  async function worker() {
    for (let a = queue.shift(); a; a = queue.shift()) {
      const target = a.healthUrl ?? `https://${a.subdomain}/api/health`;
      const result = await checkHealth(target, deadline, {}, a.n);
      if (result.kind === "skipped") {
        summary.skipped++;
        log.warn("sync.health_skipped", { n: a.n, reason: result.reason });
        continue;
      }
      summary.checked++;
      if (result.health === "ok") summary.ok++;
      if (result.health === "down") summary.down++;
      try {
        await record(a, result);
      } catch (err) {
        log.error("sync.health_record_failed", { n: a.n, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, apps.length) }, worker));
  return summary;
}

async function record(a: typeof schema.app.$inferSelect, r: Extract<HealthResult, { kind: "checked" }>) {
  const now = new Date();
  await db().transaction(async (tx) => {
    await tx
      .update(schema.app)
      .set({ health: r.health, healthVersion: r.version, healthMs: r.ms, healthAt: now })
      .where(eq(schema.app.n, a.n));
    if (a.health !== r.health) {
      await tx.insert(schema.appEvent).values({
        appN: a.n,
        source: "health",
        kind: "health_change",
        title: `Health ${a.health} → ${r.health}${r.version ? ` (version ${r.version.slice(0, 40)})` : ""}`,
        occurredAt: now,
      });
    }
  });
  if (a.status === "building" && r.health === "ok" && r.version && r.version !== "dev") {
    try {
      await systemTransition(a.n, "live", `Health check ok (version ${r.version.slice(0, 40)})`);
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
    }
  }
}

// ---------------------------------------------------------------------------

export async function runSync() {
  const deadline = AbortSignal.timeout(SYNC_DEADLINE_MS);
  const started = Date.now();
  // Concurrent, so a slow catalog fetch doesn't shorten the health budget. Health polls the apps already
  // in the database; a newly added app is first checked on the next sync.
  const [catalog, health] = await Promise.all([syncCatalog(deadline), pollApps(deadline)]);
  const result = { catalog, health };
  await setTrackerState("last_sync", { ...result, ms: Date.now() - started });
  log.info("sync.done", { ...result, ms: Date.now() - started });
  return result;
}
