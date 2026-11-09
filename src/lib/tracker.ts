import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { healthUrlSchema } from "@/lib/health-url";
import { log } from "@/lib/log";
import { effectiveRunning, isParked, type Running } from "@/lib/running";
import { canTransition, requiresReason, STATUSES, type Status } from "@/lib/status";

/**
 * Build Tracker data layer. Writes take the acting user and call assertCan; public reads
 * take no actor and return explicit projection types, so notes and user emails can never
 * reach the public endpoints.
 */

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/** App numbers are 1..30 in the seed; a valid-looking number with no row is a 404, not a 400. */
export const appNumber = z.union([
  z.number().int(),
  z.string().regex(/^\d{1,7}$/, "App number must be digits").transform(Number),
]).pipe(z.number().int().min(1).max(1_000_000));

export const transitionInput = z.object({
  to: z.enum(STATUSES),
  reason: z.string().trim().max(500).optional(),
});

export const noteInput = z.object({ body: z.string().trim().min(1, "Note is empty").max(2000) });

const noteId = z.string().uuid();

// ---------------------------------------------------------------------------
// Public projections
// ---------------------------------------------------------------------------

export type BoardApp = {
  n: number;
  name: string;
  repo: string;
  subdomain: string;
  liveCloud: "aws" | "azure" | "gcp" | "oci";
  status: Status;
  statusChangedAt: Date;
  health: "ok" | "degraded" | "down" | "unknown";
  healthVersion: string | null;
  healthAt: Date | null;
  /** Effective running state: the admin's override if set, otherwise Down for Azure and Up for the rest. */
  running: Running;
  /** True when an admin set it (no actor or reason here: those are admin-only). */
  runningOverridden: boolean;
  /** Down and not checked by sync; `health` is then the last stored result, not a current one. */
  parked: boolean;
  lastPushAt: Date | null;
  ciConclusion: string | null;
  ciWorkflow: string | null;
  ciUrl: string | null;
  ciAt: Date | null;
  /** Today's AI summary line, if one has been generated. */
  summary: string | null;
  summaryHealth: "green" | "amber" | "red" | null;
  summaryDemo: boolean | null;
};

export type PublicTransition = {
  id: string;
  from: Status;
  to: Status;
  reason: string | null;
  /** Never a user id or email: just who kind of actor made the change. */
  actor: "system" | "admin";
  at: Date;
};

export type PublicEvent = {
  id: string;
  source: "github" | "health" | "ops_monitor" | "admin";
  kind: string;
  title: string;
  url: string | null;
  occurredAt: Date;
};

export type AppDetail = BoardApp & {
  blockedFrom: Status | null;
  healthMs: number | null;
  summaryFlags: { kind: string; detail: string }[];
  history: PublicTransition[];
  events: PublicEvent[];
};

/** Admin-only view: the parts of an app that are not public. */
export type AdminAppView = {
  n: number;
  healthUrl: string | null;
  runningOverride: Running | null;
  runningReason: string | null;
  runningChangedAt: Date | null;
  notes: AdminNote[];
};

export type AdminNote = { id: string; appN: number; authorId: string; body: string; createdAt: Date };

const A = schema.app;

const boardColumns = {
  n: A.n,
  name: A.name,
  repo: A.repo,
  subdomain: A.subdomain,
  liveCloud: A.liveCloud,
  status: A.status,
  statusChangedAt: A.statusChangedAt,
  health: A.health,
  healthVersion: A.healthVersion,
  healthAt: A.healthAt,
  runningOverride: A.runningOverride,
  lastPushAt: A.lastPushAt,
  ciConclusion: A.ciConclusion,
  ciWorkflow: A.ciWorkflow,
  ciUrl: A.ciUrl,
  ciAt: A.ciAt,
} as const;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

type SummaryRow = { appN: number; health: "green" | "amber" | "red"; summary: string; flags: { kind: string; detail: string }[]; demo: boolean };

/** Replace the raw override column with the public projection (effective state, no actor or reason). */
function withRunning<T extends { runningOverride: Running | null; liveCloud: BoardApp["liveCloud"]; status: Status }>(row: T) {
  const { runningOverride, ...rest } = row;
  return {
    ...rest,
    running: effectiveRunning(row.liveCloud, runningOverride),
    runningOverridden: runningOverride !== null,
    parked: isParked({ status: row.status, liveCloud: row.liveCloud, runningOverride }),
  };
}

