/**
 * Webhook, ingest and sync endpoints against a real Postgres (TEST_DATABASE_URL).
 * Fetch and DNS are stubbed; nothing here touches the network.
 */
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

// Controls who "is signed in" on the sync route.
const session = vi.hoisted(() => ({ role: null as null | "admin" | "user" }));
vi.mock("@/lib/auth/session", async () => {
  const { ForbiddenError, UnauthorizedError } = await import("@/lib/auth/rbac");
  return {
    requireRole: async () => {
      if (!session.role) throw new UnauthorizedError();
      if (session.role !== "admin") throw new ForbiddenError();
      return { id: "mt-admin", role: "admin", name: "a", email: "a@x.test" };
    },
  };
});

// DNS: sslip.io style names resolve to the IP in the name; everything else to a public address.
const dns = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    dns.calls.push(host);
    const dashed = /^(\d+)-(\d+)-(\d+)-(\d+)\.sslip\.io$/.exec(host);
    const dotted = /^(\d+\.\d+\.\d+\.\d+)\.sslip\.io$/.exec(host);
    const mapped = host === "mapped.sslip.io" ? "::ffff:127.0.0.1" : null;
    if (host === "mixed.sslip.io") {
      return [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ];
    }
    if (host === "nodns.breakthruventures.ai") throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    const address = mapped ?? (dashed ? dashed.slice(1).join(".") : dotted ? dotted[1] : "93.184.216.34");
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  },
}));

const SECRET = "webhook-secret-for-tests-1234";
const INGEST = "ingest-token-for-tests-12345";
const SYNC = "sync-token-for-tests-123456";

