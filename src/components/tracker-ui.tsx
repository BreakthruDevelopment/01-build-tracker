import type { ReactNode } from "react";
import type { Status } from "@/lib/status";
import {
  type ServiceHealth,
  type SummaryTone,
  formatRelative,
  formatTimestamp,
  healthLabel,
  statusLabel,
  summaryLabel,
} from "@/lib/format";

const STATUS_CLASS: Record<Status, string> = {
  planned: "border-border bg-background text-muted",
  building: "border-accent text-accent",
  live: "border-success text-success",
  shipped: "border-accent bg-accent text-accent-foreground",
  blocked: "border-danger text-danger",
};

const HEALTH_DOT: Record<ServiceHealth, string> = {
  ok: "bg-success",
  degraded: "bg-warning",
  down: "bg-danger",
  unknown: "bg-muted",
};

const SUMMARY_CLASS: Record<SummaryTone, string> = {
  green: "border-success text-success",
  amber: "border-warning text-warning",
  red: "border-danger text-danger",
};

export function StatusChip({ status }: { status: Status }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[status]}`}
    >
      {statusLabel(status)}
    </span>
  );
}

/** Health as a dot and a word, so the color is never the only signal. */
export function HealthMark({ health }: { health: ServiceHealth }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block size-2 shrink-0 rounded-full ${HEALTH_DOT[health]}`} aria-hidden="true" />
      <span>Health {healthLabel(health)}</span>
    </span>
  );
}

export function SummaryMark({ tone }: { tone: SummaryTone }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${SUMMARY_CLASS[tone]}`}>
      Summary {summaryLabel(tone)}
    </span>
  );
}

export function DemoBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-muted">
      Demo
    </span>
  );
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
      className={`relative z-10 break-all underline underline-offset-2 ${className ?? "text-accent"}`}
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
