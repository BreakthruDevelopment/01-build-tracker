/**
 * POST /api/summaries/run and the summary storage against a real Postgres (TEST_DATABASE_URL).
 * The model is a stubbed fetch (or demo mode); nothing here touches the network.
 */
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

const session = vi.hoisted(() => ({ role: null as null | "admin" | "user" }));
vi.mock("@/lib/auth/session", async () => {
  const { ForbiddenError, UnauthorizedError } = await import("@/lib/auth/rbac");
  return {
    requireRole: async () => {
      if (!session.role) throw new UnauthorizedError();
      if (session.role !== "admin") throw new ForbiddenError();
      return { id: "sum-admin", role: "admin", name: "a", email: "a@x.test" };
    },
  };
});

// Server actions call revalidatePath, which needs a Next request context.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const SYNC = "sync-token-for-tests-123456";
const ORIGIN = "http://localhost:3000";

describe.skipIf(!url)("daily summaries (Postgres)", () => {
  let sql: postgres.Sql;
  let envMod: typeof import("@/lib/env");
  let route: typeof import("@/app/api/summaries/run/route");
  let tracker: typeof import("@/lib/tracker");
  let actions: typeof import("@/app/actions/tracker");
  let modelCalls = 0;

  const setEnv = (vars: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    envMod.resetEnvCache();
  };

  /** A Gemini-shaped endpoint that answers every n it is given with a green summary. */
  function stubModel(answer?: (n: number) => object) {
    modelCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init: { body: string }) => {
        modelCalls++;
        const prompt: string = JSON.parse(init.body).contents[0].parts[0].text;
        const ns = prompt.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l).n as number);
        const apps = ns.map((n) => ({ n, health: "green", summary: `Model note for app ${n}.`, flags: [], ...answer?.(n) }));
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ apps }) }] } }] });
      }),
    );
  }

  const post = (opts: { token?: string; body?: unknown; origin?: string | null } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
    return route.POST(
      new Request("http://localhost/api/summaries/run", {
        method: "POST",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
    );
  };

  async function resetData() {
    await sql`delete from health_summary`;
    await sql`delete from app_event`;
    await sql`delete from cloud_usage where metric like 'sm-%'`;
    await sql`update app set status = 'planned', blocked_from = null, health = 'unknown', health_version = null,
      last_push_at = null, ci_conclusion = null, ci_workflow = null, ci_url = null, ci_at = null`;
  }
  const building = (ns: number[]) =>
    sql`update app set status = 'building', last_push_at = now() - interval '1 hour' where n in ${sql(ns)}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.LOG_LEVEL = "error";
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    envMod = await import("@/lib/env");
    route = await import("@/app/api/summaries/run/route");
    tracker = await import("@/lib/tracker");
    actions = await import("@/app/actions/tracker");
  });

  beforeEach(async () => {
    setEnv({ SYNC_TOKEN: SYNC, AI_PROVIDER: "demo", GEMINI_API_KEY: "test-key", AI_FALLBACK_TO_DEMO: "false", APP_URL: undefined });
    await resetData();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    session.role = null;
  });

  afterAll(async () => {
    await resetData();
    await sql.end();
  });

  // -------------------------------------------------------------------------
  describe("generation", () => {
    it("demo mode stores a summary for every app in the batch, and the board shows it", async () => {
      await building([1, 2, 3, 4]);
      await sql`update app set ci_conclusion = 'failure', ci_workflow = 'ci' where n = 3`;

      const res = await post({ token: SYNC });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ done: 30, remaining: 0 });

      const rows = await sql`select app_n, health, summary, flags, demo, model from health_summary order by app_n`;
      expect(rows).toHaveLength(30);
      const by = Object.fromEntries(rows.map((r) => [r.app_n, r]));
      expect(by[1].demo).toBe(true); // fixture text
      expect(by[1].summary).toMatch(/^Live on AWS/);
      expect(by[3].health).toBe("red"); // rule floor on an app the fixture knows nothing about
      expect(by[3].flags[0].kind).toBe("failing_ci");
      expect(by[3].model).toBe("rules");
      expect(by[4].demo).toBe(false);
      expect(by[20]).toMatchObject({ health: "green", summary: "Not started.", flags: [], demo: false });

      const board = await tracker.listBoard();
      expect(board.find((a) => a.n === 3)).toMatchObject({ summaryHealth: "red" });
      expect(board.find((a) => a.n === 20)).toMatchObject({ summary: "Not started.", summaryDemo: false });
      const detail = await tracker.getApp(3);
      expect(detail.summaryFlags[0].kind).toBe("failing_ci");
    });

    it("a second run the same day makes no model call and changes nothing", async () => {
      setEnv({ AI_PROVIDER: "gemini" });
      stubModel();
      await building([1, 2, 3]);

      expect(await (await post({ token: SYNC })).json()).toEqual({ done: 30, remaining: 0 });
      expect(modelCalls).toBe(1);
      const before = await sql`select app_n, summary, updated_at from health_summary order by app_n`;

      expect(await (await post({ token: SYNC })).json()).toEqual({ done: 0, remaining: 0 });
      expect(modelCalls).toBe(1);
      const after = await sql`select app_n, summary, updated_at from health_summary order by app_n`;
      expect(after).toEqual(before);
    });

    it("summarizes at most 6 apps per call and reports what remains", async () => {
      setEnv({ AI_PROVIDER: "gemini" });
      stubModel();
      await building([1, 2, 3, 4, 5, 6, 7, 8]);

      const first = await (await post({ token: SYNC })).json();
      expect(first.remaining).toBe(2);
      expect(modelCalls).toBe(1);
      const stored = await sql`select app_n from health_summary where model is not null and model <> 'rules'`;
      expect(stored.map((r) => r.app_n).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);

      expect(await (await post({ token: SYNC })).json()).toEqual({ done: 2, remaining: 0 });
      expect(modelCalls).toBe(2);
    });

    it("applies the rule floor to what the model said and what gets stored", async () => {
      setEnv({ AI_PROVIDER: "gemini" });
      stubModel(); // always green, no flags
      await building([1]);
      await sql`insert into cloud_usage (cloud, metric, used_pct, charge_cents) values ((select live_cloud from app where n = 1), 'sm-requests', 82, 0)`;
      await sql`update app set ci_conclusion = 'failure', ci_workflow = 'ci' where n = 1`;
      await post({ token: SYNC });
      const [row] = await sql`select health, summary, flags from health_summary where app_n = 1`;
      expect(row.health).toBe("red");
      expect(row.flags.map((f: { kind: string }) => f.kind)).toEqual(["failing_ci", "free_tier"]);
      expect(row.summary).not.toMatch(/Model note/);
    });

    it("ops-monitor stalled reports, event titles and recent usage reach the rules", async () => {
      await building([1]);
      await sql`update app set last_push_at = now() - interval '30 hours' where n = 1`;
      await sql`insert into app_event (app_n, source, kind, title) values (1, 'ops_monitor', 'stalled.pr', 'Stalled (26 h): PR #4 waiting 26 h')`;
      await post({ token: SYNC });
      const [row] = await sql`select health, flags from health_summary where app_n = 1`;
      expect(row.health).toBe("amber");
      expect(row.flags[0]).toMatchObject({ kind: "stalled" });
      expect(row.flags[0].detail).toMatch(/30 h/);
      expect(row.flags[0].detail).toMatch(/PR #4/);
    });

    it("a provider failure with demo fallback on stores rule-only placeholders, not fixture text, and the next run replaces them", async () => {
      setEnv({ AI_PROVIDER: "gemini", AI_FALLBACK_TO_DEMO: "true" });
      vi.stubGlobal("fetch", vi.fn(async () => { modelCalls++; return new Response("quota", { status: 429 }); }));
      modelCalls = 0;
      await building([1, 2, 3]);

      const first = await (await post({ token: SYNC })).json();
      expect(first).toMatchObject({ fallback: true, remaining: 3 });
      expect(modelCalls).toBe(1);
      const rows = await sql`select app_n, summary, demo, model from health_summary where app_n in (1, 2, 3) order by app_n`;
      for (const r of rows) {
        expect(r.model).toBe("rules-fallback");
        expect(r.demo).toBe(true);
        expect(r.summary).not.toMatch(/sha-1a2b3c4|PR #3|Live on AWS/);
      }
      // Not-started apps are real answers and are not retried.
      const [ns] = await sql`select model, demo from health_summary where app_n = 20`;
      expect(ns).toEqual({ model: null, demo: false });

      // The model recovers: the next run calls it again and overwrites the placeholders.
      stubModel();
      const second = await (await post({ token: SYNC })).json();
      expect(second).toEqual({ done: 3, remaining: 0 });
      expect(modelCalls).toBe(1);
      const after = await sql`select summary, demo, model from health_summary where app_n in (1, 2, 3) order by app_n`;
      expect(after.map((r) => r.summary)).toEqual(["Model note for app 1.", "Model note for app 2.", "Model note for app 3."]);
      expect(after.every((r) => !r.demo && r.model !== "rules-fallback")).toBe(true);
    });

    it("a fallback placeholder does not block an admin's regenerate", async () => {
      setEnv({ AI_PROVIDER: "gemini", AI_FALLBACK_TO_DEMO: "true" });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("quota", { status: 429 })));
      await building([1]);
      await post({ token: SYNC });
      session.role = "admin";
      stubModel();
      expect((await post({ body: { n: 1 } })).status).toBe(200);
      const [row] = await sql`select summary from health_summary where app_n = 1`;
      expect(row.summary).toBe("Model note for app 1.");
    });

    it("the stall rule counts pushes on any branch, not only the default branch", async () => {
      await building([1, 2]);
      await sql`update app set last_push_at = now() - interval '40 hours' where n in (1, 2)`;
      await sql`insert into app_event (app_n, source, kind, title, occurred_at) values (1, 'github', 'push', 'claude/x: wip', now() - interval '2 hours')`;
      await sql`insert into app_event (app_n, source, kind, title, occurred_at) values (2, 'github', 'push', 'main: old', now() - interval '40 hours')`;
      await post({ token: SYNC });
      const rows = await sql`select app_n, health from health_summary where app_n in (1, 2) order by app_n`;
      expect(rows.map((r) => r.health)).toEqual(["green", "amber"]);
    });

    it("health older than 6 hours (or never checked) counts as unknown for the rules", async () => {
      await sql`update app set status = 'live', health = 'down', health_at = now() - interval '7 hours' where n = 1`;
      await sql`update app set status = 'live', health = 'down', health_at = now() - interval '1 hour', last_push_at = now() where n = 2`;
      await sql`update app set status = 'live', health = 'down', health_at = null, last_push_at = now() where n = 3`;
      await post({ token: SYNC });
      const rows = await sql`select app_n, health from health_summary where app_n in (1, 2, 3) order by app_n`;
      expect(rows.map((r) => r.health)).toEqual(["green", "red", "green"]);
    });

    it("a failed model call stores nothing so the next run retries", async () => {
      setEnv({ AI_PROVIDER: "gemini" });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
      await building([1]);
      const res = await post({ token: SYNC });
      expect(res.status).toBe(502);
      const [{ c }] = await sql`select count(*)::int as c from health_summary where app_n = 1`;
      expect(c).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("regenerate", () => {
    it("is limited to once per app per hour, measured from updated_at", async () => {
      await building([1]);
      await post({ token: SYNC });

      session.role = "admin";
      const tooSoon = await post({ body: { n: 1 } });
      expect(tooSoon.status).toBe(429);

      await sql`update health_summary set updated_at = now() - interval '2 hours', summary = 'stale' where app_n = 1`;
      const ok = await post({ body: { n: 1 } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ done: 1, remaining: 0 });
      const [row] = await sql`select summary from health_summary where app_n = 1`;
      expect(row.summary).not.toBe("stale");

      expect((await post({ body: { n: 1 } })).status).toBe(429);
      // A different app is not affected.
      expect((await post({ body: { n: 2 } })).status).toBe(429); // generated by the same daily run
      await sql`update health_summary set updated_at = now() - interval '2 hours' where app_n = 2`;
      expect((await post({ body: { n: 2 } })).status).toBe(200);
    });

    it("works when no summary exists yet, 404 for an unknown app, 400 for a bad body", async () => {
      session.role = "admin";
      expect((await post({ body: { n: 5 } })).status).toBe(200);
      expect((await post({ body: { n: 999 } })).status).toBe(404);
      expect((await post({ body: { n: "x" } })).status).toBe(400);
      expect((await post({ body: { n: 1, extra: true } })).status).toBe(400);
    });

    it("the server action requires an admin and uses the same limit", async () => {
      session.role = "user";
      expect(await actions.regenerateSummaryAction(3)).toMatchObject({ ok: false, status: 403 });
      session.role = null;
      expect(await actions.regenerateSummaryAction(3)).toMatchObject({ ok: false, status: 401 });
      session.role = "admin";
      expect(await actions.regenerateSummaryAction(3)).toMatchObject({ ok: true, data: { done: 1 } });
      expect(await actions.regenerateSummaryAction(3)).toMatchObject({ ok: false, status: 429 });
    });
  });

  // -------------------------------------------------------------------------
  describe("endpoint auth", () => {
    it("no credentials and a configured token: 401; a wrong token: 401", async () => {
      expect((await post()).status).toBe(401);
      expect((await post({ token: "wrong-token-wrong-token" })).status).toBe(401);
    });

    it("503 when SYNC_TOKEN is unset, for a token attempt and for a signed-out caller", async () => {
      setEnv({ SYNC_TOKEN: undefined });
      expect((await post({ token: SYNC })).status).toBe(503);
      expect((await post()).status).toBe(503);
      const [{ c }] = await sql`select count(*)::int as c from health_summary`;
      expect(c).toBe(0);
    });

    it("a signed-in non-admin gets 403", async () => {
      session.role = "user";
      expect((await post()).status).toBe(403);
    });

    it("an admin session works, but only from our own origin", async () => {
      session.role = "admin";
      expect((await post()).status).toBe(200);
      expect((await post({ origin: "https://app2.breakthruventures.ai" })).status).toBe(403);
      expect((await post({ origin: null })).status).toBe(403);
    });

    it("the token cannot regenerate a single app (admin only)", async () => {
      expect((await post({ token: SYNC, body: { n: 1 } })).status).toBe(403);
    });
  });
});
