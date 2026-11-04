import "server-only";
import { and, count, desc, eq, gte, inArray, isNull, like, not, sql } from "drizzle-orm";
import { type AppFacts, type AppSummary, MAX_APPS_PER_CALL, isNotStarted, summarizeFacts } from "@/lib/ai/daily-health-summary";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { NotFoundError, TooManyRequestsError } from "@/lib/errors";
import { log } from "@/lib/log";
import { appNumber } from "@/lib/tracker";

/**
 * Daily health summaries: gather facts, ask the model once for a batch (rule floor applied in
 * code), and cache one row per app per UTC day. Never called on page view.
 */

const HS = schema.healthSummary;
const A = schema.app;

/** Regenerating one app's summary is limited to once per this long. */
export const REGENERATE_INTERVAL_MS = 60 * 60 * 1000;
/** Ops-monitor stalled reports older than this are ignored (the monitor reports nightly). */
const STALLED_WINDOW_MS = 30 * 3_600_000;
/** Usage readings older than this are ignored, so a silent monitor can't pin an app red forever. */
const USAGE_WINDOW_MS = 72 * 3_600_000;

export type RunResult = { done: number; remaining: number };

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

async function countMissing(day: string): Promise<number> {
  const [row] = await db()
    .select({ c: count() })
    .from(A)
    .leftJoin(HS, and(eq(HS.appN, A.n), eq(HS.day, day)))
    .where(isNull(HS.id));
  return row.c;
}

/** Facts for the given apps. Event queries only run for apps that have events. */
async function loadFacts(rows: (typeof A.$inferSelect)[], withEvents: Set<number>, now: Date): Promise<AppFacts[]> {
  const clouds = [...new Set(rows.filter((r) => withEvents.has(r.n) || r.status !== "planned").map((r) => r.liveCloud))];
  const usageRows = clouds.length
    ? await db()
        .selectDistinctOn([schema.cloudUsage.cloud, schema.cloudUsage.metric], {
          cloud: schema.cloudUsage.cloud,
          metric: schema.cloudUsage.metric,
          usedPct: schema.cloudUsage.usedPct,
          chargeCents: schema.cloudUsage.chargeCents,
        })
        .from(schema.cloudUsage)
        .where(and(inArray(schema.cloudUsage.cloud, clouds), gte(schema.cloudUsage.reportedAt, new Date(now.getTime() - USAGE_WINDOW_MS))))
        .orderBy(schema.cloudUsage.cloud, schema.cloudUsage.metric, desc(schema.cloudUsage.reportedAt))
    : [];

  return Promise.all(
    rows.map(async (r): Promise<AppFacts> => {
      let eventTitles: string[] = [];
      let stalled: AppFacts["stalled"] = [];
      if (withEvents.has(r.n)) {
        const E = schema.appEvent;
        const [recent, stalledRows] = await Promise.all([
          db()
            .select({ title: E.title })
            .from(E)
            .where(and(eq(E.appN, r.n), not(like(E.kind, "stalled.%"))))
            .orderBy(desc(E.occurredAt))
            .limit(5),
          db()
            .select({ title: E.title, occurredAt: E.occurredAt })
            .from(E)
            .where(and(eq(E.appN, r.n), like(E.kind, "stalled.%"), gte(E.occurredAt, new Date(now.getTime() - STALLED_WINDOW_MS))))
            .orderBy(desc(E.occurredAt))
            .limit(10),
        ]);
        eventTitles = recent.map((e) => e.title);
        // Only the latest report counts: an older one may describe work that has since moved.
        const latest = stalledRows[0]?.occurredAt.getTime();
        stalled = stalledRows
          .filter((s) => s.occurredAt.getTime() === latest)
          .map((s) => {
            const m = /^Stalled(?: \((\d+) h\))?:\s*([\s\S]*)$/.exec(s.title);
            return m ? { detail: m[2], hours: m[1] ? Number(m[1]) : undefined } : { detail: s.title };
          });
      }
      return {
        n: r.n,
        name: r.name,
        status: r.status,
        statusChangedAt: r.statusChangedAt,
        health: r.health,
        healthVersion: r.healthVersion,
        lastPushAt: r.lastPushAt,
        ciConclusion: r.ciConclusion,
        ciWorkflow: r.ciWorkflow,
        liveCloud: r.liveCloud,
        eventTitles,
        stalled,
        usage: usageRows.filter((u) => u.cloud === r.liveCloud).map((u) => ({ metric: u.metric, usedPct: u.usedPct, chargeCents: u.chargeCents })),
      };
    }),
  );
}

