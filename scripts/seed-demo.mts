/**
 * Fills a NON-production tracker database with realistic, deterministic sample state so the board
 * can be designed and demoed with a full screen. Run it with:
 *
 *   DATABASE_URL=... APP_URL=http://localhost:3000 DEMO_SEED=yes pnpm seed:demo [--force]
 *
 * It keeps the 30 real app rows (from the catalog seed migration) and rewrites their state, plus
 * events, status history, today's health summaries, cloud usage and tracker_state. All randomness
 * comes from a fixed-seed PRNG, so the same run on the same day gives the same board.
 *
 * Ownership markers (so a second run resets cleanly): app_event.delivery_id starts with "demo-",
 * health_summary.model is "demo-seed", and admin-made transitions use the login-less user
 * "demo-seed-admin". Status history, cloud usage and tracker_state have no marker and are replaced
 * wholesale; that is why a database holding real GitHub events is refused unless --force is given.
 */
import { and, eq, isNull, like, not, or, sql as dsql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { evaluateRules, hoursBetween, type AppFacts, type Flag, type SummaryHealth } from "../src/lib/ai/daily-health-summary";
import * as schema from "../src/lib/db/schema";
import { canTransition, requiresReason, type Status } from "../src/lib/status";

type Db = PostgresJsDatabase<typeof schema>;

export const DEMO_MODEL = "demo-seed";
export const DEMO_PREFIX = "demo-";
export const DEMO_ADMIN_ID = "demo-seed-admin";
const PROD_HOST = "app1.breakthruventures.ai";
const LAMBDA_SUFFIX = "execute-api.us-east-2.amazonaws.com";
const ORG = "https://github.com/BreakthruDevelopment";

export class DemoSeedRefusal extends Error {}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

/** Environment-only checks; run before any database connection is opened. */
export function assertSafeEnv(env: Record<string, string | undefined>): void {
  if (env.DEMO_SEED !== "yes") throw new DemoSeedRefusal("Refusing to run: set DEMO_SEED=yes to confirm you want demo data.");
  const raw = env.APP_URL ?? "http://localhost:3000";
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    throw new DemoSeedRefusal("Refusing to run: APP_URL is not a valid URL.");
  }
  if (host === PROD_HOST || host.endsWith(LAMBDA_SUFFIX)) {
    throw new DemoSeedRefusal(`Refusing to run: APP_URL (${host}) is the production tracker.`);
  }
}

/** Host and database name of a connection string, never the credentials. */
export function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/** Does the database hold data that did not come from this script? */
async function realDataReason(db: Db): Promise<string | null> {
  const E = schema.appEvent;
  const [{ n: events }] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(E)
    .where(and(eq(E.source, "github"), or(isNull(E.deliveryId), not(like(E.deliveryId, `${DEMO_PREFIX}%`)))));
  if (events > 0) return `${events} real GitHub event(s) found`;
  const T = schema.statusTransition;
  const [{ n: transitions }] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(T)
    .where(and(dsql`${T.actorId} is not null`, not(eq(T.actorId, DEMO_ADMIN_ID))));
  if (transitions > 0) return `${transitions} status change(s) made by real users found`;
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

/** mulberry32: tiny seeded PRNG. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    hex: (len: number) => Array.from({ length: len }, () => Math.floor(next() * 16).toString(16)).join(""),
  };
}

const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// The plan: which app is in which state
// ---------------------------------------------------------------------------

type Plan = {
  status: Status;
  blockedFrom?: Status;
  blockedReason?: string;
  health: "ok" | "degraded" | "down" | "unknown";
  ci?: "success" | "failure";
  /** Hours since the newest push. */
  pushH?: number;
  /** Hours since the current status was entered. */
  sinceH?: number;
  /** A live app that was sent back to rework once and re-released. */
  reworked?: boolean;
};

const SHIPPED = [1, 2, 3, 4];
const LIVE = [5, 6, 8, 9, 10, 11];
const BUILDING = [12, 13, 14, 15, 16, 18, 19, 20];

