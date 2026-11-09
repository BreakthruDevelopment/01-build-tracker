import "server-only";
import { lookup } from "node:dns/promises";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { ConflictError, NotFoundError, TooManyRequestsError } from "@/lib/errors";
import { parseHealthUrl } from "@/lib/health-url";
import { isPublicIp } from "@/lib/ip-guard";
import { log } from "@/lib/log";
import { isParked } from "@/lib/running";
import { setTrackerState } from "@/lib/tracker-state";
import { appNumber, systemTransition } from "@/lib/tracker";

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
/**
 * Confirm before Down. A scale-to-zero app can need longer than the check allows for its first request after
 * idle, and the check itself wakes it. So the first failed check only stamps `health_failing_since`. The app is
 * recorded down by a later failure only when the stamp is between CONFIRM_MIN_AGE and CONFIRM_MAX_AGE old:
 * - younger than the minimum: an overlapping sync or a double click, and the app has had no time to wake, so
 *   it is unconfirmed and not restamped;
 * - older than the maximum: the app may have gone back to sleep since (Azure Container Apps idles out after
 *   300 s), so this failure is a new first failure and restamps.
 * The scheduler calls sync in pairs a couple of minutes apart (:15/:17, :45/:47), which lands in that range.
 */
const CONFIRM_MIN_AGE_S = 60;
const CONFIRM_MAX_AGE_S = 4 * 60;
/** Backstop: an app not recorded for this long is confirmed on its next failure, so it can't stay invisible. */
const CONFIRM_BACKSTOP_MS = 60 * 60 * 1000;

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
  | { kind: "checked"; health: "ok" | "degraded" | "down"; version: string | null; app: string | null; ms: number };

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
    let body: { status?: unknown; version?: unknown; app?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") body = parsed as typeof body;
    } catch {
      // A 200 that isn't JSON is up but not trustworthy: degraded.
    }
    const version = typeof body.version === "string" ? body.version.slice(0, 100) : null;
    const app = typeof body.app === "string" ? body.app.slice(0, 200) : null;
    if (res.status !== 200) {
      // The template's /api/health answers 503 + status "degraded" when its database is down:
      // the app itself is up, so that's degraded rather than down.
      const health = body.status === "degraded" ? "degraded" : "down";
      return { kind: "checked", health, version, app, ms, retryable: health === "down" && res.status >= 500 };
    }
    return { kind: "checked", health: body.status === "ok" ? "ok" : "degraded", version, app, ms, retryable: false };
  } catch (err) {
    if (err instanceof BlockedError) return { kind: "skipped", reason: "private_address", retryable: false };
    // No DNS record yet (an app still being set up) says nothing about the app's health.
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ENOTFOUND" || code === "ENODATA") return { kind: "skipped", reason: "dns_not_found", retryable: false };
    if (deadline.aborted) return { kind: "skipped", reason: "sync_deadline", retryable: false };
    return { kind: "checked", health: "down", version: null, app: null, ms: Date.now() - started, retryable: true };
  }
}

type CheckOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "unconfirmed" }
  | { kind: "recorded"; health: "ok" | "degraded" | "down" };

type AppRow = typeof schema.app.$inferSelect;

/**
 * One app's health check, through the shared record/confirm path: used by the scheduled poll and by the admin
 * "Check now". `parked` is the app's current Down state. A parked app is never passed to this by the poll; only
 * Check now does, and then the checks that assume routine polling are off:
 * - the "not recorded for 60 minutes" backstop (a parked app is not recorded, by design);
 * - the "already down, record at once" shortcut, so a stored `down` from before parking still needs confirming.
 * For a running app the backstop counts from the later of its last record and its last Up/Down change.
 */
