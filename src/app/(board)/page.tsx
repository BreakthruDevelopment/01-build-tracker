import type { Metadata } from "next";
import Link from "next/link";
import {
  type Column,
  DataList,
  DemoBadge,
  FilterBar,
  PageIntro,
  Panel,
  StatGrid,
  StatTile,
  StatusBadge,
} from "@/components/ui";
import { buttonSecondary } from "@/components/ui/styles";
import { CiResult, ExternalLink, HealthCell, RunningMark, StatusChip, When } from "@/components/tracker-ui";
import { activityAt, boardHref, boardOptions, selectBoard, type BoardQuery } from "@/lib/board-view";
import { cloudLabel, httpsUrl, repoUrl, statusLabel } from "@/lib/format";
import { STATUSES, type Status } from "@/lib/status";
import { listBoard, type BoardApp } from "@/lib/tracker";

export const metadata: Metadata = { title: "Board" };
export const dynamic = "force-dynamic";

// Tab order follows the approved concept: what's live first, the backlog last.
const STATUS_TAB_ORDER: Status[] = ["live", "shipped", "building", "blocked", "planned"];

export default async function Home({ searchParams }: { searchParams: Promise<BoardQuery> }) {
  const options = boardOptions(await searchParams);
  const apps = await listBoard();
  const now = new Date();
  const counts = Object.fromEntries(
    STATUSES.map((status) => [status, apps.filter((app) => app.status === status).length]),
  ) as Record<Status, number>;
  const shown = selectBoard(apps, options);
  const active = shown.filter((app) => app.status !== "planned");
  const planned = shown.filter((app) => app.status === "planned");
  const filters = [
    { status: null, label: "All", count: apps.length },
    ...STATUS_TAB_ORDER.map((status) => ({
      status,
      label: statusLabel(status),
      count: counts[status],
    })),
  ];
  const columns: Column<BoardApp>[] = [
    {
      key: "app",
      header: "App",
      primary: true,
      className: "w-[28%]",
      cell: (app) => <AppName app={app} />,
    },
    {
      key: "cloud",
      header: "Cloud",
      cell: (app) => <span className="font-mono text-xs">{cloudLabel(app.liveCloud)}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (app) => <StatusChip status={app.status} />,
    },
    {
      key: "running",
      header: "Up / Down",
      cell: (app) => <RunningMark running={app.running} parked={app.parked} overridden={app.runningOverridden} />,
    },
    {
      key: "health",
      header: "Health",
      cell: (app) => <HealthCell health={app.health} parked={app.parked} healthAt={app.healthAt} now={now} />,
    },
    {
      key: "ci",
      header: "CI",
      className: "max-w-40",
      cell: (app) => <CiResult conclusion={app.ciConclusion} workflow={app.ciWorkflow} href={httpsUrl(app.ciUrl)} />,
    },
    {
      key: "activity",
      header: "Last activity",
      cell: (app) => <When at={activityAt(app)} now={now} empty="No activity yet" />,
    },
    {
      key: "details",
      header: "Details",
      hideLabel: true,
      srOnlyHeader: true,
      cell: (app) => (
        <Link
          href={`/apps/${app.n}`}
          aria-label={`View details for ${app.name}`}
          className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-accent hover:underline"
        >
          View details <span aria-hidden>→</span>
        </Link>
      ),
    },
  ];
  const plannedColumns: Column<BoardApp>[] = [
    {
      key: "app",
      header: "App",
      primary: true,
      cell: (app) => (
        <Link
          href={`/apps/${app.n}`}
          className="inline-flex min-h-11 items-center gap-3 font-semibold hover:text-accent"
        >
          <span className="font-mono text-xs font-normal text-muted">{String(app.n).padStart(2, "0")}</span>
          {app.name}
        </Link>
      ),
    },
    {
      key: "cloud",
      header: "Cloud",
      cell: (app) => <span className="font-mono text-xs">{cloudLabel(app.liveCloud)}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: () => <StatusBadge status="not-started" />,
    },
  ];

  return (
    <div className="min-w-0">
      <PageIntro
        section="Portfolio"
        title="Building 30 apps in 30 days."
        description="Follow the progress, health, and delivery of the Breakthru portfolio."
      />
      <h2 className="mb-4 font-display text-3xl font-semibold tracking-tight">Portfolio overview</h2>
      <StatGrid>
        <StatTile value={apps.length} label="Total apps" tone="accent" />
        <StatTile value={counts.live} label="Live" tone="live" />
        <StatTile value={counts.planned} label="Planned" />
        <StatTile value={counts.blocked} label="Blocked" tone={counts.blocked ? "blocked" : "default"} />
      </StatGrid>
      <FilterBar
        label="Filter portfolio apps"
        search={{
          value: options.q,
          placeholder: "Search by app name or repo…",
        }}
        filters={[
          {
            name: "cloud",
            label: "Cloud",
            value: options.cloud,
            options: [
              { value: "all", label: "All clouds" },
              { value: "aws", label: "AWS" },
              { value: "azure", label: "Azure" },
              { value: "gcp", label: "Google Cloud" },
              { value: "oci", label: "Oracle" },
            ],
          },
        ]}
        sort={{
          name: "sort",
          label: "Sort apps",
          value: options.sort,
          options: [
            { value: "number", label: "App number" },
            { value: "recent", label: "Recent activity" },
            { value: "status", label: "Status" },
          ],
        }}
        view={{ value: options.view }}
        hidden={options.status ? { status: options.status } : {}}
      />
      <nav aria-label="Filter by status" className="mb-3 flex flex-wrap gap-x-4 border-b border-border">
        {filters.map((filter) => (
          <Link
            key={filter.label}
            href={boardHref(options, filter.status)}
            aria-current={options.status === filter.status ? "page" : undefined}
            className={`inline-flex min-h-11 items-center gap-2 border-b-2 px-1 text-sm font-semibold ${options.status === filter.status ? "border-accent text-accent" : "border-transparent text-muted hover:text-foreground"}`}
          >
            {filter.label} <span className="tabular-nums">{filter.count}</span>
          </Link>
        ))}
      </nav>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
        <p aria-live="polite">
          Showing {shown.length} of {apps.length} apps
        </p>
        {(options.q || options.cloud !== "all" || options.status) && (
          <Link href="/" className={buttonSecondary}>
            Clear filters
          </Link>
        )}
      </div>
      <Panel title="Active apps" count={active.length}>
        <DataList
          caption="Active apps"
          rows={active}
          rowKey={(app) => String(app.n)}
          columns={columns}
          view={options.view}
          empty={
            apps.length
              ? "No active apps match these filters."
              : "No apps yet. The portfolio catalog has not been loaded."
          }
          rowDetail={(app) => (
            <div className="flex flex-col items-start gap-2 rounded-md bg-background px-3 py-2 sm:flex-row sm:justify-between">
              <p className="min-w-0 flex-1 break-words">
                <span className="font-semibold">Latest summary: </span>
                {app.summary ?? "No summary yet today."}
              </p>
              {app.summaryDemo && <DemoBadge />}
            </div>
          )}
        />
      </Panel>
      <Panel
        key={boardHref(options, options.status)}
        title="Planned backlog"
        count={planned.length}
        collapsible
        defaultOpen={false}
        closedLabel={`Show all ${planned.length}`}
        openLabel="Hide backlog"
      >
        <DataList
          caption="Planned apps"
          rows={planned}
          rowKey={(app) => String(app.n)}
          columns={plannedColumns}
          view={options.view}
          empty="No planned apps match these filters."
        />
      </Panel>
    </div>
  );
}

function AppName({ app }: { app: BoardApp }) {
  const href = repoUrl(app.repo);
  return (
    <div className="min-w-0">
      <Link href={`/apps/${app.n}`} className="inline-flex min-h-11 items-center gap-3 font-semibold hover:text-accent">
        <span className="font-mono text-xs font-normal text-muted">{String(app.n).padStart(2, "0")}</span>
        <span className="break-words">{app.name}</span>
      </Link>
      <div className="font-mono text-xs font-normal">
        {href ? (
          <ExternalLink href={href}>{app.repo}</ExternalLink>
        ) : (
          <span className="break-all text-muted">{app.repo}</span>
        )}
      </div>
    </div>
  );
}
