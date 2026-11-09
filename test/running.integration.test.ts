/**
 * Up / Down (running state) against a real Postgres (TEST_DATABASE_URL): defaults by cloud, admin override and
 * its event history, access rules, sync never contacting Down apps, planned Azure promotion, admin Check now,
 * and switching Up resetting the failure stamp and the 60-minute backstop. Fetch and DNS are stubbed.
 */
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("running state (Postgres)", () => {
  let sql: postgres.Sql;
  let t: typeof import("@/lib/tracker");
  let sync: typeof import("@/lib/sync");
  let boardRoute: typeof import("@/app/api/board/route");
  let summaries: typeof import("@/lib/health-summary");
  const admin = { id: "rn-admin", role: "admin" as const };
  const plainUser = { id: "rn-user", role: "user" as const };
  // 6, 14 and 10 are Azure apps; 3 is on Google Cloud (any non-Azure app would do). Other files use other numbers or reset after themselves.
  const AZ = 6;
  const AZ_PLANNED = 14;
  const AZ_BUILDING = 10;
  const AWS = 3;
  const mine = [AZ, AZ_PLANNED, AZ_BUILDING, AWS];

  const lookup = async () => [{ address: "93.184.216.34" }];
  const sleep = async () => undefined;
  const healthy = (app = "x") => vi.fn<typeof fetch>(async () => Response.json({ status: "ok", version: "sha-abc1234", app }));
  const failing = () =>
    vi.fn<typeof fetch>(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
  const deps = (f: typeof fetch) => ({ fetch: f, lookup, sleep });
  const poll = (f: typeof fetch, ns: number[] = mine) => sync.pollApps(new AbortController().signal, deps(f), ns);
  const row = async (n: number) => (await sql`select * from app where n = ${n}`)[0];
  const events = (n: number, kind: string) => sql`select title, source from app_event where app_n = ${n} and kind = ${kind} order by occurred_at`;

  async function reset() {
    await sql`delete from app_event where app_n in ${sql(mine)}`;
    await sql`delete from status_transition where app_n in ${sql(mine)}`;
    await sql`delete from health_summary`;
    await sql`update app set status = 'planned', blocked_from = null, health = 'unknown', health_version = null, health_ms = null,
      health_at = null, health_failing_since = null, health_url = null, running_override = null, running_changed_at = null,
      running_changed_by = null, running_reason = null, manual_check_at = null where n in ${sql(mine)}`;
  }
  /** A live app whose last stored check was a while ago and healthy. */
  const live = (n: number, hoursAgo = 3) =>
    sql`update app set status = 'live', health = 'ok', health_version = 'v1', health_ms = 50,
      health_at = now() - ${hoursAgo} * interval '1 hour' where n = ${n}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.AI_PROVIDER = "demo";
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'rn-%'`;
    for (const u of [admin, plainUser]) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@running-test.local"}, ${u.role})`;
    }
    (await import("@/lib/env")).resetEnvCache();
    t = await import("@/lib/tracker");
    sync = await import("@/lib/sync");
    boardRoute = await import("@/app/api/board/route");
    summaries = await import("@/lib/health-summary");
  });
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await sql`delete from "user" where id like 'rn-%'`;
    await sql.end();
  });

  describe("default and override", () => {
    it("defaults by the catalog cloud: Azure is Down, the rest are Up", async () => {
      const board = await t.listBoard();
      const by = (n: number) => board.find((a) => a.n === n)!;
      expect(by(AZ)).toMatchObject({ liveCloud: "azure", running: "down", runningOverridden: false });
      expect(by(AWS)).toMatchObject({ liveCloud: "gcp", running: "up", runningOverridden: false, parked: false });
    });

    it("parks a live Azure app but not a planned one", async () => {
      await live(AZ);
      const board = await t.listBoard();
      expect(board.find((a) => a.n === AZ)!.parked).toBe(true);
      expect(board.find((a) => a.n === AZ_PLANNED)).toMatchObject({ running: "down", parked: false });
    });

    it("an admin override beats the default both ways, and the effective state follows", async () => {
      await live(AZ);
      await live(AWS);
      expect(await t.setRunning(admin, AZ, { to: "up", reason: "demo day" })).toMatchObject({ running: "up", override: "up", changed: true });
      expect(await t.setRunning(admin, AWS, { to: "down" })).toMatchObject({ running: "down", override: "down", changed: true });
      const board = await t.listBoard();
      expect(board.find((a) => a.n === AZ)).toMatchObject({ running: "up", runningOverridden: true, parked: false });
      expect(board.find((a) => a.n === AWS)).toMatchObject({ running: "down", runningOverridden: true, parked: true });
      // "default" removes the override.
      expect(await t.setRunning(admin, AZ, { to: "default" })).toMatchObject({ running: "down", override: null, changed: true });
      expect((await t.getApp(AZ)).running).toBe("down");
    });

    it("records each change in the event history, with the reason, and nothing for a no-op", async () => {
      await t.setRunning(admin, AZ, { to: "up", reason: "demo day" });
      await t.setRunning(admin, AZ, { to: "up", reason: "again" });
      await t.setRunning(admin, AZ, { to: "default" });
      const rows = await events(AZ, "running_change");
      expect(rows.map((r) => r.title)).toEqual(["Running Down → Up (admin override): demo day", "Running Up → Down (back to default)"]);
      expect(rows.every((r) => r.source === "admin")).toBe(true);
      const detail = await t.getApp(AZ);
      expect(detail.events.some((e) => e.kind === "running_change")).toBe(true);
    });

    it("keeps the actor, reason and times out of the public board and app JSON", async () => {
      await t.setRunning(admin, AZ, { to: "up", reason: "private-ish reason" });
      const board = await (await boardRoute.GET()).json();
      const json = JSON.stringify(board);
      const entry = board.apps.find((a: { n: number }) => a.n === AZ);
      expect(entry).toMatchObject({ running: "up", runningOverridden: true, parked: false });
      for (const key of ["runningOverride", "runningChangedBy", "runningChangedAt", "runningReason", "running_changed_by"]) {
        expect(entry).not.toHaveProperty(key);
      }
      expect(json).not.toContain("rn-admin");
      expect(JSON.stringify(await t.getApp(AZ))).not.toContain("rn-admin");
      // Admins can read the reason.
      expect(await t.getAdminView(admin, AZ)).toMatchObject({ runningOverride: "up", runningReason: "private-ish reason" });
      expect((await row(AZ)).running_changed_by).toBe("rn-admin");
    });
  });

  describe("access rules", () => {
    it("a plain user gets 403 on setRunning and checkNow, and nothing changes", async () => {
      await expect(t.setRunning(plainUser, AZ, { to: "up" })).rejects.toMatchObject({ status: 403 });
      await expect(sync.checkNow(plainUser, AZ, deps(healthy()))).rejects.toMatchObject({ status: 403 });
      expect((await row(AZ)).running_override).toBeNull();
      expect((await row(AZ)).manual_check_at).toBeNull();
    });

    it("an admin is allowed, and bad input or an unknown app is refused", async () => {
      await expect(t.setRunning(admin, AZ, { to: "up" })).resolves.toMatchObject({ changed: true });
      await expect(t.setRunning(admin, AZ, { to: "sideways" })).rejects.toThrow();
      await expect(t.setRunning(admin, AZ, { to: "up", reason: "x".repeat(201) })).rejects.toThrow();
      await expect(t.setRunning(admin, 999, { to: "up" })).rejects.toMatchObject({ status: 404 });
      await expect(sync.checkNow(admin, 999, deps(healthy()))).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("sync", () => {
    it("never contacts a Down app: no fetch, no DNS lookup, stored health untouched, counted as parked", async () => {
      await live(AZ);
      await live(AWS);
      await sql`update app set health_url = 'https://parked-az.breakthruventures.ai/api/health' where n = ${AZ}`;
      await sql`update app set health_url = 'https://up-aws.breakthruventures.ai/api/health' where n = ${AWS}`;
      const f = healthy();
      const lookups: string[] = [];
      const summary = await sync.pollApps(
        new AbortController().signal,
        { fetch: f, sleep, lookup: async (h) => (lookups.push(h), lookup()) },
        [AZ, AWS],
      );
      expect(f).toHaveBeenCalledTimes(1);
      expect(String(f.mock.calls[0][0])).toContain("up-aws");
      expect(lookups).toEqual(["up-aws.breakthruventures.ai"]);
      expect(summary).toEqual({ checked: 1, ok: 1, down: 0, unconfirmed: 0, skipped: 0, parked: 1 });
      const r = await row(AZ);
      expect([r.health, r.health_version, r.health_ms]).toEqual(["ok", "v1", 50]);
      expect(await events(AZ, "health_change")).toHaveLength(0);
    });

    it("an explicit Down on a non-Azure app is parked too, and counts once", async () => {
      await live(AWS);
      await t.setRunning(admin, AWS, { to: "down" });
      const f = healthy();
      expect(await poll(f, [AWS])).toMatchObject({ checked: 0, ok: 0, down: 0, unconfirmed: 0, skipped: 0, parked: 1 });
      expect(f).not.toHaveBeenCalled();
    });

    it("a failing Down app is never counted down or unconfirmed (and is never stamped)", async () => {
      await live(AZ);
      const f = failing();
      expect(await poll(f, [AZ])).toMatchObject({ down: 0, unconfirmed: 0, parked: 1 });
      expect(f).not.toHaveBeenCalled();
      expect((await row(AZ)).health_failing_since).toBeNull();
    });

    it("a planned Azure app is still checked and promoted to live, and then defaults to Down and is skipped", async () => {
      const f = healthy("14-real-estate");
      const first = await poll(f, [AZ_PLANNED]);
      expect(f).toHaveBeenCalledTimes(1);
      expect(first).toMatchObject({ checked: 1, ok: 1, parked: 0 });
      expect((await row(AZ_PLANNED)).status).toBe("live");
      expect((await t.getApp(AZ_PLANNED))).toMatchObject({ running: "down", parked: true });
      const second = await poll(f, [AZ_PLANNED]);
      expect(f).toHaveBeenCalledTimes(1); // no new request
      expect(second).toMatchObject({ checked: 0, parked: 1 });
    });

    it("a building Azure app (Down only by default) is still checked so it can be verified live", async () => {
      await sql`update app set status = 'building' where n = ${AZ_BUILDING}`;
      const f = healthy("10-inventory");
      expect(await poll(f, [AZ_BUILDING])).toMatchObject({ checked: 1, parked: 0 });
      expect(f).toHaveBeenCalledTimes(1);
      expect((await row(AZ_BUILDING)).status).toBe("live");
    });

    it("switching Up clears the failure stamp and the first check is a normal first check, not a backstop confirm", async () => {
      await live(AZ, 3); // last record 3 hours ago: over the 60-minute backstop
      await sql`update app set health_failing_since = now() - interval '2 minutes' where n = ${AZ}`;
      await t.setRunning(admin, AZ, { to: "up", reason: "needed" });
      const after = await row(AZ);
      expect(after.health_failing_since).toBeNull();
      expect(after.running_changed_at).toBeInstanceOf(Date);
      const summary = await poll(failing(), [AZ]);
      expect(summary).toMatchObject({ checked: 1, down: 0, unconfirmed: 1, parked: 0 });
      const r = await row(AZ);
      expect(r.health).toBe("ok");
      expect(r.health_failing_since).toBeInstanceOf(Date);
      expect(await events(AZ, "health_change")).toHaveLength(0);
    });

    it("an app that was Up all along still hits the backstop after 60 minutes (unchanged behaviour)", async () => {
      await live(AWS, 3);
      expect(await poll(failing(), [AWS])).toMatchObject({ down: 1, unconfirmed: 0 });
    });
  });

  describe("Check now", () => {
    it("checks a Down app (waking it), records the result, reports it, and leaves it parked", async () => {
      await live(AZ, 3);
      await sql`update app set health_url = 'https://az-now.breakthruventures.ai/api/health' where n = ${AZ}`;
      const f = healthy();
      const result = await sync.checkNow(admin, AZ, deps(f));
      expect(f).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ outcome: "ok", parked: true });
      expect(result.message).toMatch(/^Up and healthy\./);
      const r = await row(AZ);
      expect(r.health_version).toBe("sha-abc1234");
      expect(Date.now() - r.health_at.getTime()).toBeLessThan(60_000);
      expect(r.running_override).toBeNull();
      expect((await t.getApp(AZ)).parked).toBe(true);
    });

    it("an unconfirmed failure says it may be waking and records nothing yet, even past the old backstop", async () => {
      await live(AZ, 5);
      const result = await sync.checkNow(admin, AZ, deps(failing()));
      expect(result.outcome).toBe("unconfirmed");
      expect(result.message).toBe("Didn't answer yet — it may be waking; try again in a minute.");
      const r = await row(AZ);
      expect(r.health).toBe("ok");
      expect(r.health_failing_since).toBeInstanceOf(Date);
      expect(await events(AZ, "health_change")).toHaveLength(0);
    });

    it("a second failure a minute later confirms down through the same path", async () => {
      await live(AZ, 5);
      await sync.checkNow(admin, AZ, deps(failing()));
      await sql`update app set health_failing_since = now() - interval '70 seconds', manual_check_at = now() - interval '31 seconds' where n = ${AZ}`;
      const result = await sync.checkNow(admin, AZ, deps(failing()));
      expect(result).toMatchObject({ outcome: "down", message: "Still not answering. Recorded as down." });
      expect((await row(AZ)).health).toBe("down");
      expect(await events(AZ, "health_change")).toHaveLength(1);
    });

    it("works for an app that is Up as well, and a success clears the stamp", async () => {
      await live(AWS, 0);
      await sql`update app set health_failing_since = now() - interval '2 minutes' where n = ${AWS}`;
      const result = await sync.checkNow(admin, AWS, deps(healthy()));
      expect(result).toMatchObject({ outcome: "ok", parked: false, message: "Up and healthy." });
      expect((await row(AWS)).health_failing_since).toBeNull();
    });

    it("is limited to once per 30 seconds per app, and other apps are unaffected", async () => {
      await live(AZ);
      await live(AWS);
      const f = healthy();
      await sync.checkNow(admin, AZ, deps(f));
      await expect(sync.checkNow(admin, AZ, deps(f))).rejects.toMatchObject({ status: 429 });
      expect(f).toHaveBeenCalledTimes(1);
      await expect(sync.checkNow(admin, AWS, deps(f))).resolves.toMatchObject({ outcome: "ok" });
      await sql`update app set manual_check_at = now() - interval '31 seconds' where n = ${AZ}`;
      await expect(sync.checkNow(admin, AZ, deps(f))).resolves.toMatchObject({ outcome: "ok" });
    });

    it("two simultaneous clicks make one request", async () => {
      await live(AZ);
      const f = healthy();
      const settled = await Promise.allSettled([sync.checkNow(admin, AZ, deps(f)), sync.checkNow(admin, AZ, deps(f))]);
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      expect(f).toHaveBeenCalledTimes(1);
    });

    it("names a skipped check instead of reporting a result", async () => {
      await live(AZ);
      await sql`update app set health_url = 'https://evil.example.com/api/health' where n = ${AZ}`;
      const f = healthy();
      const result = await sync.checkNow(admin, AZ, deps(f));
      expect(f).not.toHaveBeenCalled();
      expect(result).toMatchObject({ outcome: "skipped", message: "Not checked: the health URL isn't allowed." });
    });
  });

  describe("daily summaries", () => {
    it("treat a parked app as parked: no down flag, not unknown, even with an old stored down", async () => {
      await sql`update app set status = 'live', health = 'down', health_at = now() - interval '2 days' where n = ${AZ}`;
      await sql`update app set status = 'live', health = 'ok', health_at = now(), last_push_at = now() where n = ${AWS}`;
      await summaries.runDailySummaries("system");
      const [s] = await sql`select health, summary, flags from health_summary where app_n = ${AZ} and day = ${new Date().toISOString().slice(0, 10)}`;
      expect(s.health).toBe("green");
      expect(s.flags.filter((f: { kind: string }) => f.kind === "down")).toEqual([]);
    });
  });
});
