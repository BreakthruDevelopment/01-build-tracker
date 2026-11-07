/**
 * scripts/seed-demo.mts against a real Postgres (TEST_DATABASE_URL).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/lib/db/schema";
import { DemoSeedRefusal, assertSafeEnv, describeTarget, seedDemo } from "../scripts/seed-demo.mts";

const url = process.env.TEST_DATABASE_URL;

describe("demo seed safety (no database)", () => {
  it("refuses without DEMO_SEED=yes", () => {
    expect(() => assertSafeEnv({ APP_URL: "http://localhost:3000" })).toThrow(DemoSeedRefusal);
  });
  it("refuses the production tracker and its Lambda URL", () => {
    expect(() => assertSafeEnv({ DEMO_SEED: "yes", APP_URL: "https://app1.breakthruventures.ai" })).toThrow(/production/);
    expect(() => assertSafeEnv({ DEMO_SEED: "yes", APP_URL: "https://x1.execute-api.us-east-2.amazonaws.com/p" })).toThrow(/production/);
  });
  it("allows localhost and hides credentials", () => {
    expect(() => assertSafeEnv({ DEMO_SEED: "yes", APP_URL: "http://localhost:3000" })).not.toThrow();
    expect(describeTarget("postgres://u:secret@db.example:5432/tracker")).toBe("db.example:5432/tracker");
  });
});

describe.skipIf(!url)("demo seed (Postgres)", () => {
  let sql: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const now = new Date("2026-11-06T12:00:00Z");

  beforeAll(() => {
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    db = drizzle(sql, { schema });
  });
  afterAll(async () => {
    // Leave the shared test database as the catalog migration left it, for the other files.
    await sql`delete from app_event`;
    await sql`delete from health_summary`;
    await sql`delete from status_transition`;
    await sql`delete from cloud_usage`;
    await sql`delete from tracker_state`;
    await sql`delete from "user" where id = 'demo-seed-admin'`;
    await sql`update app set status = 'planned', blocked_from = null, status_changed_at = now(), health_url = null, health = 'unknown',
      health_version = null, health_ms = null, health_at = null, last_push_at = null, ci_conclusion = null, ci_workflow = null, ci_url = null, ci_at = null`;
    await sql.end();
  });

  const apps = () => db.select().from(schema.app).orderBy(schema.app.n);

  it("produces the status spread, consistent health and a summary for every app", async () => {
    await sql`delete from app_event`;
    await seedDemo(db, { now });
    const rows = await apps();
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    expect([count("planned"), count("building"), count("live"), count("shipped"), count("blocked")]).toEqual([10, 8, 6, 4, 2]);

    for (const r of rows.filter((x) => x.status === "blocked")) expect(r.blockedFrom).not.toBeNull();
    for (const r of rows.filter((x) => x.status !== "blocked")) expect(r.blockedFrom).toBeNull();
    for (const r of rows.filter((x) => x.status === "planned")) {
      expect(r.health).toBe("unknown");
      expect(r.lastPushAt).toBeNull();
    }
    for (const r of rows.filter((x) => x.status !== "planned")) {
      expect(r.lastPushAt).not.toBeNull();
      expect(r.ciWorkflow).toBe("CI");
      expect(r.ciUrl).toMatch(new RegExp(`^https://github\\.com/BreakthruDevelopment/${r.repo}/actions/runs/\\d+$`));
    }
    for (const r of rows.filter((x) => x.health !== "unknown")) expect(r.healthVersion).toMatch(/^sha-[0-9a-f]{7}$/);

    const summaries = await db.select().from(schema.healthSummary).where(eq(schema.healthSummary.day, "2026-11-06"));
    expect(summaries).toHaveLength(30);
    for (const s of summaries) {
      expect(s.demo).toBe(true);
      expect(s.model).toBe("demo-seed");
      expect(s.summary.length).toBeLessThanOrEqual(400);
    }
    for (const r of rows.filter((x) => x.status !== "planned")) {
      expect(summaries.find((s) => s.appN === r.n)).toBeDefined();
    }
    const colors = new Set(summaries.map((s) => s.health));
    expect(colors).toEqual(new Set(["green", "amber", "red"]));
  });

  it("respects the rules: failing CI is red, down/degraded flags, one free-tier flag source, no charges", async () => {
    const rows = await apps();
    const summaries = await db.select().from(schema.healthSummary);
    const by = new Map(summaries.map((s) => [s.appN, s]));
    const failing = rows.filter((r) => r.ciConclusion === "failure");
    expect(failing.length).toBeGreaterThan(0);
    for (const r of failing) {
      const s = by.get(r.n)!;
      expect(s.health).toBe("red");
      expect(s.flags.map((f) => f.kind)).toContain("failing_ci");
    }
    for (const r of rows.filter((x) => (x.status === "live" || x.status === "shipped") && x.health === "down")) {
      expect(by.get(r.n)!.health).toBe("red");
      expect(by.get(r.n)!.flags.map((f) => f.kind)).toContain("down");
    }
    for (const r of rows.filter((x) => (x.status === "live" || x.status === "shipped") && x.health === "degraded")) {
      expect(by.get(r.n)!.health).not.toBe("green");
    }
    for (const s of summaries) for (const f of s.flags) expect(["stalled", "failing_ci", "down", "free_tier", "other"]).toContain(f.kind);
    expect(summaries.some((s) => s.flags.some((f) => f.kind === "free_tier"))).toBe(true);
    expect(summaries.some((s) => s.flags.some((f) => f.kind === "stalled"))).toBe(true);

    const usage = await db.select().from(schema.cloudUsage);
    expect(new Set(usage.map((u) => u.cloud))).toEqual(new Set(["aws", "azure", "gcp", "oci"]));
    expect(usage.some((u) => u.usedPct === 82)).toBe(true);
    expect(usage.every((u) => u.chargeCents === 0)).toBe(true);

    const state = await db.select().from(schema.trackerState);
    expect(state.map((s) => s.key).sort()).toEqual(["last_ingest", "last_sync"]);
  });

  it("has events within five days and a status history that ends at the current status", async () => {
    const events = await db.select().from(schema.appEvent);
    expect(events.length).toBeGreaterThan(100);
    for (const e of events) {
      expect(e.deliveryId).toMatch(/^demo-/);
      expect(now.getTime() - e.occurredAt.getTime()).toBeLessThan(5 * 24 * 3_600_000);
    }
    expect(new Set(events.map((e) => e.source))).toEqual(new Set(["github", "health", "ops_monitor"]));
    expect(new Set(events.filter((e) => e.source === "github").map((e) => e.kind))).toEqual(new Set(["push", "pull_request", "workflow_run"]));

    const rows = await apps();
    const transitions = await db.select().from(schema.statusTransition).orderBy(schema.statusTransition.createdAt);
    for (const r of rows) {
      const h = transitions.filter((t) => t.appN === r.n);
      if (r.status === "planned") {
        expect(h).toHaveLength(0);
        continue;
      }
      expect(h[0].fromStatus).toBe("planned");
      for (let i = 1; i < h.length; i++) expect(h[i].fromStatus).toBe(h[i - 1].toStatus);
      expect(h[h.length - 1].toStatus).toBe(r.status);
      expect(h[h.length - 1].createdAt.getTime()).toBe(r.statusChangedAt.getTime());
    }
    expect(transitions.some((t) => t.actorId === null)).toBe(true);
    expect(transitions.some((t) => t.actorId !== null)).toBe(true);
  });

  it("is idempotent", async () => {
    const snapshot = async () => ({
      apps: await apps(),
      events: await db.select().from(schema.appEvent).orderBy(schema.appEvent.deliveryId),
      summaries: (await db.select().from(schema.healthSummary).orderBy(schema.healthSummary.appN)).map((s) => ({ ...s, id: undefined })),
      transitions: await db.select().from(schema.statusTransition).then((t) => t.length),
      usage: await db.select().from(schema.cloudUsage).then((t) => t.length),
    });
    const strip = (xs: object[]) => xs.map((x) => ({ ...x, id: undefined }));
    const a = await snapshot();
    await seedDemo(db, { now });
    const b = await snapshot();
    expect(b.apps).toEqual(a.apps);
    expect(strip(b.events)).toEqual(strip(a.events));
    expect(b.summaries).toEqual(a.summaries);
    expect(b.transitions).toBe(a.transitions);
    expect(b.usage).toBe(a.usage);
  });

  it("refuses a database with real GitHub events unless forced", async () => {
    await db.insert(schema.appEvent).values({ appN: 1, source: "github", kind: "push", deliveryId: "real-delivery-1", title: "main: real commit" });
    await expect(seedDemo(db, { now })).rejects.toThrow(/real data/);
    // Nothing was touched by the refused run.
    expect((await db.select().from(schema.appEvent).where(eq(schema.appEvent.deliveryId, "real-delivery-1"))).length).toBe(1);
    await seedDemo(db, { now, force: true });
    await sql`delete from app_event where delivery_id = 'real-delivery-1'`;
  });
});