function toRow(s: AppSummary, day: string, now: Date, modelInfo: { demo: boolean; model: string | null }): typeof HS.$inferInsert {
  const fromModel = s.source === "model";
  return {
    appN: s.n,
    day,
    health: s.health,
    summary: s.summary,
    flags: s.flags,
    demo: fromModel && modelInfo.demo,
    model: fromModel ? modelInfo.model : s.source === "rules" ? "rules" : null,
    updatedAt: now,
  };
}

async function withEventSet(ns: number[]): Promise<Set<number>> {
  if (ns.length === 0) return new Set();
  const rows = await db().selectDistinct({ n: schema.appEvent.appN }).from(schema.appEvent).where(inArray(schema.appEvent.appN, ns));
  return new Set(rows.map((r) => r.n));
}

/**
 * Summarize up to 6 apps that still lack today's summary (one model call). Planned apps with no
 * events get "Not started." without the model and don't count toward the 6. Already-stored
 * summaries are never touched, so a second run on the same day makes no model call.
 */
export async function runDailySummaries(now = new Date()): Promise<RunResult> {
  const day = utcDay(now);
  const candidates = await db()
    .select({ app: A })
    .from(A)
    .leftJoin(HS, and(eq(HS.appN, A.n), eq(HS.day, day)))
    .where(isNull(HS.id))
    .orderBy(A.n)
    .then((rows) => rows.map((r) => r.app));
  if (candidates.length === 0) return { done: 0, remaining: 0 };

  const withEvents = await withEventSet(candidates.filter((c) => c.status === "planned").map((c) => c.n));
  // Non-planned apps always have something to say; planned ones only once they have events.
  const hasStory = (c: (typeof candidates)[number]) => c.status !== "planned" || withEvents.has(c.n);
  const batch = [...candidates.filter((c) => !hasStory(c)), ...candidates.filter(hasStory).slice(0, MAX_APPS_PER_CALL)];

  const facts = await loadFacts(batch, new Set(batch.filter(hasStory).map((c) => c.n)), now);
  const result = await summarizeFacts(facts, now);
  const stored = await db()
    .insert(HS)
    .values(result.summaries.map((s) => toRow(s, day, now, result)))
    .onConflictDoNothing({ target: [HS.appN, HS.day] })
    .returning({ n: HS.appN });

  const remaining = await countMissing(day);
  log.info("summaries.run", { done: stored.length, remaining, modelCalled: result.modelCalled, demo: result.demo });
  return { done: stored.length, remaining };
}

/**
 * Admin regenerates one app's summary for today, at most once per app per hour (measured from
 * the stored row's updated_at, so the automatic run counts as the first generation).
 */
export async function regenerateSummary(actor: Actor, nInput: unknown, now = new Date()): Promise<RunResult> {
  assertCan(actor, "manage");
  const n = appNumber.parse(nInput);
  const day = utcDay(now);
  const cutoff = new Date(now.getTime() - REGENERATE_INTERVAL_MS);

  const [app] = await db().select().from(A).where(eq(A.n, n));
  if (!app) throw new NotFoundError("Unknown app");

  const [existing] = await db().select({ updatedAt: HS.updatedAt }).from(HS).where(and(eq(HS.appN, n), eq(HS.day, day)));
  if (existing && existing.updatedAt > cutoff) {
    const minutes = Math.max(1, Math.ceil((REGENERATE_INTERVAL_MS - (now.getTime() - existing.updatedAt.getTime())) / 60_000));
    throw new TooManyRequestsError(`This summary was generated recently. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }

  const withEvents = await withEventSet([n]);
  const [facts] = await loadFacts([app], withEvents, now);
  const result = await summarizeFacts([facts], now);
  const row = toRow(result.summaries[0], day, now, result);
  // The WHERE repeats the limit atomically, so two clicks racing past the check above can't both write.
  const written = await db()
    .insert(HS)
    .values(row)
    .onConflictDoUpdate({
      target: [HS.appN, HS.day],
      set: {
        health: sql`excluded.health`,
        summary: sql`excluded.summary`,
        flags: sql`excluded.flags`,
        demo: sql`excluded.demo`,
        model: sql`excluded.model`,
        updatedAt: sql`excluded.updated_at`,
      },
      setWhere: sql`${HS.updatedAt} <= ${cutoff.toISOString()}::timestamptz`,
    })
    .returning({ n: HS.appN });
  if (written.length === 0) {
    throw new TooManyRequestsError("This summary was generated recently. Try again later.");
  }

  const remaining = await countMissing(day);
  log.info("summaries.regenerate", { n, modelCalled: result.modelCalled, demo: result.demo, notStarted: isNotStarted(facts) });
  return { done: 1, remaining };
}
