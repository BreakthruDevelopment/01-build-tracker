import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro, Panel } from "@/components/ui";
import { buttonSecondary } from "@/components/ui/styles";
import { notFound } from "next/navigation";
import { ZodError } from "zod";
import { AdminPanel, CheckNowButton, RegenerateButton, type NoteView } from "./admin-panel";
import { getCurrentUser } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";
import { cloudLabel, flagLabel, healthLabel, formatRelative, httpsUrl, repoUrl, statusLabel } from "@/lib/format";
import { getAdminView, getApp } from "@/lib/tracker";
import {
  CiResult,
  DemoBadge,
  EmptyState,
  ExternalLink,
  HealthMark,
  RunningMark,
  StatusChip,
  SummaryMark,
  When,
} from "@/components/tracker-ui";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

const loadApp = cache(async (n: string) => {
  try {
    return await getApp(n);
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ZodError) return null;
    throw err;
  }
});

export async function generateMetadata({ params }: { params: Promise<{ n: string }> }): Promise<Metadata> {
  const app = await loadApp((await params).n);
  return { title: app?.name ?? "Unknown app" };
}

const SOURCE: Record<string, string> = {
  github: "GitHub",
  health: "Health",
  ops_monitor: "Ops monitor",
  admin: "Admin",
};

