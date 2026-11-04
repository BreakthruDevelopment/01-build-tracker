/**
 * Runs against a real Postgres when TEST_DATABASE_URL is set (CI provides one).
 * Proves the migrations build the tracker schema, seed the catalog, and that
 * user deletion behaves as designed.
 */
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("tracker schema (Postgres)", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(url!, { max: 1 });
    await sql`delete from "user" where id like 'sc-%'`;
    for (const id of ["sc-admin", "sc-other"]) {
      await sql`insert into "user" (id, name, email, role) values (${id}, ${id}, ${id + "@test.local"}, 'admin')`;
    }
  });

  afterAll(async () => {
    await sql`delete from note where body like 'sc-%'`;
    await sql`delete from status_transition where reason like 'sc-%'`;
    await sql`delete from "user" where id like 'sc-%'`;
    await sql.end();
  });

  it("seeds the 30 catalog apps as planned, numbered 1 to 30", async () => {
    const rows = await sql`select n, repo, status, live_cloud, subdomain from app order by n`;
    expect(rows).toHaveLength(30);
    expect(rows.map((r) => r.n)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(rows.every((r) => r.status === "planned")).toBe(true);
    expect(new Set(rows.map((r) => r.repo)).size).toBe(30);
    expect(rows[0]).toMatchObject({ repo: "01-build-tracker", live_cloud: "aws", subdomain: "app1.breakthruventures.ai" });
  });

  it("makes the seed idempotent and never overwrites existing rows", async () => {
    await sql`update app set status = 'building' where n = 2`;
    try {
      await sql.unsafe(await readFile("./drizzle/0002_seed-catalog.sql", "utf8"));
      const [row] = await sql`select count(*)::int as c, max(status::text) filter (where n = 2) as s from app`;
      expect(row).toMatchObject({ c: 30, s: "building" });
    } finally {
      await sql`update app set status = 'planned' where n = 2`;
    }
  });

  it("rejects a duplicate repo and an app number outside 1 to 30", async () => {
    await expect(
      sql`insert into app (n, repo, name, subdomain, live_cloud) values (31, 'x', 'x', 'x', 'aws')`,
    ).rejects.toThrow();
    await expect(
      sql`insert into app (n, repo, name, subdomain, live_cloud) values (5, '01-build-tracker', 'x', 'x', 'aws')`,
    ).rejects.toThrow();
  });

  it("dedupes webhook deliveries on delivery_id", async () => {
    await sql`insert into app_event (app_n, source, kind, delivery_id, title) values (1, 'github', 'push', 'sc-delivery-1', 'sc push')`;
    await expect(
      sql`insert into app_event (app_n, source, kind, delivery_id, title) values (1, 'github', 'push', 'sc-delivery-1', 'sc push again')`,
    ).rejects.toThrow();
    await sql`delete from app_event where delivery_id = 'sc-delivery-1'`;
  });

  it("allows one health summary per app per day", async () => {
    await sql`insert into health_summary (app_n, day, health, summary) values (1, '2099-01-01', 'green', 'sc')`;
    await expect(
      sql`insert into health_summary (app_n, day, health, summary) values (1, '2099-01-01', 'red', 'sc2')`,
    ).rejects.toThrow();
    await sql`delete from health_summary where day = '2099-01-01'`;
  });

  it("nulls the actor on status history but deletes notes when their author is deleted", async () => {
    await sql`insert into status_transition (app_n, from_status, to_status, reason, actor_id) values (1, 'planned', 'building', 'sc-reason', 'sc-admin')`;
    await sql`insert into note (app_n, author_id, body) values (1, 'sc-admin', 'sc-private')`;
    await sql`insert into note (app_n, author_id, body) values (1, 'sc-other', 'sc-keep')`;

    await sql`delete from "user" where id = 'sc-admin'`;

    const [history] = await sql`select actor_id from status_transition where reason = 'sc-reason'`;
    expect(history.actor_id).toBeNull();
    const notes = await sql`select body from note where body like 'sc-%'`;
    expect(notes.map((n) => n.body)).toEqual(["sc-keep"]);
  });
});