describe.skipIf(!url)("machine endpoints (Postgres)", () => {
  let sql: postgres.Sql;
  let envMod: typeof import("@/lib/env");
  let webhook: typeof import("@/app/api/webhooks/github/route");
  let ingest: typeof import("@/app/api/ingest/route");
  let syncRoute: typeof import("@/app/api/sync/route");

  const setEnv = (vars: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    envMod.resetEnvCache();
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    envMod = await import("@/lib/env");
    setEnv({ GITHUB_WEBHOOK_SECRET: SECRET, INGEST_TOKEN: INGEST, SYNC_TOKEN: SYNC });
    webhook = await import("@/app/api/webhooks/github/route");
    ingest = await import("@/app/api/ingest/route");
    syncRoute = await import("@/app/api/sync/route");
  });

  afterAll(async () => {
    await sql`delete from app_event where app_n between 1 and 30`;
    await sql`delete from status_transition where app_n between 1 and 30`;
    await sql`delete from cloud_usage where metric like 'mt-%'`;
    await sql`delete from tracker_state`;
    await resetApps();
    await sql.end();
  });

  async function resetApps() {
    await sql`update app set status = 'planned', blocked_from = null, health_url = null, health = 'unknown',
      health_version = null, health_ms = null, health_at = null, health_failing_since = null, last_push_at = null,
      ci_conclusion = null, ci_workflow = null, ci_url = null, ci_at = null`;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    setEnv({ GITHUB_WEBHOOK_SECRET: SECRET, INGEST_TOKEN: INGEST, SYNC_TOKEN: SYNC });
    session.role = null;
  });

  // -------------------------------------------------------------------------
  describe("POST /api/webhooks/github", () => {
    const n = 10;
    let repoName = "";
    let seq = 0;

    beforeAll(async () => {
      await resetApps();
      await sql`delete from app_event where app_n = ${n}`;
      const [row] = await sql`select repo from app where n = ${n}`;
      repoName = row.repo;
    });

    const sign = (body: string, secret = SECRET) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    function send(event: string, payload: unknown, opts: { delivery?: string; sig?: string | null; raw?: string } = {}) {
      const body = opts.raw ?? JSON.stringify(payload);
      const headers: Record<string, string> = { "x-github-event": event, "x-github-delivery": opts.delivery ?? `d-${Date.now()}-${seq++}` };
      if (opts.sig !== null) headers["x-hub-signature-256"] = opts.sig ?? sign(body);
      return webhook.POST(new Request("http://localhost/api/webhooks/github", { method: "POST", body, headers }));
    }
    const repository = (full = `BreakthruDevelopment/${repoName}`) => ({ full_name: full, default_branch: "main" });
    const pushPayload = (message = "feat: add thing", ref = "refs/heads/main") => ({
      repository: repository(),
      ref,
      head_commit: { message, url: `https://github.com/BreakthruDevelopment/${repoName}/commit/abc`, timestamp: "2026-11-01T10:00:00Z" },
    });
    const events = () => sql`select * from app_event where app_n = ${n} order by occurred_at`;

    it("503 when the secret is unset", async () => {
      setEnv({ GITHUB_WEBHOOK_SECRET: undefined });
      const res = await send("push", pushPayload());
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "not configured" });
    });

    it("401 on a bad or missing signature, and writes nothing", async () => {
      const bad = await send("push", pushPayload(), { sig: sign("{}", "another-secret-of-16-chars") });
      expect(bad.status).toBe(401);
      expect((await send("push", pushPayload(), { sig: null })).status).toBe(401);
      expect((await send("push", pushPayload(), { sig: "sha256=zz" })).status).toBe(401);
      expect(await events()).toHaveLength(0);
    });

    it("413 over 1 MB", async () => {
      const raw = JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) });
      expect((await send("push", null, { raw })).status).toBe(413);
    });

    it("ping is 200 and unhandled events are 202", async () => {
      expect((await send("ping", { zen: "hi" })).status).toBe(200);
      const res = await send("issues", { action: "opened" });
      expect(res.status).toBe(202);
    });

    it("a valid push stores an allow-listed event, sets last_push_at and moves planned to building once", async () => {
      const res = await send("push", { ...pushPayload("fix: thing\n\nlong body " + "y".repeat(500)), secret_field: "TOPSECRET" }, { delivery: "d-push-1" });
      expect(res.status).toBe(200);
      const rows = await events();
      expect(rows).toHaveLength(1);
      expect(rows[0].source).toBe("github");
      expect(rows[0].kind).toBe("push");
      expect(rows[0].delivery_id).toBe("d-push-1");
      expect(rows[0].title.length).toBeLessThanOrEqual(200);
      expect(JSON.stringify(rows[0])).not.toContain("TOPSECRET");
      const [a] = await sql`select status, last_push_at from app where n = ${n}`;
      expect(a.status).toBe("building");
      expect(a.last_push_at).not.toBeNull();
      const t = await sql`select * from status_transition where app_n = ${n}`;
      expect(t).toHaveLength(1);
      expect(t[0].actor_id).toBeNull();
      expect(t[0].to_status).toBe("building");
    });

    it("is idempotent: a second push and a pull_request keep it building with one transition", async () => {
      expect((await send("push", pushPayload("second"))).status).toBe(200);
      const pr = await send("pull_request", {
        repository: repository(),
        action: "opened",
        pull_request: { number: 7, title: "A PR", html_url: `https://github.com/BreakthruDevelopment/${repoName}/pull/7` },
      });
      expect(pr.status).toBe(200);
      const [a] = await sql`select status from app where n = ${n}`;
      expect(a.status).toBe("building");
      expect(await sql`select 1 from status_transition where app_n = ${n}`).toHaveLength(1);
    });

    it("never moves a blocked app", async () => {
      await sql`update app set status = 'blocked', blocked_from = 'planned' where n = ${n}`;
      expect((await send("push", pushPayload("while blocked"))).status).toBe(200);
      const [a] = await sql`select status from app where n = ${n}`;
      expect(a.status).toBe("blocked");
      await sql`update app set status = 'building', blocked_from = null where n = ${n}`;
    });

    it("a duplicate delivery returns 200 and adds no row", async () => {
      const before = (await events()).length;
      expect((await send("push", pushPayload("dup"), { delivery: "d-dup" })).status).toBe(200);
      const again = await send("push", pushPayload("dup"), { delivery: "d-dup" });
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ duplicate: true });
      expect((await events()).length).toBe(before + 1);
    });

    it("unknown repos and other owners are 202 with no rows", async () => {
      const before = (await events()).length;
      const total = (await sql`select count(*)::int as c from app_event`)[0].c;
      expect((await send("push", { ...pushPayload(), repository: repository("BreakthruDevelopment/not-in-catalog") })).status).toBe(202);
      expect((await send("push", { ...pushPayload(), repository: repository(`someoneelse/${repoName}`) })).status).toBe(202);
      expect((await events()).length).toBe(before);
      expect((await sql`select count(*)::int as c from app_event`)[0].c).toBe(total);
    });

    it("owner match is case-insensitive", async () => {
      const res = await send("push", { ...pushPayload("case"), repository: repository(`breakthrudevelopment/${repoName.toUpperCase()}`) });
      expect(res.status).toBe(200);
    });

    it("a completed workflow_run on the default branch updates the ci columns; other branches don't", async () => {
      const run = (branch: string, conclusion: string, wf = "ci") => ({
        repository: repository(),
        action: "completed",
        workflow_run: {
          name: wf,
          conclusion,
          head_branch: branch,
          html_url: `https://github.com/BreakthruDevelopment/${repoName}/actions/runs/1`,
          updated_at: "2026-11-02T10:00:00Z",
        },
      });
      expect((await send("workflow_run", run("main", "failure"))).status).toBe(200);
      let [a] = await sql`select ci_conclusion, ci_workflow, ci_url, ci_at from app where n = ${n}`;
      expect(a).toMatchObject({ ci_conclusion: "failure", ci_workflow: "ci" });
      expect(a.ci_url).toContain("/actions/runs/1");
      expect(a.ci_at).not.toBeNull();
      expect((await send("workflow_run", { ...run("feature", "success"), workflow_run: { ...run("feature", "success").workflow_run, updated_at: "2026-11-03T10:00:00Z" } })).status).toBe(200);
      [a] = await sql`select ci_conclusion from app where n = ${n}`;
      expect(a.ci_conclusion).toBe("failure");
      // A run that has not completed is ignored.
      const queued = await send("workflow_run", { ...run("main", "success"), action: "requested" });
      expect(queued.status).toBe(202);
    });

    it("rejects a non-JSON body with 400 after the signature passes", async () => {
      expect((await send("push", null, { raw: "not json" })).status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  describe("POST /api/ingest", () => {
    const post = (body: unknown, token: string | null = INGEST, raw?: string) =>
      ingest.POST(
        new Request("http://localhost/api/ingest", {
          method: "POST",
          body: raw ?? JSON.stringify(body),
          headers: token ? { authorization: `Bearer ${token}` } : {},
        }),
      );
    const report = () => ({
      reported_at: "2026-11-04T03:00:00Z",
      apps: [
        { n: 11, ci: { conclusion: "failure", workflow: "ci", url: "https://github.com/BreakthruDevelopment/x/actions/runs/9" }, stalled: [{ kind: "pr_waiting", detail: "PR #4 waiting on review", hours: 26 }] },
        { repo: "NOT-IN-CATALOG", stalled: [{ kind: "idle", detail: "x" }] },
      ],
      clouds: [{ cloud: "aws", metrics: [{ metric: "mt-lambda-requests", used_pct: 82.4, charge_cents: 0 }] }],
      summary: "All quiet",
    });

    it("401 without or with a wrong token; writes nothing", async () => {
      expect((await post(report(), null)).status).toBe(401);
      expect((await post(report(), "wrong-token-wrong-token")).status).toBe(401);
    });

    it("503 when INGEST_TOKEN is unset", async () => {
      setEnv({ INGEST_TOKEN: undefined });
      const res = await post(report(), INGEST);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "not configured" });
    });

    it("a valid report writes events, ci columns, cloud_usage and last_ingest", async () => {
      await sql`delete from app_event where app_n = 11`;
      const res = await post(report());
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, apps: 1, skipped: 1, events: 2, cloud_usage: 1 });
      const ev = await sql`select * from app_event where app_n = 11 order by kind`;
      expect(ev.map((e) => e.kind)).toEqual(["ci", "stalled.pr_waiting"]);
      expect(ev.every((e) => e.source === "ops_monitor")).toBe(true);
      expect(ev[1].title).toContain("26 h");
      const [a] = await sql`select ci_conclusion from app where n = 11`;
      expect(a.ci_conclusion).toBe("failure");
      const usage = await sql`select * from cloud_usage where metric = 'mt-lambda-requests'`;
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ cloud: "aws", used_pct: 82, charge_cents: 0 });
      const [state] = await sql`select value from tracker_state where key = 'last_ingest'`;
      expect(state.value.summary).toBe("All quiet");
    });

    it("413 over 64 KB", async () => {
      const res = await post({ ...report(), summary: "x".repeat(70 * 1024) });
      expect(res.status).toBe(413);
    });

    it("400 for a bad shape", async () => {
      expect((await post({ ...report(), reported_at: "yesterday" })).status).toBe(400);
      expect((await post({ ...report(), clouds: [{ cloud: "ibm", metrics: [] }] })).status).toBe(400);
      expect((await post({ ...report(), clouds: [{ cloud: "aws", metrics: [{ metric: "m", used_pct: 101, charge_cents: 0 }] }] })).status).toBe(400);
      expect((await post({ ...report(), clouds: [{ cloud: "aws", metrics: [{ metric: "m", used_pct: 5, charge_cents: -1 }] }] })).status).toBe(400);
      expect((await post({ ...report(), apps: [{ stalled: [] }] })).status).toBe(400);
      expect((await post({ ...report(), summary: "x".repeat(501) })).status).toBe(400);
      expect((await post(null, INGEST, "{nope")).status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  describe("POST /api/sync", () => {
    const post = (token: string | null = SYNC, origin?: string) =>
      syncRoute.POST(
        new Request("http://localhost/api/sync", {
          method: "POST",
          headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
        }),
      );

    type Handler = (u: URL) => Response | Promise<Response>;
    function stubFetch(handler: Handler, delayMs = 40) {
      const fetched: string[] = [];
      vi.stubGlobal("fetch", async (input: string | URL) => {
        const u = new URL(String(input));
        fetched.push(u.toString());
        await new Promise((r) => setTimeout(r, delayMs));
        return handler(u);
      });
      return fetched;
    }
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    const catalogYaml = async (overrides: Record<number, string> = {}) => {
      const rows = await sql`select n, repo, name, subdomain, live_cloud from app order by n`;
      const apps = rows
        .map((r) => `  - n: ${r.n}\n    repo: ${r.repo}\n    name: "${overrides[r.n] ?? r.name}"\n    subdomain: ${r.subdomain}\n    live_cloud: ${r.live_cloud}\n    status: shipped\n    client_need: "ignored"`)
        .join("\n");
      return `domain: breakthruventures.ai\napps:\n${apps}\n`;
    };
    const healthy = (version = "abc1234") => json({ status: "ok", version });
    // Planned apps are polled too. Point the ones a test doesn't care about at a name with no DNS record, so
    // they skip. Call after the test has set the statuses and health URLs it needs.
    const park = () =>
      sql`update app set health_url = 'https://nodns.breakthruventures.ai/api/health' where status = 'planned' and health_url is null`;

    it("401 / 403 / 503 gates", async () => {
      stubFetch(() => healthy());
      expect((await post(null)).status).toBe(401); // no token, signed out
      expect((await post("bad-token-bad-token-bad")).status).toBe(401);
      session.role = "user";
      expect((await post(null)).status).toBe(403);
      setEnv({ SYNC_TOKEN: undefined });
      session.role = null;
      const closed = await post(null);
      expect(closed.status).toBe(503);
      expect((await post(SYNC)).status).toBe(503);
    });

    it("a signed-in admin can run it without a token", async () => {
      await resetApps();
      stubFetch(async (u) => (u.hostname === "raw.githubusercontent.com" ? new Response(await catalogYaml()) : healthy()));
      session.role = "admin";
      setEnv({ SYNC_TOKEN: undefined });
      const res = await post(null, new URL(envMod.env().APP_URL).origin);
      expect(res.status).toBe(200);
    });

    it("refuses an admin session from another origin or with no Origin", async () => {
      session.role = "admin";
      setEnv({ SYNC_TOKEN: undefined });
      expect((await post(null, "https://app2.breakthruventures.ai")).status).toBe(403);
      expect((await post(null)).status).toBe(403);
    });

    it("upserts the catalog but never changes status, and polls 30 apps well under 20 s", async () => {
      await resetApps();
      await sql`update app set status = 'building' where n between 2 and 30`; // app 1 stays planned
      await park();
      const [orig] = await sql`select name from app where n = 5`;
      await sql`update app set name = 'Stale name' where n = 5`;
      const fetched = stubFetch(async (u) => {
        if (u.hostname === "raw.githubusercontent.com") return new Response(await catalogYaml({ 5: "Fresh name" }));
        return healthy("sha-1a2b3c4");
      }, 100);
      const started = Date.now();
      const res = await post();
      const elapsed = Date.now() - started;
      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(20_000);
      const body = await res.json();
      expect(body.catalog.updated).toBe(1);
      expect(body.health).toMatchObject({ checked: 29, ok: 29, down: 0, skipped: 1 });
      expect(fetched.filter((f) => f.endsWith("/api/health"))).toHaveLength(29);

      const [five] = await sql`select name, status from app where n = 5`;
      expect(five.name).toBe("Fresh name");
      // building -> live by health; planned app 1 untouched (catalog says "shipped", ignored).
      const [one] = await sql`select status from app where n = 1`;
      expect(one.status).toBe("planned");
      const statuses = await sql`select distinct status from app where n between 2 and 30`;
      expect(statuses.map((s) => s.status)).toEqual(["live"]);
      const [a] = await sql`select health, health_version, health_ms, health_at from app where n = 2`;
      expect(a.health).toBe("ok");
      expect(a.health_version).toBe("sha-1a2b3c4");
      expect(a.health_ms).toBeGreaterThanOrEqual(0);
      expect(a.health_at).not.toBeNull();
      const [state] = await sql`select value from tracker_state where key = 'last_sync'`;
      expect(state.value.health.checked).toBe(29);
      await sql`update app set name = ${orig.name} where n = 5`;
    });

    it("writes a health event only when health changes", async () => {
      await resetApps();
      await sql`delete from app_event where source = 'health'`;
      await sql`update app set status = 'building' where n = 3`;
      await park();
      let mode: "ok" | "down" = "ok";
      stubFetch(async (u) => {
        if (u.hostname === "raw.githubusercontent.com") return new Response("apps: []"); // invalid: catalog error, polling continues
        return mode === "ok" ? healthy("dev") : json({ status: "down" }, 503);
      });
      const first = await (await post()).json();
      expect(first.catalog.error).toBeDefined();
      await post();
      expect(await sql`select 1 from app_event where app_n = 3 and source = 'health'`).toHaveLength(1);
      // version "dev" does not promote.
      expect((await sql`select status from app where n = 3`)[0].status).toBe("building");
      mode = "down";
      // The first failed check is unconfirmed: nothing changes. A second one 1 to 4 minutes later records down.
      const third = await (await post()).json();
      expect(third.health).toMatchObject({ down: 0, unconfirmed: 1 });
      expect(await sql`select 1 from app_event where app_n = 3 and source = 'health'`).toHaveLength(1);
      await sql`update app set health_failing_since = now() - interval '2 minutes' where n = 3`;
      const fourth = await (await post()).json();
      expect(fourth.health).toMatchObject({ down: 1, unconfirmed: 0 });
      const ev = await sql`select title from app_event where app_n = 3 and source = 'health' order by occurred_at`;
      expect(ev).toHaveLength(2);
      expect(ev[1].title).toContain("down");
    });

    it("does not promote on a degraded response, and caps the response it reads", async () => {
      await resetApps();
      await sql`update app set status = 'building' where n in (4, 6)`;
      stubFetch(async (u) => {
        if (u.hostname === "raw.githubusercontent.com") return new Response("apps: []");
        if (u.hostname === "app4.breakthruventures.ai") return json({ status: "degraded", version: "v1" });
        // 16 KB cap: the JSON is cut, so it isn't "ok".
        return new Response('{"status":"ok","version":"v1","pad":"' + "x".repeat(40_000) + '"}');
      });
      await post();
      const rows = await sql`select n, status, health from app where n in (4, 6) order by n`;
      expect(rows.map((r) => [r.status, r.health])).toEqual([["building", "degraded"], ["building", "degraded"]]);
    });

    it("refuses private-IP sslip.io names, mapped v6, non-allow-listed URLs and redirects", async () => {
      await resetApps();
      await sql`update app set status = 'building' where n between 7 and 12`;
      await sql`update app set health_url = 'https://127.0.0.1.sslip.io/api/health' where n = 7`;
      await sql`update app set health_url = 'https://169-254-169-254.sslip.io/latest/meta-data' where n = 8`;
      await sql`update app set health_url = 'https://10-0-0-5.sslip.io/api/health' where n = 9`;
      await sql`update app set health_url = 'https://mapped.sslip.io/api/health' where n = 10`;
      await sql`update app set health_url = 'http://app11.breakthruventures.ai/api/health' where n = 11`; // http: fails parseHealthUrl at fetch time
      await sql`update app set health_url = 'https://hop.breakthruventures.ai/api/health' where n = 12`; // redirects
      await park();
      const fetched = stubFetch(async (u) => {
        if (u.hostname === "raw.githubusercontent.com") return new Response("apps: []");
        if (u.hostname === "hop.breakthruventures.ai") return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } });
        return healthy();
      });
      const body = await (await post()).json();
      expect(body.health).toMatchObject({ checked: 0, skipped: 30 }); // 6 refused + 24 parked planned apps
      expect(fetched.filter((f) => f.includes("sslip.io") || f.includes("app11"))).toEqual([]);
      expect(fetched.filter((f) => f.includes("hop."))).toHaveLength(1); // requested once, redirect not followed
      expect(fetched.some((f) => f.includes("169.254.169.254/"))).toBe(false);
      const rows = await sql`select distinct health from app where n between 7 and 12`;
      expect(rows.map((r) => r.health)).toEqual(["unknown"]);
    });

    it("refuses a name when any of its DNS answers is private, and skips names with no DNS record", async () => {
      await resetApps();
      await sql`update app set status = 'building', health_url = 'https://mixed.sslip.io/api/health' where n = 15`;
      await sql`update app set status = 'building', health_url = 'https://nodns.breakthruventures.ai/api/health' where n = 16`;
      await park();
      const fetched = stubFetch(async (u) => (u.hostname === "raw.githubusercontent.com" ? new Response("apps: []") : healthy()));
      const body = await (await post()).json();
      expect(body.health).toMatchObject({ checked: 0, skipped: 30 }); // 2 refused + 28 parked planned apps
      expect(fetched.some((f) => f.includes("mixed.sslip.io") || f.includes("nodns."))).toBe(false);
      const rows = await sql`select distinct health from app where n in (15, 16)`;
      expect(rows.map((r) => r.health)).toEqual(["unknown"]);
    });

    it("a 503 with status degraded is degraded, not down", async () => {
      await resetApps();
      await sql`update app set status = 'building' where n = 17`;
      stubFetch(async (u) =>
        u.hostname === "raw.githubusercontent.com"
          ? new Response("apps: []")
          : Response.json({ status: "degraded", version: "sha-1234567" }, { status: 503 }),
      );
      await post();
      const [row] = await sql`select status, health from app where n = 17`;
      expect([row.status, row.health]).toEqual(["building", "degraded"]);
    });

    it("a public sslip.io name is allowed", async () => {
      await resetApps();
      await sql`update app set status = 'building', health_url = 'https://8-8-8-8.sslip.io/api/health' where n = 13`;
      await park();
      const fetched = stubFetch(async (u) => (u.hostname === "raw.githubusercontent.com" ? new Response("apps: []") : healthy("v2")));
      const body = await (await post()).json();
      expect(body.health).toMatchObject({ checked: 1, ok: 1 });
      expect(fetched.some((f) => f.includes("8-8-8-8.sslip.io"))).toBe(true);
      expect((await sql`select status from app where n = 13`)[0].status).toBe("live");
    });

    // A healthy answer that names the catalog app, as a real deployment's /api/health does.
    const named = async (n: number, version = "sha-9f8e7d6") => {
      const [row] = await sql`select name from app where n = ${n}`;
      return json({ status: "ok", version, app: row.name });
    };
    const appNumber = (u: URL) => Number(/^app(\d+)\./.exec(u.hostname)?.[1]);

    it("moves a planned app with a healthy real version to live in two system transitions, and leaves others alone", async () => {
      await resetApps();
      await sql`delete from status_transition where app_n between 1 and 30`;
      await sql`delete from app_event where source = 'health'`;
      await sql`update app set status = 'blocked', blocked_from = 'planned' where n = 21`;
      await sql`update app set status = 'shipped' where n = 25`;
      await sql`update app set status = 'live' where n = 26`;
      await park();
      await sql`update app set health_url = null where n in (18, 19, 20, 27)`;
      stubFetch(async (u) => {
        if (u.hostname === "raw.githubusercontent.com") return new Response("apps: []");
        const n = appNumber(u);
        if (n === 19) return named(19, "dev");
        if (n === 20) return json({ status: "down" }, 500);
        if (n === 27) return json({ status: "ok", version: "sha-1111111", app: "30-apps-template" }); // not this app
        return named(n);
      });
      await post();
      const [eighteen] = await sql`select status, health from app where n = 18`;
      expect([eighteen.status, eighteen.health]).toEqual(["live", "ok"]);
      const moves = await sql`select from_status, to_status, actor_id, reason from status_transition where app_n = 18 order by created_at, to_status`;
      expect(moves).toHaveLength(2);
      expect(moves.map((m) => `${m.from_status}>${m.to_status}`).sort()).toEqual(["building>live", "planned>building"]);
      expect(moves.every((m) => m.actor_id === null)).toBe(true); // system actor
      expect(moves.every((m) => String(m.reason).startsWith("Deployed: health check ok") || String(m.reason).startsWith("Verified live: health check ok"))).toBe(true);
      expect(moves.some((m) => String(m.reason).includes("sha-9f8e7d6"))).toBe(true);
      // version "dev", a failing endpoint and a different app's identity leave a planned app planned and unrecorded.
      const others = await sql`select n, status, health from app where n in (19, 20, 27) order by n`;
      expect(others.map((r) => [r.status, r.health])).toEqual([["planned", "unknown"], ["planned", "unknown"], ["planned", "unknown"]]);
      // A healthy blocked, shipped or live app is not moved by sync.
      const rest = await sql`select n, status from app where n in (21, 25, 26) order by n`;
      expect(rest.map((r) => r.status)).toEqual(["blocked", "shipped", "live"]);
      expect(await sql`select 1 from status_transition where app_n in (19, 20, 21, 25, 26, 27)`).toHaveLength(0);
    });

    it("a planned app that answers without being deployed is skipped as not_deployed, never recorded as down", async () => {
      await resetApps();
      await sql`delete from app_event where source = 'health'`;
      await sql`update app set health_url = 'https://8-8-8-8.sslip.io/api/health' where n = 23`; // 500
      await sql`update app set health_url = 'https://8-8-4-4.sslip.io/api/health' where n = 22`; // 404
      await sql`update app set health_url = 'https://1-1-1-1.sslip.io/api/health' where n = 28`; // 200 HTML parked page
      await park(); // no DNS record: skipped as dns_not_found
      stubFetch(async (u) => {
        if (u.hostname === "raw.githubusercontent.com") return new Response("apps: []");
        if (u.hostname.startsWith("8-8-8-8")) return json({ status: "down" }, 500);
        if (u.hostname.startsWith("8-8-4-4")) return new Response("Not found", { status: 404 });
        return new Response("<html>Domain parked</html>", { status: 200, headers: { "content-type": "text/html" } });
      });
      const body = await (await post()).json();
      expect(body.health).toMatchObject({ checked: 0, ok: 0, down: 0, skipped: 30 });
      const rows = await sql`select n, status, health, health_ms, health_version from app where n in (22, 23, 28) order by n`;
      for (const r of rows) {
        expect([r.status, r.health, r.health_ms, r.health_version]).toEqual(["planned", "unknown", null, null]);
      }
      expect(await sql`select 1 from app_event where source = 'health' and app_n between 1 and 30`).toHaveLength(0);
    });

    it("a status that changed mid-poll (race) is a conflict and is ignored, not an error", async () => {
      await resetApps();
      await sql`delete from status_transition where app_n between 1 and 30`;
      await park();
      await sql`update app set health_url = null where n = 24`;
      // While the health request is in flight, the app is moved to blocked.
      stubFetch(async (u) => {
        if (u.hostname === "raw.githubusercontent.com") return new Response("apps: []");
        await sql`update app set status = 'blocked', blocked_from = 'planned' where n = 24`;
        return named(24, "sha-aaaaaaa");
      });
      const res = await post();
      expect(res.status).toBe(200);
      const [row] = await sql`select status from app where n = 24`;
      expect(row.status).toBe("blocked");
      expect(await sql`select 1 from status_transition where app_n = 24`).toHaveLength(0);
    });

    it("a planned app that is already building by the time of the transition still goes live", async () => {
      await resetApps();
      await sql`delete from status_transition where app_n between 1 and 30`;
      await park();
      await sql`update app set health_url = null where n = 29`;
      stubFetch(async (u) => {
        if (u.hostname === "raw.githubusercontent.com") return new Response("apps: []");
        await sql`update app set status = 'building' where n = 29`; // e.g. the webhook won the race
        return named(29, "sha-bbbbbbb");
      });
      await post();
      const [row] = await sql`select status from app where n = 29`;
      expect(row.status).toBe("live");
    });

    it("a hanging health endpoint is retried, then times out as down within the budget", async () => {
      await resetApps();
      // A failure was already seen a minute ago, so this one is the confirmation and records down.
      await sql`update app set status = 'building', health_failing_since = now() - interval '1 minute' where n = 14`;
      await park();
      let healthCalls = 0;
      vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
        if (new URL(String(input)).hostname === "raw.githubusercontent.com") return Promise.resolve(new Response("apps: []"));
        healthCalls++;
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      });
      const started = Date.now();
      const body = await (await post()).json();
      // 6 s first attempt + 0.5 s backoff + 13 s retry = 19.5 s, under the 21 s sync deadline.
      expect(healthCalls).toBe(2);
      expect(Date.now() - started).toBeLessThan(21_000);
      expect(body.health).toMatchObject({ checked: 1, down: 1, unconfirmed: 0 });
    }, 25_000);
  });
});
