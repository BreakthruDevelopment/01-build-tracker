import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ZodError } from "zod";
import { AdminPanel, RegenerateButton, type NoteView } from "./admin-panel";
import { getCurrentUser } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";
import { cloudLabel, flagLabel, formatRelative, httpsUrl, repoUrl, statusLabel } from "@/lib/format";
import { getAdminView, getApp } from "@/lib/tracker";
import {
  CiResult,
  DemoBadge,
  EmptyState,
  ExternalLink,
  HealthMark,
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
      <p>
        <Link href="/" className="text-sm text-accent underline underline-offset-2">
          All apps
        </Link>
      </p>
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <p className="text-sm text-muted">
              {app.n} · {cloudLabel(app.liveCloud)} · <span className="break-all">{app.subdomain}</span>
            </p>
            <h1 className="break-words text-2xl font-semibold tracking-tight sm:text-3xl">{app.name}</h1>
          </div>
          <StatusChip status={app.status} />
        </div>
        {repo ? (
          <p className="text-sm">
            <ExternalLink href={repo}>{app.repo}</ExternalLink>
          </p>
        ) : (
          <p className="break-all text-sm text-muted">{app.repo}</p>
        )}
        {app.status === "blocked" && app.blockedFrom ? (
          <p className="text-sm text-muted">Previous status: {statusLabel(app.blockedFrom)}</p>
        ) : null}
      </header>

      <dl className="grid grid-cols-1 gap-3 rounded-card border border-border bg-surface p-4 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-muted">Health</dt>
          <dd className="break-words">
            <HealthMark health={app.health} />
            {app.healthVersion ? <span className="mt-1 block break-all text-muted">Version {app.healthVersion}</span> : null}
            {app.healthMs !== null ? <span className="mt-1 block text-muted">{app.healthMs} ms</span> : null}
            {app.healthAt ? (
              <span className="mt-1 block text-muted">
                Checked <When at={app.healthAt} now={now} empty="not yet" />
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

      <section className="min-w-0 space-y-3" aria-labelledby="summary-heading">
        <h2 id="summary-heading" className="text-lg font-semibold tracking-tight">
          Today&apos;s summary
        </h2>
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
                  <li key={`${flag.kind}-${index}`} className="min-w-0 break-words rounded-card border border-border bg-background px-3 py-2 text-sm">
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
      </section>

      <section className="min-w-0 space-y-3" aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-lg font-semibold tracking-tight">
          Status history
        </h2>
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
      </section>

      <section className="min-w-0 space-y-3" aria-labelledby="events-heading">
        <h2 id="events-heading" className="text-lg font-semibold tracking-tight">
          Recent events
        </h2>
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
                    {SOURCE[event.source] ?? event.source} · {event.kind} · <When at={event.occurredAt} now={now} empty="Unknown time" />
                  </p>
                  {href ? <ExternalLink href={href}>Open event</ExternalLink> : null}
                </li>
              );
            })}
          </ol>
        )}
        {app.events.length === 20 ? <p className="text-sm text-muted">Showing the latest 20 events.</p> : null}
      </section>

      {admin ? (
        <AdminPanel
          n={app.n}
          status={app.status}
          blockedFrom={app.blockedFrom}
          healthUrl={admin.healthUrl}
          notes={notes}
        />
      ) : null}
    </div>
  );
}
