import "server-only";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { log } from "@/lib/log";
import { setTrackerState } from "@/lib/tracker-state";

/**
 * The ops monitor's nightly report. Documented in README.md ("Ingest API"); keep the two in step.
 */
const httpsUrl = z
  .string()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && u.hostname === "github.com";
    } catch {
      return false;
    }
  }, "url must be an https://github.com link");

const appReport = z
  .object({
    n: z.number().int().min(1).max(30).optional(),
    repo: z.string().min(1).max(100).optional(),
    ci: z
      .object({
        conclusion: z.string().min(1).max(40),
        workflow: z.string().min(1).max(100),
        url: httpsUrl.optional(),
      })
      .optional(),
    stalled: z
      .array(
        z.object({
          kind: z.string().min(1).max(40),
          detail: z.string().min(1).max(200),
          hours: z.number().min(0).max(100_000).optional(),
        }),
      )
      .max(10)
      .optional(),
  })
  .refine((a) => a.n !== undefined || a.repo !== undefined, { message: "Each app needs n or repo" });

export const ingestReport = z.object({
  reported_at: z.iso.datetime({ offset: true }),
  apps: z.array(appReport).max(30).default([]),
  clouds: z
    .array(
      z.object({
        cloud: z.enum(["aws", "azure", "gcp", "oci"]),
        metrics: z
          .array(
            z.object({
              metric: z.string().min(1).max(100),
              used_pct: z.number().min(0).max(100),
              charge_cents: z.number().int().min(0).max(100_000_000),
            }),
          )
          .max(50),
      }),
    )
    .max(8)
    .default([]),
  summary: z.string().max(500).optional(),
});

export type IngestReport = z.infer<typeof ingestReport>;

function clip(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  // Slice by code point so an emoji is never cut in half.
  const chars = Array.from(oneLine);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : oneLine;
}

export async function applyIngest(input: unknown) {
  const report = ingestReport.parse(input);
  const now = new Date();
  const reportedAt = new Date(report.reported_at) > now ? now : new Date(report.reported_at);

  const result = await db().transaction(async (tx) => {
    let events = 0;
    let skipped = 0;
    let matched = 0;
    for (const a of report.apps) {
      const [row] = await tx
        .select({ n: schema.app.n })
        .from(schema.app)
        .where(a.n !== undefined ? eq(schema.app.n, a.n) : sql`lower(${schema.app.repo}) = ${a.repo!.toLowerCase()}`);
      if (!row) {
        skipped++;
        continue;
      }
      matched++;
      if (a.ci) {
        await tx.insert(schema.appEvent).values({
          appN: row.n,
          source: "ops_monitor",
          kind: "ci",
          title: clip(`${a.ci.workflow}: ${a.ci.conclusion}`),
          url: a.ci.url ?? null,
          occurredAt: reportedAt,
        });
        events++;
        // The webhook is the primary CI source; a report only fills in or refreshes older results.
        await tx
          .update(schema.app)
          .set({ ciConclusion: a.ci.conclusion, ciWorkflow: a.ci.workflow, ciUrl: a.ci.url ?? null, ciAt: reportedAt })
          .where(and(eq(schema.app.n, row.n), or(isNull(schema.app.ciAt), lte(schema.app.ciAt, reportedAt))));
      }
      for (const s of a.stalled ?? []) {
        const hours = s.hours !== undefined ? ` (${Math.round(s.hours)} h)` : "";
        await tx.insert(schema.appEvent).values({
          appN: row.n,
          source: "ops_monitor",
          kind: `stalled.${s.kind.replace(/[^a-z0-9_-]/gi, "").slice(0, 30) || "other"}`,
          title: clip(`Stalled${hours}: ${s.detail}`),
          occurredAt: reportedAt,
        });
        events++;
      }
    }

    let usage = 0;
    for (const c of report.clouds) {
      for (const m of c.metrics) {
        await tx.insert(schema.cloudUsage).values({
          cloud: c.cloud,
          metric: m.metric,
          usedPct: Math.round(m.used_pct),
          chargeCents: m.charge_cents,
          reportedAt,
        });
        usage++;
      }
    }
    return { apps: matched, skipped, events, cloud_usage: usage };
  });

  await setTrackerState("last_ingest", { reported_at: reportedAt.toISOString(), summary: report.summary ?? null, ...result });
  log.info("ingest.recorded", result);
  return result;
}
