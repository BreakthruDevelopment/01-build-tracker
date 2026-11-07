import type { Metadata } from "next";
import Link from "next/link";
import { AppCard } from "@/components/app-card";
import { EmptyState } from "@/components/tracker-ui";
import { parseStatusFilter, statusLabel } from "@/lib/format";
import { STATUSES, type Status } from "@/lib/status";
import { listBoard } from "@/lib/tracker";

export const metadata: Metadata = { title: "Board" };
export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const status = parseStatusFilter((await searchParams).status);
  const now = new Date();
  const apps = await listBoard();
  const counts = Object.fromEntries(STATUSES.map((item) => [item, 0])) as Record<Status, number>;
  for (const app of apps) counts[app.status] += 1;
  const shown = status ? apps.filter((app) => app.status === status) : apps;
  const filters: { href: string; label: string; count: number; active: boolean }[] = [
    { href: "/", label: "All", count: apps.length, active: status === null },
    ...STATUSES.map((item) => ({
      href: `/?status=${item}`,
      label: statusLabel(item),
      count: counts[item],
      active: status === item,
    })),
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Portfolio board</h1>
        <p className="max-w-2xl text-sm text-muted sm:text-base">
          Status, health, CI, the last push, and the daily summary for every app.
        </p>
      </div>
      <nav aria-label="Filter by status" className="flex flex-wrap gap-2">
        {filters.map((filter) => (
          <Link
            key={filter.href}
            href={filter.href}
            aria-current={filter.active ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${
              filter.active
                ? "border-accent bg-accent text-accent-foreground"
                : "border-border bg-surface text-foreground"
            }`}
          >
            {filter.label} <span className="tabular-nums">{filter.count}</span>
          </Link>
        ))}
      </nav>
      <p className="text-sm text-muted">
        {status ? `${shown.length} of ${apps.length} apps` : `${apps.length} apps`}
      </p>
      {apps.length === 0 ? (
        <EmptyState title="No apps on the board">The catalog seed has not been applied.</EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title={`No ${status ? statusLabel(status).toLowerCase() : ""} apps`}>
          <Link href="/" className="text-accent underline underline-offset-2">
            Show all {apps.length} apps
          </Link>
        </EmptyState>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {shown.map((app) => (
            <li key={app.n} className="min-w-0">
              <AppCard app={app} now={now} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
