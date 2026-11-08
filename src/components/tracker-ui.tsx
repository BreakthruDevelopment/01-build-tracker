import type { ReactNode } from "react";
import { StatusBadge, type Status as BadgeStatus } from "@/components/ui/StatusBadge";
export { DemoBadge } from "@/components/ui/DemoBadge";
import type { Status } from "@/lib/status";
import { type ServiceHealth, type SummaryTone, formatRelative, formatTimestamp, statusLabel } from "@/lib/format";

const STATUS_BADGE: Record<Status, BadgeStatus> = {
  planned: "not-started",
  building: "building",
  live: "live",
  shipped: "shipped",
  blocked: "blocked",
};
const HEALTH_BADGE: Record<ServiceHealth, BadgeStatus> = {
  ok: "healthy",
  degraded: "degraded",
  down: "down",
  unknown: "unknown",
};

export function StatusChip({ status }: { status: Status }) {
  return <StatusBadge status={STATUS_BADGE[status]} label={statusLabel(status)} />;
}

export function HealthMark({ health }: { health: ServiceHealth }) {
  return <StatusBadge status={HEALTH_BADGE[health]} />;
}

export function SummaryMark({ tone }: { tone: SummaryTone }) {
  const status = {
    green: "healthy",
    amber: "degraded",
    red: "failed",
  } as const;
  const label = {
    green: "Summary healthy",
    amber: "Summary needs attention",
    red: "Summary has issues",
  };
  return <StatusBadge status={status[tone]} label={label[tone]} />;
}

export function When({ at, now, empty }: { at: Date | null; now: Date; empty: string }) {
  if (!at) return <span className="text-muted">{empty}</span>;
  return (
    <time dateTime={at.toISOString()} title={formatTimestamp(at)}>
      {formatRelative(at, now)}
    </time>
  );
}

const CI_TONE: Record<string, string> = {
  success: "text-success",
  failure: "text-danger",
  timed_out: "text-danger",
  cancelled: "text-muted",
  skipped: "text-muted",
  neutral: "text-muted",
};

export function CiResult({
  conclusion,
  workflow,
  href,
}: {
  conclusion: string | null;
  workflow: string | null;
  href: string | null;
}) {
  if (!conclusion) return <span className="text-muted">No CI result</span>;
  const label = workflow ? `CI ${conclusion} · ${workflow}` : `CI ${conclusion}`;
  const tone = CI_TONE[conclusion] ?? "text-foreground";
  if (!href) return <span className={`break-words ${tone}`}>{label}</span>;
  return (
    <ExternalLink href={href} className={tone}>
      {label}
    </ExternalLink>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`relative z-10 inline-flex min-h-11 min-w-11 items-center break-all underline underline-offset-2 ${className ?? "text-accent"}`}
    >
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-border bg-surface px-4 py-6 text-sm">
      <p className="font-medium">{title}</p>
      {children ? <p className="mt-1 text-muted">{children}</p> : null}
    </div>
  );
}

export function LoadingBlock({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      <p className="text-sm text-muted">{label}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-card border border-border bg-surface" />
        ))}
      </div>
    </div>
  );
}
