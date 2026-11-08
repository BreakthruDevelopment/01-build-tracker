import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro, Panel, StatusBadge } from "@/components/ui";
import { buttonSecondary } from "@/components/ui/styles";
import { SyncForm } from "./sync-form";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { env } from "@/lib/env";
import {
  formatRelative,
  formatTimestamp,
  ingestLines,
  readIngestState,
  readSyncState,
  syncLines,
  type IngestSnapshot,
  type SyncSnapshot,
} from "@/lib/format";
import { getTrackerState } from "@/lib/tracker-state";
import { EmptyState } from "@/components/tracker-ui";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";
export const maxDuration = 25;

export default async function AdminPage() {
  await requireRoleOrRedirect("admin");
  const now = new Date();
  const config = env();
  // Booleans only. Secret values are never rendered or passed to the client form.
  const secrets = [
    {
      name: "GITHUB_WEBHOOK_SECRET",
      set: Boolean(config.GITHUB_WEBHOOK_SECRET),
    },
    { name: "INGEST_TOKEN", set: Boolean(config.INGEST_TOKEN) },
    { name: "SYNC_TOKEN", set: Boolean(config.SYNC_TOKEN) },
    { name: "GEMINI_API_KEY", set: Boolean(config.GEMINI_API_KEY) },
    { name: "ANTHROPIC_API_KEY", set: Boolean(config.ANTHROPIC_API_KEY) },
  ];
  const [sync, ingest] = await Promise.all([getTrackerState("last_sync"), getTrackerState("last_ingest")]);
  const syncSnapshot = readSyncState(sync);
  const ingestSnapshot = readIngestState(ingest);

  return (
    <div className="min-w-0 space-y-6">
      <PageIntro
        section="Admin"
        title="Portfolio controls"
        description="Check configuration and the latest sync activity."
        actions={
          <Link href="/" className={buttonSecondary}>
            Back to board
          </Link>
        }
      />

      <Panel id="secrets-heading" title="Configuration">
        <p className="text-sm text-muted">AI provider: {config.AI_PROVIDER}</p>
        <dl className="divide-y divide-border rounded-card border border-border bg-surface">
          {secrets.map((secret) => (
            <div key={secret.name} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-3">
              <dt className="min-w-0 break-all font-mono text-sm">{secret.name}</dt>
              <dd>
                <StatusBadge status={secret.set ? "healthy" : "unknown"} label={secret.set ? "Set" : "Not set"} />
              </dd>
            </div>
          ))}
        </dl>
      </Panel>

      <Panel id="sync-heading" title="Last sync">
        <Snapshot
          now={now}
          at={syncSnapshot.at}
          lines={syncLines(syncSnapshot)}
          empty="No sync has run yet."
          extra={null}
        />
        <SyncForm />
      </Panel>

      <Panel id="ingest-heading" title="Last ingest">
        <Snapshot
          now={now}
          at={ingestSnapshot.at}
          lines={ingestLines(ingestSnapshot)}
          empty="No ingest has been received yet."
          extra={ingestExtra(ingestSnapshot, now)}
        />
      </Panel>
    </div>
  );
}

function ingestExtra(
  snapshot: IngestSnapshot,
  now: Date,
): {
  summary: string | null;
  reported: string | null;
  reportedIso: string | null;
} {
  return {
    summary: snapshot.summary,
    reported: snapshot.reportedAt ? formatRelative(snapshot.reportedAt, now) : null,
    reportedIso: snapshot.reportedAt ? snapshot.reportedAt.toISOString() : null,
  };
}

function Snapshot({
  now,
  at,
  lines,
  empty,
  extra,
}: {
  now: Date;
  at: SyncSnapshot["at"];
  lines: string[];
  empty: string;
  extra: {
    summary: string | null;
    reported: string | null;
    reportedIso: string | null;
  } | null;
}) {
  if (!at && lines.length === 0 && !extra?.summary) {
    return <EmptyState title={empty} />;
  }
  return (
    <div className="space-y-2 text-sm">
      {at ? (
        <p>
          Recorded <time dateTime={at.toISOString()}>{formatRelative(at, now)}</time>{" "}
          <span className="text-muted">({formatTimestamp(at)})</span>
        </p>
      ) : (
        <p className="text-muted">No timestamp recorded.</p>
      )}
      {extra?.reported && extra.reportedIso ? (
        <p>
          Report time <time dateTime={extra.reportedIso}>{extra.reported}</time>
        </p>
      ) : null}
      {lines.map((line, index) => (
        <p key={index} className="break-words">
          {line}
        </p>
      ))}
      {extra?.summary ? <p className="break-words">{extra.summary}</p> : null}
    </div>
  );
}
