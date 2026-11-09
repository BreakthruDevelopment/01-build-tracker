/**
 * Runs against a real Postgres when TEST_DATABASE_URL is set (CI provides one).
 * "Confirm before Down": a first failed check is unconfirmed; only a later one 1 to 4 minutes after the first records down.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("sync confirm before down (Postgres)", () => {
  let sql: postgres.Sql;
  let pollApps: typeof import("@/lib/sync").pollApps;
  // Apps 21..24 and 19 are used here; other test files use other numbers.
  const N = { live: 21, shipped: 22, down: 23, degraded: 24, planned: 19 };
  const all = Object.values(N);
  const lookup = async () => [{ address: "93.184.216.34" }];
  const sleep = async () => undefined;
  const hostFor = (n: number) => `https://confirm-${n}.breakthruventures.ai/api/health`;

  const failing = (async () => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  }) as typeof fetch;
  const healthy = (async () =>
    new Response(JSON.stringify({ status: "ok", version: "abc123", app: "x" }), { status: 200 })) as typeof fetch;
  const degraded = (async () =>
    new Response(JSON.stringify({ status: "degraded", version: "abc123" }), { status: 503 })) as typeof fetch;

  const poll = (f: typeof fetch, ns: number[] = all) =>
    pollApps(new AbortController().signal, { fetch: f, lookup, sleep }, ns);

  async function row(n: number) {
    const [r] = await sql`select health, health_version, health_ms, health_at, health_failing_since, status from app where n = ${n}`;
    return r;
  }
  /** Pretend the stamp was made `seconds` ago. */
  const age = (n: number, seconds: number) =>
    sql`update app set health_failing_since = now() - ${seconds} * interval '1 second' where n = ${n}`;
  const events = async (n: number) =>
    (await sql`select title from app_event where app_n = ${n} and source = 'health'`).length;

  async function reset() {
    await sql`delete from app_event where app_n in ${sql(all)}`;
    await sql`delete from status_transition where app_n in ${sql(all)}`;
    for (const n of all) {
      const status = n === N.planned ? "planned" : n === N.shipped ? "shipped" : "live";
      const health = n === N.down ? "down" : n === N.degraded ? "degraded" : "ok";
      await sql`update app set status = ${status}, blocked_from = null, health = ${health}, health_version = 'v1',
        health_ms = 50, health_at = null, health_failing_since = null, health_url = ${hostFor(n)} where n = ${n}`;
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1 });
    ({ pollApps } = await import("@/lib/sync"));
  });
  afterAll(async () => {
    // Back to the seeded state: other files assume every app is planned.
    await sql`delete from app_event where app_n in ${sql(all)}`;
    await sql`delete from status_transition where app_n in ${sql(all)}`;
    await sql`update app set status = 'planned', health = 'unknown', health_version = null, health_ms = null,
      health_at = null, health_failing_since = null, health_url = null where n in ${sql(all)}`;
    await sql.end();
  });

  it("first failure is unconfirmed: stamped, health unchanged, no event", async () => {
    await reset();
    const s = await poll(failing, [N.live, N.shipped]);
    expect(s).toMatchObject({ checked: 2, ok: 0, down: 0, unconfirmed: 2, skipped: 0 });
    for (const n of [N.live, N.shipped]) {
      const r = await row(n);
      expect(r).toMatchObject({ health: "ok", health_version: "v1", health_ms: 50, health_at: null });
      expect(r.health_failing_since).toBeInstanceOf(Date);
      expect(await events(n)).toBe(0);
    }
  });

  it("a second failure between 1 and 4 minutes after the first records down and the event", async () => {
    await reset();
    await poll(failing, [N.live]);
    await age(N.live, 120);
    const stamp = (await row(N.live)).health_failing_since;
    const s = await poll(failing, [N.live]);
    expect(s).toMatchObject({ checked: 1, down: 1, unconfirmed: 0 });
    const r = await row(N.live);
    expect(r.health).toBe("down");
    expect(r.health_at).toBeInstanceOf(Date);
    expect(r.health_failing_since).toEqual(stamp);
    expect(await events(N.live)).toBe(1);
  });

  it("a failure after the maximum age is unconfirmed again and restamps", async () => {
    await reset();
    await age(N.live, 5 * 60);
    const s = await poll(failing, [N.live]);
    expect(s).toMatchObject({ down: 0, unconfirmed: 1 });
    const r = await row(N.live);
    expect(r.health).toBe("ok");
    expect(Date.now() - r.health_failing_since.getTime()).toBeLessThan(60_000);
    expect(await events(N.live)).toBe(0);
  });

  it("a success clears the stamp, so the next failure is a first failure again", async () => {
    await reset();
    await poll(failing, [N.live]);
    await poll(healthy, [N.live]);
    expect((await row(N.live)).health_failing_since).toBeNull();
    const s = await poll(failing, [N.live]);
    expect(s.unconfirmed).toBe(1);
    expect((await row(N.live)).health).toBe("ok");
  });

  it("an app that is already down records failures immediately, with no stamp needed", async () => {
    await reset();
    const s = await poll(failing, [N.down]);
    expect(s).toMatchObject({ checked: 1, down: 1, unconfirmed: 0 });
    expect(await events(N.down)).toBe(0); // down -> down is not a change
    expect((await row(N.down)).health_at).toBeInstanceOf(Date);
    expect((await row(N.down)).health_failing_since).toBeNull();
  });

  it("degraded answers are recorded immediately, not confirmed", async () => {
    await reset();
    const s = await poll(degraded, [N.live]);
    expect(s).toMatchObject({ checked: 1, unconfirmed: 0 });
    expect((await row(N.live)).health).toBe("degraded");
    expect(await events(N.live)).toBe(1);
  });

  it("planned apps are unaffected: a failing planned app is skipped and never stamped", async () => {
    await reset();
    const s = await poll(failing, [N.planned]);
    expect(s).toMatchObject({ checked: 0, down: 0, unconfirmed: 0, skipped: 1 });
    const r = await row(N.planned);
    expect(r).toMatchObject({ status: "planned", health: "ok", health_failing_since: null });
    expect(await events(N.planned)).toBe(0);
  });

  it("two overlapping syncs are both unconfirmed: the app had no time to wake", async () => {
    await reset();
    const [a, b] = await Promise.all([poll(failing, [N.live]), poll(failing, [N.live])]);
    expect(a.unconfirmed + b.unconfirmed).toBe(2);
    expect(a.down + b.down).toBe(0);
    expect(await events(N.live)).toBe(0);
    expect((await row(N.live)).health).toBe("ok");
  });

  it("a failure under 60 s after the first is unconfirmed and does not restamp; just over 60 s confirms", async () => {
    await reset();
    await age(N.live, 50);
    const before = (await row(N.live)).health_failing_since;
    expect(await poll(failing, [N.live])).toMatchObject({ unconfirmed: 1, down: 0 });
    expect((await row(N.live)).health_failing_since).toEqual(before);
    await age(N.live, 70);
    expect(await poll(failing, [N.live])).toMatchObject({ unconfirmed: 0, down: 1 });
  });

  it("just under 4 minutes confirms; just over restamps and is unconfirmed", async () => {
    await reset();
    await age(N.live, 4 * 60 - 10);
    expect(await poll(failing, [N.live])).toMatchObject({ unconfirmed: 0, down: 1 });
    await reset();
    await age(N.live, 4 * 60 + 10);
    expect(await poll(failing, [N.live])).toMatchObject({ unconfirmed: 1, down: 0 });
    expect((await row(N.live)).health).toBe("ok");
  });

  it("a degraded answer followed by a failure is unconfirmed", async () => {
    await reset();
    await poll(degraded, [N.live]);
    expect((await row(N.live)).health_failing_since).toBeNull();
    expect(await poll(failing, [N.live])).toMatchObject({ unconfirmed: 1, down: 0 });
    expect((await row(N.live)).health).toBe("degraded");
  });

  it("backstop: an app not recorded for over 60 minutes goes down on its first failure", async () => {
    await reset();
    await sql`update app set health_at = now() - interval '61 minutes' where n = ${N.live}`;
    expect(await poll(failing, [N.live])).toMatchObject({ unconfirmed: 0, down: 1 });
    expect((await row(N.live)).health).toBe("down");
    await reset();
    await sql`update app set health_at = now() - interval '59 minutes' where n = ${N.live}`;
    expect(await poll(failing, [N.live])).toMatchObject({ unconfirmed: 1, down: 0 });
  });

  it("two syncs that both confirm write one health_change event", async () => {
    await reset();
    await age(N.live, 120);
    const [a, b] = await Promise.all([poll(failing, [N.live]), poll(failing, [N.live])]);
    expect(a.down + b.down).toBe(2);
    expect(await events(N.live)).toBe(1);
    expect((await row(N.live)).health).toBe("down");
  });
});