export default async function AppPage({ params }: { params: Promise<{ n: string }> }) {
  const app = await loadApp((await params).n);
  if (!app) notFound();

  const now = new Date();
  const user = await getCurrentUser();
  // Notes and the health URL stay out of the HTML unless the viewer is an admin.
  const admin = user?.role === "admin" ? await getAdminView(user, app.n) : null;
  const notes: NoteView[] = admin
    ? admin.notes.map((note) => ({
        id: note.id,
        body: note.body,
        createdLabel: formatRelative(note.createdAt, now),
        createdIso: note.createdAt.toISOString(),
        canDelete: user?.id === note.authorId,
      }))
    : [];
  const repo = repoUrl(app.repo);
  const ciHref = httpsUrl(app.ciUrl);

  return (
    <div className="min-w-0 space-y-6">
      <PageIntro
        section={`App ${String(app.n).padStart(2, "0")} · ${cloudLabel(app.liveCloud)}`}
        title={app.name}
        description={app.subdomain}
        actions={
          <>
            <Link href="/" className={buttonSecondary}>
              Back to board
            </Link>
            <StatusChip status={app.status} />
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3 font-mono text-sm">
        {repo ? (
          <ExternalLink href={repo}>{app.repo}</ExternalLink>
        ) : (
          <span className="break-all text-muted">{app.repo}</span>
        )}
        {app.status === "blocked" && app.blockedFrom ? (
          <span className="text-muted">Previous status: {statusLabel(app.blockedFrom)}</span>
        ) : null}
      </div>

      <Panel title="Service overview">
        <dl className="grid grid-cols-1 gap-3 rounded-card border border-border bg-surface p-4 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-xs text-muted">Up / Down</dt>
            <dd className="break-words">
              <RunningMark running={app.running} parked={app.parked} overridden={app.runningOverridden} showSub={false} />
              <span className="mt-1 block text-muted">
                {app.parked
                  ? "Parked: not checked, wakes on first visit"
                  : app.running === "down"
                    ? "Checked until it goes live"
                    : "Checked by sync"}
              </span>
              {app.running === "down" && app.liveCloud === "azure" && !app.runningOverridden ? (
                <span className="mt-1 block text-muted">Default for Azure apps. Down is a cost choice, not an outage.</span>
              ) : null}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">Health</dt>
            <dd className="break-words">
              <HealthMark health={app.health} parked={app.parked} />
              {app.healthVersion ? (
                <span className="mt-1 block break-all text-muted">Version {app.healthVersion}</span>
              ) : null}
              {app.healthMs !== null && !app.parked ? <span className="mt-1 block text-muted">{app.healthMs} ms</span> : null}
              {app.parked && app.health !== "unknown" ? (
                <span className="mt-1 block text-muted">Last result: {healthLabel(app.health)}</span>
              ) : null}
              {app.healthAt ? (
                <span className="mt-1 block text-muted">
                  {app.parked ? "Last checked " : "Checked "}
                  <When at={app.healthAt} now={now} empty="not yet" />
                </span>
              ) : null}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">CI</dt>
            <dd className="break-words">
              <CiResult conclusion={app.ciConclusion} workflow={app.ciWorkflow} href={ciHref} />
              {app.ciAt ? (
                <span className="mt-1 block text-muted">
                  <When at={app.ciAt} now={now} empty="No CI result" />
                </span>
              ) : null}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">Last push</dt>
            <dd>
              <When at={app.lastPushAt} now={now} empty="No pushes yet" />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">In this status</dt>
            <dd>
              <When at={app.statusChangedAt} now={now} empty="Unknown" />
            </dd>
          </div>
        </dl>
        {admin ? <CheckNowButton n={app.n} parked={app.parked} /> : null}
      </Panel>

      <Panel id="summary-heading" title="Today's summary">
        {app.summary ? (
          <div className="space-y-3 rounded-card border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              {app.summaryHealth ? <SummaryMark tone={app.summaryHealth} /> : null}
              {app.summaryDemo ? <DemoBadge /> : null}
            </div>
            <p className="break-words text-sm">{app.summary}</p>
            {app.summaryFlags.length === 0 ? (
              <p className="text-sm text-muted">No flags.</p>
            ) : (
              <ul className="space-y-2">
                {app.summaryFlags.map((flag, index) => (
                  <li
                    key={`${flag.kind}-${index}`}
                    className="min-w-0 break-words rounded-card border border-border bg-background px-3 py-2 text-sm"
                  >
                    <span className="font-medium">{flagLabel(flag.kind)}</span>
                    <span className="text-muted"> · {flag.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {app.summaryDemo ? <DemoBadge /> : null}
            <EmptyState title="No summary yet today">
              Summaries are written once a day, not when this page opens.
            </EmptyState>
          </div>
        )}
        {admin ? <RegenerateButton n={app.n} /> : null}
      </Panel>

      <Panel id="history-heading" title="Status history">
        {app.history.length === 0 ? (
          <EmptyState title="No status changes yet" />
        ) : (
          <ol className="space-y-3">
            {app.history.map((item) => (
              <li key={item.id} className="min-w-0 space-y-2 rounded-card border border-border bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip status={item.from} />
                  <span className="text-sm text-muted">to</span>
                  <StatusChip status={item.to} />
                </div>
                <p className="text-sm text-muted">
                  {item.actor === "admin" ? "By an admin" : "By the system"}
                  {" · "}
                  <When at={item.at} now={now} empty="Unknown time" />
                </p>
                {item.reason ? <p className="break-words text-sm">{item.reason}</p> : null}
              </li>
            ))}
          </ol>
        )}
        {app.history.length === 50 ? <p className="text-sm text-muted">Showing the latest 50 changes.</p> : null}
      </Panel>

      <Panel id="events-heading" title="Recent events">
        {app.events.length === 0 ? (
          <EmptyState title="No events yet" />
        ) : (
          <ol className="space-y-3">
            {app.events.map((event) => {
              const href = httpsUrl(event.url);
              return (
                <li key={event.id} className="min-w-0 space-y-1 rounded-card border border-border bg-surface p-4">
                  <p className="break-words text-sm font-medium">{event.title}</p>
                  <p className="break-words text-sm text-muted">
                    {SOURCE[event.source] ?? event.source} · {event.kind} ·{" "}
                    <When at={event.occurredAt} now={now} empty="Unknown time" />
                  </p>
                  {href ? <ExternalLink href={href}>Open event</ExternalLink> : null}
                </li>
              );
            })}
          </ol>
        )}
        {app.events.length === 20 ? <p className="text-sm text-muted">Showing the latest 20 events.</p> : null}
      </Panel>

      {admin ? (
        <AdminPanel
          n={app.n}
          status={app.status}
          blockedFrom={app.blockedFrom}
          healthUrl={admin.healthUrl}
          notes={notes}
          liveCloud={app.liveCloud}
          runningOverride={admin.runningOverride}
          runningReason={admin.runningReason}
        />
      ) : null}
    </div>
  );
}