function buildPlans(rng: ReturnType<typeof makeRng>): Map<number, Plan> {
  const plans = new Map<number, Plan>();
  for (let n = 1; n <= 30; n++) plans.set(n, { status: "planned", health: "unknown" });
  for (const n of SHIPPED) {
    plans.set(n, { status: "shipped", health: n === 3 ? "degraded" : "ok", ci: "success", pushH: rng.int(30, 100), sinceH: rng.int(72, 240) });
  }
  for (const n of LIVE) {
    plans.set(n, {
      status: "live",
      health: n === 9 ? "degraded" : n === 11 ? "down" : "ok",
      ci: "success",
      pushH: rng.int(2, 30),
      sinceH: rng.int(24, 120),
      reworked: n === 9,
    });
  }
  for (const n of BUILDING) {
    plans.set(n, {
      status: "building",
      health: "unknown",
      ci: n === 14 || n === 19 ? "failure" : "success",
      pushH: n === 16 ? 41 : rng.int(1, 20),
      sinceH: rng.int(48, 190),
    });
  }
  plans.set(7, {
    status: "blocked",
    blockedFrom: "live",
    blockedReason: "Cloud Run quota increase is pending with Google Cloud support; booking emails cannot be sent until it clears.",
    health: "down",
    ci: "success",
    pushH: 60,
    sinceH: 30,
  });
  plans.set(17, {
    status: "blocked",
    blockedFrom: "building",
    blockedReason: "Candidate-scoring rubric needs a decision before the ATS pipeline can be built.",
    health: "unknown",
    ci: "success",
    pushH: 74,
    sinceH: 52,
  });
  return plans;
}

// ---------------------------------------------------------------------------
// Event text
// ---------------------------------------------------------------------------

const BRANCH_WORK = [
  ["claude/items-api", "Add items API"],
  ["claude/schema", "Define schema and migrations"],
  ["grok/dashboard-ui", "Dashboard page layout"],
  ["claude/auth-roles", "Enforce admin role on writes"],
  ["codex/fix-flaky-test", "Stabilise integration test ordering"],
  ["claude/ai-summary", "Wire summary task to generate()"],
  ["jules/gcp-terraform", "Add Cloud Run service module"],
  ["grok/list-filters", "Status filter chips"],
  ["claude/seed-data", "Seed realistic sample rows"],
  ["claude/smoke", "Extend smoke test with main flow"],
  ["codex/lint-cleanup", "Fix lint warnings"],
  ["claude/readme", "Fill in What this app does"],
] as const;

const PR_TITLES = [
  "[fullstack-builder] Items API",
  "[ui-builder] Dashboard page",
  "[ai-builder] Daily summary task",
  "[devops] Terraform app entry",
  "[docs-writer] README and demo script",
  "[fullstack-builder] Roles and permissions",
] as const;

const HEALTH_DEGRADED = ["Health ok → degraded", "Health ok → degraded (slow responses)"] as const;

type EventPlan = { source: "github" | "health" | "ops_monitor"; kind: string; title: string; url: string | null; at: Date };

// ---------------------------------------------------------------------------
// Generate everything in memory
// ---------------------------------------------------------------------------

type AppRow = { n: number; repo: string; name: string; liveCloud: "aws" | "azure" | "gcp" | "oci" };

export type DemoData = ReturnType<typeof generate>;

const USAGE: Record<"aws" | "azure" | "gcp" | "oci", { metric: string; pct: number }[]> = {
  aws: [
    { metric: "lambda_requests", pct: 18 },
    { metric: "dynamodb_storage", pct: 9 },
  ],
  azure: [
    { metric: "app_service_cpu_minutes", pct: 31 },
    { metric: "bandwidth_out", pct: 22 },
  ],
  gcp: [
    { metric: "cloud_run_requests", pct: 82 },
    { metric: "egress_gb", pct: 12 },
  ],
  oci: [
    { metric: "compute_hours", pct: 44 },
    { metric: "object_storage_gb", pct: 27 },
  ],
};

