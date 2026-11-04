/**
 * Runs against a real Postgres when TEST_DATABASE_URL is set (CI provides one).
 * Proves the Build Tracker access rules and state machine hold at the data layer.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorInfo } from "@/lib/http";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("tracker data layer (Postgres)", () => {
  let sql: postgres.Sql;
  let t: typeof import("@/lib/tracker");
  const admin = { id: "tr-admin", role: "admin" as const };
  const admin2 = { id: "tr-admin2", role: "admin" as const };
  const plainUser = { id: "tr-user", role: "user" as const };
  // Apps 25..30 are used here so other test files that touch low numbers don't collide.
  const N = { flow: 30, blocked: 29, reason: 28, hurl: 27, notes: 26, sys: 25 };

  async function reset(n: number) {
    await sql`delete from status_transition where app_n = ${n}`;
    await sql`update app set status = 'planned', blocked_from = null, health_url = null where n = ${n}`;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await sql`delete from "user" where id like 'tr-%'`;
    for (const u of [admin, admin2, plainUser]) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@secret-test.local"}, ${u.role})`;
    }
    for (const n of Object.values(N)) await reset(n);
    t = await import("@/lib/tracker");
  });

  afterAll(async () => {
    for (const n of Object.values(N)) {
      await reset(n);
      await sql`delete from note where app_n = ${n}`;
    }
    await sql`delete from "user" where id like 'tr-%'`;
    await sql.end();
  });

  describe("access rules", () => {
    it("a plain user gets 403 on transition, health url and notes", async () => {
      await expect(t.transition(plainUser, N.flow, { to: "building" })).rejects.toMatchObject({ status: 403 });
      await expect(t.setHealthUrl(plainUser, N.flow, null)).rejects.toMatchObject({ status: 403 });
      await expect(t.addNote(plainUser, N.notes, { body: "nope" })).rejects.toMatchObject({ status: 403 });
      await expect(t.getAdminView(plainUser, N.notes)).rejects.toMatchObject({ status: 403 });
      const [row] = await sql`select status from app where n = ${N.flow}`;
      expect(row.status).toBe("planned");
    });

    it("a plain user also gets 403 on deleting a note", async () => {
      const note = await t.addNote(admin, N.notes, { body: "tr-guarded" });
      await expect(t.deleteNote(plainUser, N.notes, note.id)).rejects.toMatchObject({ status: 403 });
      await t.deleteNote(admin, N.notes, note.id);
    });

    it("lets the author delete their note; a second admin gets 403 and the note survives", async () => {
      const note = await t.addNote(admin, N.notes, { body: "tr-mine" });
      await expect(t.deleteNote(admin2, N.notes, note.id)).rejects.toMatchObject({ status: 403 });
      expect(await sql`select id from note where id = ${note.id}`).toHaveLength(1);
      await t.deleteNote(admin, N.notes, note.id);
      expect(await sql`select id from note where id = ${note.id}`).toHaveLength(0);
    });

    it("404s for an unknown note, a note on another app, and unknown apps", async () => {
      const note = await t.addNote(admin, N.notes, { body: "tr-other-app" });
      await expect(t.deleteNote(admin, N.notes, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ status: 404 });
      await expect(t.deleteNote(admin, N.flow, note.id)).rejects.toMatchObject({ status: 404 });
      await expect(t.addNote(admin, 999, { body: "x" })).rejects.toMatchObject({ status: 404 });
      await expect(t.getApp(999)).rejects.toMatchObject({ status: 404 });
      await expect(t.transition(admin, 999, { to: "building" })).rejects.toMatchObject({ status: 404 });
      await expect(t.setHealthUrl(admin, 999, null)).rejects.toMatchObject({ status: 404 });
      await t.deleteNote(admin, N.notes, note.id);
    });

    it("validates input: bad ids and empty or oversized bodies are 400", async () => {
      expect(errorInfo(await t.deleteNote(admin, N.notes, "not-a-uuid").catch((e) => e)).status).toBe(400);
      expect(errorInfo(await t.addNote(admin, N.notes, { body: "   " }).catch((e) => e)).status).toBe(400);
      expect(errorInfo(await t.addNote(admin, N.notes, { body: "x".repeat(2001) }).catch((e) => e)).status).toBe(400);
      expect(errorInfo(await t.getApp("abc").catch((e) => e)).status).toBe(400);
      expect(errorInfo(await t.transition(admin, N.flow, { to: "nonsense" }).catch((e) => e)).status).toBe(400);
    });
  });

  describe("public projections", () => {
    it("never include notes, user emails or user ids", async () => {
      await t.addNote(admin, N.notes, { body: "tr-private-note-text" });
      await t.transition(admin, N.notes, { to: "building" });
      await t.setHealthUrl(admin, N.notes, "https://app26.breakthruventures.ai/api/health");

      const board = await t.listBoard();
      const detail = await t.getApp(N.notes);
      const json = JSON.stringify({ board, detail });

      expect(board).toHaveLength(30);
      expect(json).not.toContain("tr-private-note-text");
      expect(json).not.toContain("secret-test.local");
      expect(json).not.toContain("tr-admin");
      expect(json).not.toContain("healthUrl");
      expect(json).not.toContain("authorId");
      expect(detail).not.toHaveProperty("notes");
      expect(detail.history[0]).toMatchObject({ from: "planned", to: "building", actor: "admin" });
      expect(Object.keys(detail.history[0]).sort()).toEqual(["actor", "at", "from", "id", "reason", "to"]);
    });

    it("shows system as the actor for automatic moves", async () => {
      await reset(N.sys);
      await t.systemTransition(N.sys, "building");
      const detail = await t.getApp(N.sys);
      expect(detail.history[0]).toMatchObject({ from: "planned", to: "building", actor: "system" });
      expect(detail.status).toBe("building");
    });
  });

  describe("state machine through the data layer", () => {
    it("writes a status_transition row and updates status and status_changed_at", async () => {
      await reset(N.flow);
      const [before] = await sql`select status_changed_at from app where n = ${N.flow}`;
      const res = await t.transition(admin, N.flow, { to: "building" });
      expect(res).toMatchObject({ n: N.flow, from: "planned", to: "building" });
      const [app] = await sql`select status, blocked_from, status_changed_at from app where n = ${N.flow}`;
      expect(app.status).toBe("building");
      expect(app.blocked_from).toBeNull();
      expect(new Date(app.status_changed_at).getTime()).toBeGreaterThan(new Date(before.status_changed_at).getTime());
      const rows = await sql`select from_status, to_status, actor_id, reason from status_transition where app_n = ${N.flow}`;
      expect(rows).toEqual([{ from_status: "planned", to_status: "building", actor_id: admin.id, reason: null }]);
    });

    it("walks the happy path to shipped and back with reasons", async () => {
      await t.transition(admin, N.flow, { to: "live" });
      await t.transition(admin, N.flow, { to: "shipped" });
      await expect(t.transition(admin, N.flow, { to: "live" })).rejects.toMatchObject({ status: 400 });
      await t.transition(admin, N.flow, { to: "live", reason: "rollback after incident" });
      const rows = await sql`select from_status, to_status, reason from status_transition where app_n = ${N.flow} order by created_at`;
      expect(rows.map((r) => `${r.from_status}>${r.to_status}`)).toEqual([
        "planned>building",
        "building>live",
        "live>shipped",
        "shipped>live",
      ]);
      expect(rows[3].reason).toBe("rollback after incident");
    });

    it("rejects illegal transitions with 409 and writes nothing", async () => {
      await reset(N.flow);
      const illegal = [
        ["planned", "live"],
        ["planned", "shipped"],
        ["planned", "planned"],
      ] as const;
      for (const [, to] of illegal) {
        const err = await t.transition(admin, N.flow, { to, reason: "because" }).catch((e) => e);
        expect(err).toMatchObject({ status: 409 });
        expect(errorInfo(err).status).toBe(409);
      }
      await t.transition(admin, N.flow, { to: "building" });
      await expect(t.transition(admin, N.flow, { to: "shipped", reason: "x" })).rejects.toMatchObject({ status: 409 });
      await expect(t.transition(admin, N.flow, { to: "planned", reason: "x" })).rejects.toMatchObject({ status: 409 });
      const rows = await sql`select 1 from status_transition where app_n = ${N.flow}`;
      expect(rows).toHaveLength(1);
    });

    it("requires a reason for backward moves and blocking (400), and rejects it before changing anything", async () => {
      await reset(N.reason);
      await t.transition(admin, N.reason, { to: "building" });
      await t.transition(admin, N.reason, { to: "live" });
      for (const reason of [undefined, "", "   "]) {
        const err = await t.transition(admin, N.reason, { to: "building", reason }).catch((e) => e);
        expect(errorInfo(err).status).toBe(400);
      }
      await expect(t.transition(admin, N.reason, { to: "blocked" })).rejects.toMatchObject({ status: 400 });
      expect(errorInfo(await t.transition(admin, N.reason, { to: "blocked", reason: "x".repeat(501) }).catch((e) => e)).status).toBe(400);
      const [app] = await sql`select status from app where n = ${N.reason}`;
      expect(app.status).toBe("live");
      await t.transition(admin, N.reason, { to: "building", reason: "rework needed" });
    });

    it("blocked stores the prior state and restores exactly it", async () => {
      for (const stored of ["planned", "building", "live"] as const) {
        await reset(N.blocked);
        if (stored !== "planned") await t.transition(admin, N.blocked, { to: "building" });
        if (stored === "live") await t.transition(admin, N.blocked, { to: "live" });

        await t.transition(admin, N.blocked, { to: "blocked", reason: "waiting on DNS" });
        const [blocked] = await sql`select status, blocked_from from app where n = ${N.blocked}`;
        expect(blocked).toMatchObject({ status: "blocked", blocked_from: stored });

        // Anything but the stored state is a 409.
        for (const wrong of ["planned", "building", "live", "shipped", "blocked"] as const) {
          if (wrong === stored) continue;
          await expect(t.transition(admin, N.blocked, { to: wrong, reason: "x" })).rejects.toMatchObject({ status: 409 });
        }
        // The system can never leave blocked.
        await expect(t.systemTransition(N.blocked, stored)).rejects.toMatchObject({ status: 409 });

        await t.transition(admin, N.blocked, { to: stored });
        const [restored] = await sql`select status, blocked_from from app where n = ${N.blocked}`;
        expect(restored).toMatchObject({ status: stored, blocked_from: null });
      }
    });

    it("system transitions are forward only", async () => {
      await reset(N.sys);
      await expect(t.systemTransition(N.sys, "live")).rejects.toMatchObject({ status: 409 });
      await t.systemTransition(N.sys, "building");
      await expect(t.systemTransition(N.sys, "building")).rejects.toMatchObject({ status: 409 });
      await t.systemTransition(N.sys, "live", "health ok");
      await expect(t.systemTransition(N.sys, "shipped")).rejects.toMatchObject({ status: 409 });
      await expect(t.systemTransition(N.sys, "building", "rollback")).rejects.toMatchObject({ status: 409 });
      await expect(t.systemTransition(N.sys, "blocked", "nope")).rejects.toMatchObject({ status: 409 });
      const rows = await sql`select actor_id, reason from status_transition where app_n = ${N.sys} order by created_at`;
      expect(rows).toEqual([
        { actor_id: null, reason: null },
        { actor_id: null, reason: "health ok" },
      ]);
    });

    it("serializes concurrent moves: only one of two identical moves wins", async () => {
      await reset(N.flow);
      const results = await Promise.allSettled([
        t.transition(admin, N.flow, { to: "building" }),
        t.transition(admin, N.flow, { to: "building" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(await sql`select 1 from status_transition where app_n = ${N.flow}`).toHaveLength(1);
    });
  });

  describe("health url", () => {
    it("accepts allow-listed https hosts, stores them, and clears with null", async () => {
      const ok = await t.setHealthUrl(admin, N.hurl, "https://app27.breakthruventures.ai/api/health");
      expect(ok.healthUrl).toBe("https://app27.breakthruventures.ai/api/health");
      expect((await t.getAdminView(admin, N.hurl)).healthUrl).toBe(ok.healthUrl);
      expect((await t.setHealthUrl(admin, N.hurl, null)).healthUrl).toBeNull();
    });

    it("rejects http:// and non-allow-listed hosts with 400, leaving the value unchanged", async () => {
      await t.setHealthUrl(admin, N.hurl, "https://app27.breakthruventures.ai/api/health");
      for (const bad of [
        "http://app27.breakthruventures.ai/api/health",
        "https://evil.example.com/api/health",
        "https://evil.com/.breakthruventures.ai",
        "https://169.254.169.254/latest/meta-data",
        "https://user:pw@app27.breakthruventures.ai/",
        "not a url",
      ]) {
        const err = await t.setHealthUrl(admin, N.hurl, bad).catch((e) => e);
        expect(errorInfo(err).status, bad).toBe(400);
      }
      expect((await t.getAdminView(admin, N.hurl)).healthUrl).toBe("https://app27.breakthruventures.ai/api/health");
    });
  });
});