async function checkApp(a: AppRow, deadline: AbortSignal, deps: HealthDeps, parked: boolean): Promise<CheckOutcome> {
  const target = a.healthUrl ?? `https://${a.subdomain}/api/health`;
  const result = await checkHealth(target, deadline, deps, a.n);
  if (result.kind === "skipped") {
    // No DNS record yet is expected for apps still being set up; everything else is worth a warning.
    const level = result.reason === "dns_not_found" ? log.info : log.warn;
    level("sync.health_skipped", { n: a.n, reason: result.reason });
    return { kind: "skipped", reason: result.reason };
  }
  if (a.status === "planned") {
    // A planned app only counts, and is only recorded, once it reports ok with a real version from the
    // right app. A parked page, a 404 or a 5xx on its subdomain says nothing about the app.
    const reason = !isDeployed(result) ? "not_deployed" : !matchesApp(a, result.app) ? "app_mismatch" : null;
    if (reason) {
      log.info("sync.health_skipped", { n: a.n, reason, ...(reason === "app_mismatch" ? { reported: result.app } : {}) });
      return { kind: "skipped", reason };
    }
  }
  // Only "down" is confirmed: ok and degraded mean the app answered, so there is nothing to wait out.
  // Planned apps never get here with a failure (they are skipped above unless deployed and ok).
  // A never-recorded app is not stale. The backstop counts from the later of the last record and the last Up/Down change.
  const lastRecord = Math.max(a.healthAt?.getTime() ?? 0, a.runningChangedAt?.getTime() ?? 0);
  const stale = !parked && a.healthAt !== null && Date.now() - lastRecord > CONFIRM_BACKSTOP_MS;
  // A stored `down` only counts if it was recorded after the last Up/Down change: a parked app brought back Up
  // still gets confirm-before-down on its first (cold-start) failure.
  const alreadyDown = !parked && a.health === "down" && (!a.runningChangedAt || (a.healthAt !== null && a.healthAt > a.runningChangedAt));
  if (result.health === "down" && a.status !== "planned" && !alreadyDown && !stale && (await confirmFailure(a.n)) === "unconfirmed") {
    log.info("sync.health_unconfirmed", { n: a.n });
    return { kind: "unconfirmed" };
  }
  await record(a, result);
  return { kind: "recorded", health: result.health };
}

/**
 * `appNs` and `deps` exist for tests: they limit the poll to some apps and stub the network.
 * Parked apps (Down: see running.ts) get no request at all, so a scale-to-zero app is never woken; they are
 * counted under `parked` and nowhere else.
 */