export function generate(apps: AppRow[], now: Date) {
  const rng = makeRng(30);
  const plans = buildPlans(rng);
  const ago = (h: number) => new Date(now.getTime() - h * HOUR);

  // Cloud usage: three readings per metric, newest an hour old, no charges.
  const usage: { cloud: AppRow["liveCloud"]; metric: string; usedPct: number; chargeCents: number; reportedAt: Date }[] = [];
  for (const cloud of Object.keys(USAGE) as AppRow["liveCloud"][]) {
    for (const u of USAGE[cloud]) {
      usage.push({ cloud, metric: u.metric, usedPct: Math.max(1, u.pct - 9), chargeCents: 0, reportedAt: ago(49) });
      usage.push({ cloud, metric: u.metric, usedPct: Math.max(1, u.pct - 4), chargeCents: 0, reportedAt: ago(25) });
      usage.push({ cloud, metric: u.metric, usedPct: u.pct, chargeCents: 0, reportedAt: ago(1) });
    }
  }

  let prCounter = 0;
  const out = apps.map((a) => {
    const p = plans.get(a.n)!;
    const started = p.status !== "planned";
    const sha = `sha-${rng.hex(7)}`;
    const events: EventPlan[] = [];
    const lastPushAt = p.pushH !== undefined ? ago(p.pushH) : null;
    let ciRun = null as { conclusion: string; url: string; at: Date } | null;

    if (started && lastPushAt) {
      // 2-4 earlier pushes between 5 days ago and the newest push, then the newest push.
      const pushTimes = [lastPushAt];
      const extra = rng.int(2, 4);
      for (let i = 0; i < extra; i++) pushTimes.push(ago(rng.int(Math.ceil(p.pushH!) + 1, 118)));
      pushTimes.sort((x, y) => y.getTime() - x.getTime());
      pushTimes.forEach((at, i) => {
        const [branch, msg] = rng.pick(BRANCH_WORK);
        events.push({ source: "github", kind: "push", title: `${branch}: ${msg}`, url: `${ORG}/${a.repo}/commit/${rng.hex(40)}`, at });
        // Each push gets a CI run a few minutes later; the newest decides the app's CI state.
        const failed = i === 0 && p.ci === "failure";
        const runAt = new Date(at.getTime() + rng.int(3, 9) * 60_000);
        const run = { conclusion: failed ? "failure" : "success", url: `${ORG}/${a.repo}/actions/runs/${rng.int(11_000_000_000, 11_900_000_000)}`, at: runAt };
        events.push({
          source: "github",
          kind: "workflow_run",
          title: `CI ${failed ? "failed" : "succeeded"} on ${i === 0 && failed ? branch : "main"}`,
          url: run.url,
          at: runAt,
        });
        if (i === 0) ciRun = run;
      });
      // A couple of pull requests across the window.
      for (let i = 0, k = rng.int(1, 2); i < k; i++) {
        const pr = ++prCounter % 9 + 1;
        const title = rng.pick(PR_TITLES);
        const verb = rng.next() < 0.5 ? "opened" : "merged";
        events.push({ source: "github", kind: "pull_request", title: `PR #${pr} ${verb}: ${title}`, url: `${ORG}/${a.repo}/pull/${pr}`, at: ago(rng.int(3, 110)) });
      }
    }

    // Health-change and ops events.
    if (p.health === "ok" && (p.status === "live" || p.status === "shipped")) {
      events.push({ source: "health", kind: "health_change", title: `Health unknown → ok (version ${sha})`, url: null, at: ago(Math.min(p.sinceH! + 1, 110)) });
    } else if (p.health === "degraded") {
      events.push({ source: "health", kind: "health_change", title: rng.pick(HEALTH_DEGRADED), url: null, at: ago(rng.int(2, 9)) });
    } else if (p.health === "down") {
      events.push({ source: "health", kind: "health_change", title: "Health ok → down", url: null, at: ago(rng.int(1, 5)) });
    }
    if (started) {
      events.push({ source: "ops_monitor", kind: "nightly", title: `Nightly check: ${p.status === "building" && p.pushH! >= 24 ? `no push for ${p.pushH} h` : "no stalled work"}`, url: null, at: ago(rng.int(6, 14)) });
    }

    // Status history, oldest first, ending at the current status.
    type T = { from: Status; to: Status; actor: "system" | "admin"; reason: string | null; at: Date };
    const history: T[] = [];
    let statusChangedAt = ago(p.sinceH ?? 24 * 14);
    if (started) {
      const path: { from: Status; to: Status; actor: "system" | "admin"; reason: string | null }[] = [];
      const upTo = p.status === "blocked" ? p.blockedFrom! : p.status;
      path.push({ from: "planned", to: "building", actor: "system", reason: null });
      if (upTo === "live" || upTo === "shipped") path.push({ from: "building", to: "live", actor: "system", reason: null });
      if (p.reworked) {
        path.push({ from: "live", to: "building", actor: "admin", reason: "Rework: summary cards were slow on mobile" });
        path.push({ from: "building", to: "live", actor: "system", reason: null });
      }
      if (upTo === "shipped") path.push({ from: "live", to: "shipped", actor: "admin", reason: null });
      if (p.status === "blocked") path.push({ from: p.blockedFrom!, to: "blocked", actor: "admin", reason: p.blockedReason! });
      // Space the steps backwards from the current status change.
      let t = statusChangedAt.getTime();
      const dated = [...path].reverse().map((step, i) => {
        if (i > 0) t -= rng.int(14, 60) * HOUR;
        return { ...step, at: new Date(t) };
      });
      history.push(...dated.reverse());
      for (const h of history) {
        if (!canTransition(h.from, h.to, h.actor) || requiresReason(h.from, h.to) !== (h.reason !== null)) {
          throw new Error(`demo seed built an invalid transition for app ${a.n}: ${h.from} -> ${h.to}`);
        }
      }
      statusChangedAt = history[history.length - 1].at;
    }

    // Board columns.
    const healthLive = p.health !== "unknown";
    const row = {
      n: a.n,
      status: p.status,
      blockedFrom: p.status === "blocked" ? p.blockedFrom! : null,
      statusChangedAt,
      healthUrl: null as string | null,
      health: p.health,
      healthVersion: healthLive ? sha : null,
      healthMs: healthLive ? (p.health === "down" ? null : p.health === "degraded" ? rng.int(900, 2400) : rng.int(70, 380)) : null,
      healthAt: healthLive ? ago(rng.int(1, 12) / 60) : null,
      lastPushAt,
      ciConclusion: ciRun ? ciRun.conclusion : null,
      ciWorkflow: ciRun ? "CI" : null,
      ciUrl: ciRun ? ciRun.url : null,
      ciAt: ciRun ? ciRun.at : null,
    };

    // Summary, from the same rules the real job uses so the two cannot disagree.
    const cloudUsage = usage
      .filter((u) => u.cloud === a.liveCloud && u.reportedAt.getTime() === ago(1).getTime())
      .map((u) => ({ metric: u.metric, usedPct: u.usedPct, chargeCents: u.chargeCents }));
    const facts: AppFacts = {
      n: a.n,
      name: a.name,
      status: row.status,
      statusChangedAt: row.statusChangedAt,
      health: row.health,
      healthVersion: row.healthVersion,
      lastPushAt: row.lastPushAt,
      ciConclusion: row.ciConclusion,
      ciWorkflow: row.ciWorkflow,
      liveCloud: a.liveCloud,
      eventTitles: events.map((e) => e.title),
      stalled: [],
      usage: started ? cloudUsage : [],
    };
    const rules = evaluateRules(facts, now);
    const flags: Flag[] = [...rules.flags];
    let health: SummaryHealth = rules.floor;
    if (p.status === "blocked") {
      flags.push({ kind: "other", detail: `Blocked from ${p.blockedFrom}: ${p.blockedReason}`.slice(0, 200) });
      if (health === "green") health = "amber";
    }
    const pushH = hoursBetween(row.lastPushAt, now);
    const summary = summarize(p, rules.flags, pushH, rng);

    return { app: a, row, events, history, summary: { appN: a.n, health, summary, flags } };
  });

  return { rows: out, usage, now };
}