function withSummary<T extends object>(row: T, s: SummaryRow | undefined) {
  return {
    ...row,
    summary: s?.summary ?? null,
    summaryHealth: s?.health ?? null,
    summaryDemo: s?.demo ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

export async function listBoard(): Promise<BoardApp[]> {
  const [apps, summaries] = await Promise.all([
    db().select(boardColumns).from(A).orderBy(asc(A.n)),
    db()
      .select({
        appN: schema.healthSummary.appN,
        health: schema.healthSummary.health,
        summary: schema.healthSummary.summary,
        flags: schema.healthSummary.flags,
        demo: schema.healthSummary.demo,
      })
      .from(schema.healthSummary)
      .where(eq(schema.healthSummary.day, today())),
  ]);
  const byApp = new Map(summaries.map((s) => [s.appN, s]));
  return apps.map((a) => withSummary(withRunning(a), byApp.get(a.n)));
}

export async function getApp(nInput: unknown): Promise<AppDetail> {
  const n = appNumber.parse(nInput);
  const [row] = await db()
    .select({ ...boardColumns, blockedFrom: A.blockedFrom, healthMs: A.healthMs })
    .from(A)
    .where(eq(A.n, n));
  if (!row) throw new NotFoundError("Unknown app");

  const [summary, history, events] = await Promise.all([
    db()
      .select({
        appN: schema.healthSummary.appN,
        health: schema.healthSummary.health,
        summary: schema.healthSummary.summary,
        flags: schema.healthSummary.flags,
        demo: schema.healthSummary.demo,
      })
      .from(schema.healthSummary)
      .where(and(eq(schema.healthSummary.appN, n), eq(schema.healthSummary.day, today())))
      .then((r) => r[0]),
    db()
      .select({
        id: schema.statusTransition.id,
        from: schema.statusTransition.fromStatus,
        to: schema.statusTransition.toStatus,
        reason: schema.statusTransition.reason,
        actorId: schema.statusTransition.actorId,
        at: schema.statusTransition.createdAt,
      })
      .from(schema.statusTransition)
      .where(eq(schema.statusTransition.appN, n))
      .orderBy(desc(schema.statusTransition.createdAt))
      .limit(50),
    db()
      .select({
        id: schema.appEvent.id,
        source: schema.appEvent.source,
        kind: schema.appEvent.kind,
        title: schema.appEvent.title,
        url: schema.appEvent.url,
        occurredAt: schema.appEvent.occurredAt,
      })
      .from(schema.appEvent)
      .where(eq(schema.appEvent.appN, n))
      .orderBy(desc(schema.appEvent.occurredAt))
      .limit(20),
  ]);

  return {
    ...withSummary(withRunning(row), summary),
    summaryFlags: summary?.flags ?? [],
    history: history.map(({ actorId, ...h }) => ({ ...h, actor: actorId ? ("admin" as const) : ("system" as const) })),
    events,
  };
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

type Mover = { kind: "system" } | { kind: "admin"; actor: Actor };

async function applyTransition(mover: Mover, nInput: unknown, input: unknown) {
  const n = appNumber.parse(nInput);
  const { to, reason } = transitionInput.parse(input);
  const who = mover.kind;

  const result = await db().transaction(async (tx) => {
    // Lock the row so two concurrent moves can't both read the same "from".
    const [current] = await tx
      .select({ status: A.status, blockedFrom: A.blockedFrom })
      .from(A)
      .where(eq(A.n, n))
      .for("update");
    if (!current) throw new NotFoundError("Unknown app");

    const from = current.status;
    if (!canTransition(from, to, who, current.blockedFrom)) {
      throw new ConflictError(`Can't move an app from ${from} to ${to}.`);
    }
    if (requiresReason(from, to) && !reason) {
      throw new BadRequestError(`A reason is required to move an app from ${from} to ${to}.`);
    }

    const now = new Date();
    await tx
      .update(A)
      .set({
        status: to,
        blockedFrom: to === "blocked" ? from : null,
        statusChangedAt: now,
      })
      .where(eq(A.n, n));
    const [row] = await tx
      .insert(schema.statusTransition)
      .values({
        appN: n,
        fromStatus: from,
        toStatus: to,
        reason: reason || null,
        actorId: mover.kind === "admin" ? mover.actor.id : null,
        createdAt: now,
      })
      .returning({ id: schema.statusTransition.id });
    return { id: row.id, n, from, to, reason: reason || null, at: now };
  });

  log.info("status.transition", { n, from: result.from, to: result.to, actor: who });
  return result;
}

export type TransitionResult = Awaited<ReturnType<typeof applyTransition>>;

/** Admin moves an app between states. 404 unknown app, 409 illegal move, 400 missing reason. */
export async function transition(actor: Actor, n: unknown, input: unknown): Promise<TransitionResult> {
  assertCan(actor, "manage");
  return applyTransition({ kind: "admin", actor }, n, input);
}

/**
 * For the webhook and sync (issue 3): forward moves only (planned to building, building to live),
 * never out of `blocked`. Throws ConflictError when the move isn't allowed, so callers that
 * treat "already there" as routine should catch it.
 */
export async function systemTransition(n: unknown, to: Status, reason?: string): Promise<TransitionResult> {
  return applyTransition({ kind: "system" }, n, { to, reason });
}

// ---------------------------------------------------------------------------
// Health URL
// ---------------------------------------------------------------------------

export async function setHealthUrl(actor: Actor, nInput: unknown, url: unknown): Promise<{ n: number; healthUrl: string | null }> {
  assertCan(actor, "manage");
  const n = appNumber.parse(nInput);
  const healthUrl = url === null ? null : healthUrlSchema.parse(url);
  const [row] = await db().update(A).set({ healthUrl }).where(eq(A.n, n)).returning({ n: A.n, healthUrl: A.healthUrl });
  if (!row) throw new NotFoundError("Unknown app");
  return row;
}

// ---------------------------------------------------------------------------
// Running state (Up / Down)
// ---------------------------------------------------------------------------

export const runningInput = z.object({
  /** `default` removes the override, so the cloud's default applies again. */
  to: z.enum(["up", "down", "default"]),
  reason: z.string().trim().max(200).optional(),
});

export type RunningResult = { n: number; running: Running; override: Running | null; changed: boolean };

/**
 * Admin sets or clears the running-state override. Records an `admin` event (the app's history). Either way the
 * pending failure stamp is cleared, and the change time resets the "not recorded for 60 minutes" backstop, so
 * the first check after switching Up is treated like any other first check, not as an app that went silent.
 */
export async function setRunning(actor: Actor, nInput: unknown, input: unknown): Promise<RunningResult> {
  assertCan(actor, "manage");
  const n = appNumber.parse(nInput);
  const { to, reason } = runningInput.parse(input);
  const next: Running | null = to === "default" ? null : to;

  const result = await db().transaction(async (tx) => {
    const [row] = await tx
      .select({ liveCloud: A.liveCloud, override: A.runningOverride })
      .from(A)
      .where(eq(A.n, n))
      .for("update");
    if (!row) throw new NotFoundError("Unknown app");
    const before = effectiveRunning(row.liveCloud, row.override);
    const after = effectiveRunning(row.liveCloud, next);
    if (row.override === next) return { n, running: after, override: next, changed: false };

    const now = new Date();
    await tx
      .update(A)
      .set({
        runningOverride: next,
        runningChangedAt: now,
        runningChangedBy: actor.id,
        runningReason: reason || null,
        healthFailingSince: null,
      })
      .where(eq(A.n, n));
    const how = next === null ? "back to default" : "admin override";
    const title = `Running ${before === "up" ? "Up" : "Down"} → ${after === "up" ? "Up" : "Down"} (${how})${reason ? `: ${reason}` : ""}`;
    await tx.insert(schema.appEvent).values({
      appN: n,
      source: "admin",
      kind: "running_change",
      title: title.length > 200 ? `${title.slice(0, 199)}…` : title,
      occurredAt: now,
    });
    return { n, running: after, override: next, changed: true };
  });
  log.info("running.set", { n, to, running: result.running, changed: result.changed });
  return result;
}

// ---------------------------------------------------------------------------
// Admin-only view and notes
// ---------------------------------------------------------------------------

export async function getAdminView(actor: Actor, nInput: unknown): Promise<AdminAppView> {
  assertCan(actor, "manage");
  const n = appNumber.parse(nInput);
  const [row] = await db()
    .select({
      n: A.n,
      healthUrl: A.healthUrl,
      runningOverride: A.runningOverride,
      runningReason: A.runningReason,
      runningChangedAt: A.runningChangedAt,
    })
    .from(A)
    .where(eq(A.n, n));
  if (!row) throw new NotFoundError("Unknown app");
  const notes = await db()
    .select({
      id: schema.note.id,
      appN: schema.note.appN,
      authorId: schema.note.authorId,
      body: schema.note.body,
      createdAt: schema.note.createdAt,
    })
    .from(schema.note)
    .where(eq(schema.note.appN, n))
    .orderBy(desc(schema.note.createdAt))
    .limit(200);
  return { ...row, notes };
}

export async function addNote(actor: Actor, nInput: unknown, input: unknown): Promise<AdminNote> {
  assertCan(actor, "manage");
  const n = appNumber.parse(nInput);
  const { body } = noteInput.parse(input);
  const [exists] = await db().select({ n: A.n }).from(A).where(eq(A.n, n));
  if (!exists) throw new NotFoundError("Unknown app");
  const [row] = await db()
    .insert(schema.note)
    .values({ appN: n, authorId: actor.id, body })
    .returning({
      id: schema.note.id,
      appN: schema.note.appN,
      authorId: schema.note.authorId,
      body: schema.note.body,
      createdAt: schema.note.createdAt,
    });
  return row;
}

/** Only the note's author may delete it, admins included (the ownership rule, with `strict`). */
export async function deleteNote(actor: Actor, nInput: unknown, idInput: unknown): Promise<void> {
  assertCan(actor, "manage");
  const n = appNumber.parse(nInput);
  const id = noteId.parse(idInput);
  const [row] = await db()
    .select({ id: schema.note.id, authorId: schema.note.authorId })
    .from(schema.note)
    .where(and(eq(schema.note.id, id), eq(schema.note.appN, n)));
  if (!row) throw new NotFoundError("Unknown note");
  assertCan(actor, "delete", { ownerId: row.authorId, strict: true });
  await db().delete(schema.note).where(eq(schema.note.id, id));
}