export async function pollApps(deadline: AbortSignal, deps: HealthDeps = {}, appNs?: number[]) {
  // Planned apps are polled too: with no GitHub webhook, a healthy deployment is what moves them forward.
  // One without a DNS record yet is skipped (dns_not_found), not counted as down.
  const all = appNs ? await db().select().from(schema.app).where(inArray(schema.app.n, appNs)) : await db().select().from(schema.app);
  const summary = { checked: 0, ok: 0, down: 0, unconfirmed: 0, skipped: 0, parked: 0 };
  const apps = all.filter((a) => !isParked(a));
  summary.parked = all.length - apps.length;
  const queue = [...apps];

  async function worker() {
    for (let a = queue.shift(); a; a = queue.shift()) {
      try {
        const outcome = await checkApp(a, deadline, deps, false);
        if (outcome.kind === "skipped") {
          summary.skipped++;
          continue;
        }
        summary.checked++;
        if (outcome.kind === "unconfirmed") summary.unconfirmed++;
        else if (outcome.health === "ok") summary.ok++;
        else if (outcome.health === "down") summary.down++;
      } catch (err) {
        log.error("sync.health_record_failed", { n: a.n, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, apps.length) }, worker));
  return summary;
}

export const CHECK_NOW_INTERVAL_S = 30;

export type CheckNowResult = {
  outcome: "ok" | "degraded" | "down" | "unconfirmed" | "skipped";
  message: string;
  /** The app's running state; Check now does not change it. */
  parked: boolean;
};

const SKIP_TEXT: Record<string, string> = {
  url_not_allowed: "the health URL isn't allowed",
  redirect_refused: "the health URL redirects",
  private_address: "the health URL resolves to a private address",
  dns_not_found: "there is no DNS record yet",
  sync_deadline: "the check ran out of time",
  not_deployed: "it answered, but it isn't a deployed build yet",
  app_mismatch: "it answered as a different app",
};

/**
 * Admin "Check now": one health check for one app, even if it is Down (this wakes it). The result goes through
 * the same record/confirm path as sync. At most once per CHECK_NOW_INTERVAL_S per app, enforced by one
 * conditional UPDATE so two clicks can't both pass.
 */
export async function checkNow(actor: Actor, nInput: unknown, deps: HealthDeps = {}): Promise<CheckNowResult> {
  assertCan(actor, "manage");
  const n = appNumber.parse(nInput);
  const claimed = await db()
    .update(schema.app)
    .set({ manualCheckAt: sql`now()` })
    .where(
      and(
        eq(schema.app.n, n),
        or(isNull(schema.app.manualCheckAt), lt(schema.app.manualCheckAt, sql`now() - ${CHECK_NOW_INTERVAL_S} * interval '1 second'`)),
      ),
    )
    .returning();
  const [a] = claimed;
  if (!a) {
    const [row] = await db()
      .select({ wait: sql<number>`ceil(extract(epoch from (${schema.app.manualCheckAt} + ${CHECK_NOW_INTERVAL_S} * interval '1 second' - now())))::int` })
      .from(schema.app)
      .where(eq(schema.app.n, n));
    if (!row) throw new NotFoundError("Unknown app");
    throw new TooManyRequestsError(`Checked a moment ago. Try again in ${Math.max(1, row.wait)} seconds.`);
  }
  const parked = isParked(a);
  const deadline = AbortSignal.timeout(SYNC_DEADLINE_MS);
  const o = await checkApp(a, deadline, deps, parked);
  log.info("sync.check_now", { n, outcome: o.kind === "recorded" ? o.health : o.kind, parked });
  const stays = parked ? " It stays Down (parked) until you switch it Up." : "";
  if (o.kind === "unconfirmed") {
    return { outcome: "unconfirmed", parked, message: "Didn't answer yet \u2014 it may be waking; try again in a minute." };
  }
  if (o.kind === "skipped") {
    return { outcome: "skipped", parked, message: `Not checked: ${SKIP_TEXT[o.reason] ?? o.reason}.` };
  }
  if (o.health === "ok") return { outcome: "ok", parked, message: `Up and healthy.${stays}` };
  if (o.health === "degraded") return { outcome: "degraded", parked, message: `It answered, but reports degraded.${stays}` };
  return { outcome: "down", parked, message: "Still not answering. Recorded as down." };
}

/**
 * Decide whether a failed check is confirmed. One conditional UPDATE stamps the first failure of a run (nothing
 * stamped, or the stamp is older than the maximum age), so two overlapping syncs can't both be "first". If no
 * row matched, the stamp's age decides: too young is unconfirmed (and not restamped), otherwise confirmed.
 * Uses the database clock.
 */
async function confirmFailure(n: number): Promise<"unconfirmed" | "confirmed"> {
  const rows = await db()
    .update(schema.app)
    .set({ healthFailingSince: sql`now()` })
    .where(
      and(
        eq(schema.app.n, n),
        or(
          isNull(schema.app.healthFailingSince),
          lt(schema.app.healthFailingSince, sql`now() - ${CONFIRM_MAX_AGE_S} * interval '1 second'`),
        ),
      ),
    )
    .returning({ n: schema.app.n });
  if (rows.length > 0) return "unconfirmed";
  const [row] = await db()
    .select({ young: sql<boolean>`${schema.app.healthFailingSince} is null or ${schema.app.healthFailingSince} > now() - ${CONFIRM_MIN_AGE_S} * interval '1 second'` })
    .from(schema.app)
    .where(eq(schema.app.n, n));
  return row?.young === false ? "confirmed" : "unconfirmed";
}

type Checked = Extract<HealthResult, { kind: "checked" }>;

function isDeployed(r: Checked): boolean {
  return r.health === "ok" && !!r.version && r.version !== "dev";
}

/** The health JSON's `app` must name the catalog app (its title, case-insensitive, or its repo slug). */
function matchesApp(a: { name: string; repo: string }, reported: string | null): boolean {
  if (!reported) return false;
  const got = reported.trim().toLowerCase();
  return got === a.name.trim().toLowerCase() || got === a.repo.trim().toLowerCase();
}

async function record(a: typeof schema.app.$inferSelect, r: Checked) {
  const now = new Date();
  const deployed = isDeployed(r);
  await db().transaction(async (tx) => {
    // Lock the row and compare with its current health, not the copy read when the poll began: two syncs that
    // both confirm a failure must write one health_change event, not two.
    const [current] = await tx.select({ health: schema.app.health }).from(schema.app).where(eq(schema.app.n, a.n)).for("update");
    const prev = current?.health ?? a.health;
    await tx
      .update(schema.app)
      .set({
        health: r.health,
        healthVersion: r.version,
        healthMs: r.ms,
        healthAt: now,
        // Any answer clears the failure run. A confirmed down keeps its stamp until the app answers again.
        ...(r.health === "down" ? {} : { healthFailingSince: null }),
      })
      .where(eq(schema.app.n, a.n));
    // A planned app that isn't deployed yet stays quiet: no health events until it moves.
    if (prev !== r.health && (a.status !== "planned" || deployed)) {
      await tx.insert(schema.appEvent).values({
        appN: a.n,
        source: "health",
        kind: "health_change",
        title: `Health ${prev} → ${r.health}${r.version ? ` (version ${r.version.slice(0, 40)})` : ""}`,
        occurredAt: now,
      });
    }
  });
  if (deployed && (a.status === "planned" || a.status === "building")) {
    const version = r.version!.slice(0, 40);
    // Each step is attempted on its own: a conflict on planned to building (the app moved meanwhile)
    // must not stop building to live; the state machine rejects it if it no longer applies.
    const step = async (to: "building" | "live", reason: string) => {
      try {
        await systemTransition(a.n, to, reason);
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
      }
    };
    if (a.status === "planned") await step("building", `Deployed: health check ok (version ${version})`);
    await step("live", `Verified live: health check ok (version ${version})`);
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