function summarize(p: Plan, ruleFlags: Flag[], pushH: number | null, rng: ReturnType<typeof makeRng>): string {
  const has = (k: Flag["kind"]) => ruleFlags.some((f) => f.kind === k);
  switch (p.status) {
    case "planned":
      return "Not started.";
    case "blocked":
      return `Blocked since the status change; last push ${pushH} h ago. ${p.blockedReason}`.slice(0, 400);
    case "building": {
      const lead = `Building, last push ${pushH} h ago.`;
      if (has("failing_ci")) return `${lead} CI is failing on the latest push and needs a fix before the next merge.`;
      if (has("stalled")) return `${lead} Work has gone quiet for more than a day; check whether it is waiting on something.`;
      return `${lead} ${rng.pick(["CI is green and work is on track.", "Steady progress with passing CI.", "Recent pushes are landing cleanly."])}`;
    }
    case "live":
    case "shipped": {
      const word = p.status === "live" ? "Live" : "Shipped";
      if (p.health === "down") return `${word} but the health check is failing; visitors may be seeing errors.`;
      if (p.health === "degraded") return `${word} and answering slowly; the health check reports degraded. CI is green.`;
      const cloud = ruleFlags.some((f) => f.kind === "free_tier") ? " Free-tier use on its cloud is high." : "";
      return `${word} and healthy, CI is green.${cloud}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export type SeedResult = { counts: Record<string, number>; day: string };

export async function seedDemo(db: Db, opts: { force?: boolean; now?: Date } = {}): Promise<SeedResult> {
  const now = opts.now ?? new Date();
  const day = now.toISOString().slice(0, 10);

  const reason = await realDataReason(db);
  if (reason && !opts.force) {
    throw new DemoSeedRefusal(`Refusing to run: this database looks like it holds real data (${reason}). Use --force to overwrite it anyway.`);
  }

  const apps = await db.select({ n: schema.app.n, repo: schema.app.repo, name: schema.app.name, liveCloud: schema.app.liveCloud }).from(schema.app).orderBy(schema.app.n);
  if (apps.length !== 30) throw new DemoSeedRefusal(`Expected the 30 catalog apps but found ${apps.length}; run pnpm db:migrate first.`);

  const data = generate(apps, now);

  await db.transaction(async (tx) => {
    // Reset everything this script owns (and the unmarked tables it rewrites wholesale).
    await tx.delete(schema.appEvent).where(like(schema.appEvent.deliveryId, `${DEMO_PREFIX}%`));
    await tx.delete(schema.healthSummary).where(eq(schema.healthSummary.model, DEMO_MODEL));
    await tx.delete(schema.statusTransition);
    await tx.delete(schema.cloudUsage);

    await tx
      .insert(schema.user)
      .values({ id: DEMO_ADMIN_ID, name: "Demo Admin (seed)", email: "demo-seed-admin@demo.invalid", emailVerified: true, role: "admin" })
      .onConflictDoNothing();

    for (const r of data.rows) {
      const { n, ...cols } = r.row;
      await tx.update(schema.app).set(cols).where(eq(schema.app.n, n));
    }

    const events = data.rows.flatMap((r) =>
      r.events.map((e, i) => ({
        appN: r.app.n,
        source: e.source,
        kind: e.kind,
        deliveryId: `${DEMO_PREFIX}${r.app.n}-${i}`,
        title: e.title.slice(0, 200),
        url: e.url,
        occurredAt: e.at,
      })),
    );
    if (events.length) await tx.insert(schema.appEvent).values(events);

    const transitions = data.rows.flatMap((r) =>
      r.history.map((h) => ({
        appN: r.app.n,
        fromStatus: h.from,
        toStatus: h.to,
        reason: h.reason,
        actorId: h.actor === "admin" ? DEMO_ADMIN_ID : null,
        createdAt: h.at,
      })),
    );
    if (transitions.length) await tx.insert(schema.statusTransition).values(transitions);

    // Today's summary for every app; any real row for today is replaced so the board is uniform.
    await tx
      .insert(schema.healthSummary)
      .values(data.rows.map((r) => ({ ...r.summary, day, demo: true, model: DEMO_MODEL, createdAt: now, updatedAt: now })))
      .onConflictDoUpdate({
        target: [schema.healthSummary.appN, schema.healthSummary.day],
        set: {
          health: dsql`excluded.health`,
          summary: dsql`excluded.summary`,
          flags: dsql`excluded.flags`,
          demo: true,
          model: DEMO_MODEL,
          updatedAt: now,
        },
      });

    await tx.insert(schema.cloudUsage).values(data.usage);

    const started = data.rows.filter((r) => r.row.status !== "planned").length;
    const state = [
      { key: "last_sync", at: new Date(now.getTime() - 12 * 60_000), value: { catalog: { updated: 0 }, health: { ok: data.rows.filter((r) => r.row.health === "ok").length, down: data.rows.filter((r) => r.row.health === "down").length }, ms: 1840 } },
      { key: "last_ingest", at: new Date(now.getTime() - 3 * HOUR), value: { summary: "Nightly report (demo data)", apps: started, events: 1, cloud_usage: data.usage.length / 3 } },
    ];
    for (const s of state) {
      const value = { at: s.at.toISOString(), ...s.value };
      await tx
        .insert(schema.trackerState)
        .values({ key: s.key, value, updatedAt: s.at })
        .onConflictDoUpdate({ target: schema.trackerState.key, set: { value, updatedAt: s.at } });
    }
  });

  return {
    day,
    counts: {
      apps: data.rows.length,
      events: data.rows.reduce((s, r) => s + r.events.length, 0),
      transitions: data.rows.reduce((s, r) => s + r.history.length, 0),
      summaries: data.rows.length,
      cloud_usage: data.usage.length,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  assertSafeEnv(process.env);
  const url = process.env.DATABASE_URL;
  if (!url) throw new DemoSeedRefusal("DATABASE_URL is not set");
  const force = process.argv.includes("--force");

  console.log("Demo seed");
  console.log(`  database: ${describeTarget(url)}`);
  console.log(`  APP_URL:  ${process.env.APP_URL ?? "http://localhost:3000"}`);
  console.log("  will:     rewrite the state of all 30 apps; replace demo events, status history, today's summaries,");
  console.log("            cloud usage and tracker_state; add the login-less user demo-seed-admin" + (force ? "  (--force: real data may be overwritten)" : ""));

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const result = await seedDemo(drizzle(sql, { schema }), { force });
    console.log(`Done for ${result.day}: ${JSON.stringify(result.counts)}`);
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err instanceof DemoSeedRefusal ? err.message : err);
    process.exit(1);
  });
}
