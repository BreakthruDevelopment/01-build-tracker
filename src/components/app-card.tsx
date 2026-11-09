import Link from "next/link";
import type { BoardApp } from "@/lib/tracker";
import { cloudLabel, httpsUrl } from "@/lib/format";
import { CiResult, DemoBadge, HealthCell, RunningMark, StatusChip, SummaryMark, When } from "@/components/tracker-ui";

export function AppCard({ app, now }: { app: BoardApp; now: Date }) {
  const ciHref = httpsUrl(app.ciUrl);
  return (
    <article className="relative flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted">
            {app.n} · {cloudLabel(app.liveCloud)}
          </p>
          <h2 className="text-base font-semibold tracking-tight">
            <Link
              href={`/apps/${app.n}`}
              className="break-words after:absolute after:inset-0 after:z-0 after:content-['']"
            >
              {app.name}
            </Link>
          </h2>
        </div>
        <StatusChip status={app.status} />
      </div>
      <dl className="space-y-1 text-sm">
        <div>
          <dt className="sr-only">Up / Down</dt>
          <dd>
            <RunningMark running={app.running} parked={app.parked} overridden={app.runningOverridden} />
          </dd>
        </div>
        <div>
          <dt className="sr-only">Health</dt>
          <dd>
            <HealthCell health={app.health} parked={app.parked} healthAt={app.healthAt} now={now} />
          </dd>
        </div>
        <div>
          <dt className="sr-only">CI</dt>
          <dd>
            <CiResult conclusion={app.ciConclusion} workflow={app.ciWorkflow} href={ciHref} />
          </dd>
        </div>
        <div>
          <dt className="sr-only">Last push</dt>
          <dd>
            {app.lastPushAt ? (
              <>
                Last push <When at={app.lastPushAt} now={now} empty="No pushes yet" />
              </>
            ) : (
              <span className="text-muted">No pushes yet</span>
            )}
          </dd>
        </div>
      </dl>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {app.summaryHealth ? <SummaryMark tone={app.summaryHealth} /> : null}
          {app.summaryDemo ? <DemoBadge /> : null}
        </div>
        {app.summary ? (
          <p className="break-words text-sm">{app.summary}</p>
        ) : (
          <p className="text-sm text-muted">No summary yet today.</p>
        )}
      </div>
    </article>
  );
}
