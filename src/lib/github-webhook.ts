import "server-only";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { BadRequestError, ConflictError } from "@/lib/errors";
import { log } from "@/lib/log";
import { systemTransition } from "@/lib/tracker";

/**
 * GitHub webhook handling. Only the fields named below are read from the payload and only
 * allow-listed values are stored; the raw payload is never persisted or logged.
 */

export const GITHUB_OWNER = "breakthrudevelopment";
export const HANDLED_EVENTS = ["push", "pull_request", "workflow_run"] as const;

const repository = z.object({
  full_name: z.string().max(200),
  default_branch: z.string().max(200).optional(),
});

const pushPayload = z.object({
  repository,
  ref: z.string().max(300),
  deleted: z.boolean().optional(),
  head_commit: z
    .object({ message: z.string().max(100_000), url: z.string().max(500).optional(), timestamp: z.string().max(40).optional() })
    .nullish(),
  compare: z.string().max(500).optional(),
});

const pullRequestPayload = z.object({
  repository,
  action: z.string().max(60),
  pull_request: z.object({
    number: z.number().int(),
    title: z.string().max(1000),
    html_url: z.string().max(500).optional(),
    updated_at: z.string().max(40).optional(),
  }),
});

const workflowRunPayload = z.object({
  repository,
  action: z.string().max(60),
  workflow_run: z.object({
    name: z.string().max(200).nullish(),
    conclusion: z.string().max(40).nullish(),
    head_branch: z.string().max(300).nullish(),
    html_url: z.string().max(500).optional(),
    updated_at: z.string().max(40).optional(),
  }),
});

export type WebhookOutcome =
  | { status: 200; body: { ok: true; event: string; duplicate?: true } }
  | { status: 202; body: { ok: true; ignored: string } };

/** Accept only plain github.com links so a forged payload can't plant `javascript:` or other hosts in the UI. */
function githubUrl(value: string | undefined): string | null {
  if (!value || value.length > 500) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "github.com" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A valid timestamp no later than now, else now. */
function when(value: string | null | undefined): Date {
  const now = new Date();
  if (!value) return now;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) || d > now ? now : d;
}

function clip(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/** The app whose `repo` matches `owner/name`, or null for other owners and unknown repos. */
async function findApp(fullName: string): Promise<number | null> {
  const [owner, name, ...rest] = fullName.split("/");
  if (!owner || !name || rest.length || owner.toLowerCase() !== GITHUB_OWNER) return null;
  const [row] = await db()
    .select({ n: schema.app.n })
    .from(schema.app)
    .where(sql`lower(${schema.app.repo}) = ${name.toLowerCase()}`);
  return row?.n ?? null;
}

export async function handleGithubEvent(event: string, deliveryId: string | null, payload: unknown): Promise<WebhookOutcome> {
  if (event === "ping") return { status: 200, body: { ok: true, event } };
  if (!(HANDLED_EVENTS as readonly string[]).includes(event)) return { status: 202, body: { ok: true, ignored: "event" } };
  if (!deliveryId || deliveryId.length > 100) throw new BadRequestError("Missing X-GitHub-Delivery");

  const parsed = parseEvent(event, payload);
  const n = await findApp(parsed.fullName);
  if (n === null) return { status: 202, body: { ok: true, ignored: "repo" } };
  if (!parsed.record) return { status: 202, body: { ok: true, ignored: "action" } };

  const { record } = parsed;
  const fresh = await db().transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.appEvent)
      .values({
        appN: n,
        source: "github",
        kind: record.kind,
        deliveryId,
        title: record.title,
        url: record.url,
        occurredAt: record.occurredAt,
      })
      .onConflictDoNothing({ target: schema.appEvent.deliveryId })
      .returning({ id: schema.appEvent.id });
    if (inserted.length === 0) return false;

    if (record.lastPushAt) {
      await tx
        .update(schema.app)
        .set({ lastPushAt: record.lastPushAt })
        .where(and(eq(schema.app.n, n), or(isNull(schema.app.lastPushAt), lte(schema.app.lastPushAt, record.lastPushAt))));
    }
    if (record.ci) {
      await tx
        .update(schema.app)
        .set({ ciConclusion: record.ci.conclusion, ciWorkflow: record.ci.workflow, ciUrl: record.url, ciAt: record.occurredAt })
        .where(and(eq(schema.app.n, n), or(isNull(schema.app.ciAt), lte(schema.app.ciAt, record.occurredAt))));
    }
    return true;
  });

  if (!fresh) return { status: 200, body: { ok: true, event, duplicate: true } };

  if (event === "push" || event === "pull_request") {
    try {
      await systemTransition(n, "building", `First ${event === "push" ? "push" : "pull request"} from GitHub`);
    } catch (err) {
      // Already building, live, blocked...: the move is simply not needed. Anything else is a real failure.
      if (!(err instanceof ConflictError)) throw err;
    }
  }
  log.info("webhook.recorded", { event, n, kind: record.kind });
  return { status: 200, body: { ok: true, event } };
}

type Recorded = {
  kind: string;
  title: string;
  url: string | null;
  occurredAt: Date;
  /** Set for pushes to the default branch. */
  lastPushAt?: Date;
  /** Set for completed workflow runs on the default branch. */
  ci?: { conclusion: string; workflow: string };
};

function parseEvent(event: string, payload: unknown): { fullName: string; record: Recorded | null } {
  if (event === "push") {
    const p = pushPayload.parse(payload);
    const branch = p.ref.replace(/^refs\/heads\//, "");
    const isDefault = !!p.repository.default_branch && branch === p.repository.default_branch;
    const at = when(p.head_commit?.timestamp);
    const message = p.head_commit?.message ? clip(p.head_commit.message, 150) : p.deleted ? "branch deleted" : "push";
    return {
      fullName: p.repository.full_name,
      record: {
        kind: "push",
        title: clip(`${branch}: ${message}`),
        url: githubUrl(p.head_commit?.url) ?? githubUrl(p.compare),
        occurredAt: at,
        lastPushAt: isDefault && !p.deleted ? at : undefined,
      },
    };
  }
  if (event === "pull_request") {
    const p = pullRequestPayload.parse(payload);
    return {
      fullName: p.repository.full_name,
      record: {
        kind: `pull_request.${p.action.replace(/[^a-z_]/gi, "").slice(0, 40)}`,
        title: clip(`PR #${p.pull_request.number} ${p.action}: ${p.pull_request.title}`),
        url: githubUrl(p.pull_request.html_url),
        occurredAt: when(p.pull_request.updated_at),
      },
    };
  }
  const p = workflowRunPayload.parse(payload);
  if (p.action !== "completed" || !p.workflow_run.conclusion) return { fullName: p.repository.full_name, record: null };
  const workflow = clip(p.workflow_run.name ?? "workflow", 100);
  const conclusion = p.workflow_run.conclusion;
  const onDefault = !!p.repository.default_branch && p.workflow_run.head_branch === p.repository.default_branch;
  return {
    fullName: p.repository.full_name,
    record: {
      kind: "workflow_run",
      title: clip(`${workflow}: ${conclusion}${p.workflow_run.head_branch ? ` on ${p.workflow_run.head_branch}` : ""}`),
      url: githubUrl(p.workflow_run.html_url),
      occurredAt: when(p.workflow_run.updated_at),
      ci: onDefault ? { conclusion, workflow } : undefined,
    },
  };
}
