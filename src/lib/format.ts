import { STATUSES, type Status } from "@/lib/status";

/** Service health on an app, separate from its build status. */
export type ServiceHealth = "ok" | "degraded" | "down" | "unknown";
/** Daily summary tone. */
export type SummaryTone = "green" | "amber" | "red";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const STATUS_LABEL: Record<Status, string> = {
  planned: "Planned",
  building: "Building",
  live: "Live",
  shipped: "Shipped",
  blocked: "Blocked",
};

const HEALTH_LABEL: Record<ServiceHealth, string> = {
  ok: "OK",
  degraded: "Degraded",
  down: "Down",
  unknown: "Unknown",
};

const SUMMARY_LABEL: Record<SummaryTone, string> = {
  green: "Green",
  amber: "Amber",
  red: "Red",
};

const FLAG_LABEL: Record<string, string> = {
  stalled: "Stalled",
  failing_ci: "Failing CI",
  down: "Down",
  free_tier: "Free tier",
  other: "Other",
};

function unit(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Short relative time, with the day spelled out past two days and a date after a month. */
export function formatRelative(date: Date, now = new Date()): string {
  const diff = now.getTime() - date.getTime();
  const abs = Math.abs(diff);
  const say = (count: number, noun: string) => {
    const label = unit(Math.max(1, count), noun);
    return diff >= 0 ? `${label} ago` : `in ${label}`;
  };

  if (abs < 45_000) return "just now";
  if (abs < HOUR) return say(Math.round(abs / MINUTE), "minute");
  if (abs < 2 * DAY) return say(Math.round(abs / HOUR), "hour");
  if (abs < 30 * DAY) return say(Math.round(abs / DAY), "day");
  return date.toISOString().slice(0, 10);
}

/** Absolute time in UTC, for the title of a relative time and the admin timestamps. */
export function formatTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function statusLabel(status: Status): string {
  return STATUS_LABEL[status];
}

export function healthLabel(health: ServiceHealth): string {
  return HEALTH_LABEL[health];
}

export function summaryLabel(tone: SummaryTone): string {
  return SUMMARY_LABEL[tone];
}

export function flagLabel(kind: string): string {
  return FLAG_LABEL[kind] ?? kind;
}

const CLOUD_LABEL: Record<string, string> = {
  aws: "AWS",
  azure: "Azure",
  gcp: "GCP",
  oci: "OCI",
};

export function cloudLabel(cloud: string): string {
  return CLOUD_LABEL[cloud] ?? cloud;
}

/** Board filter. An unknown or empty value means "all statuses". */
export function parseStatusFilter(value: string | string[] | undefined): Status | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  return (STATUSES as readonly string[]).includes(raw) ? (raw as Status) : null;
}

/** https URLs only, so a stored link cannot become a javascript: URL. */
export function httpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function repoUrl(repo: string): string | null {
  if (!REPO_NAME.test(repo)) return null;
  return `https://github.com/BreakthruDevelopment/${repo}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export type SyncSnapshot = {
  at: Date | null;
  catalogUpdated: number | null;
  catalogFailed: boolean;
  checked: number | null;
  ok: number | null;
  down: number | null;
  unconfirmed: number | null;
  skipped: number | null;
  parked: number | null;
  ms: number | null;
};

/** Read the `last_sync` blob. Drops anything that is not a count or a timestamp. */
export function readSyncState(value: Record<string, unknown> | null): SyncSnapshot {
  const catalog = asRecord(value?.catalog);
  const health = asRecord(value?.health);
  return {
    at: asDate(value?.at),
    catalogUpdated: asNumber(catalog?.updated),
    catalogFailed: typeof catalog?.error === "string" && catalog.error.length > 0,
    checked: asNumber(health?.checked),
    ok: asNumber(health?.ok),
    down: asNumber(health?.down),
    unconfirmed: asNumber(health?.unconfirmed),
    skipped: asNumber(health?.skipped),
    parked: asNumber(health?.parked),
    ms: asNumber(value?.ms),
  };
}

export function syncLines(snapshot: SyncSnapshot): string[] {
  const lines: string[] = [];
  if (snapshot.catalogFailed) lines.push("Catalog sync failed.");
  else if (snapshot.catalogUpdated !== null) {
    lines.push(`Catalog updated ${unit(snapshot.catalogUpdated, "app")}.`);
  }
  const health = [
    snapshot.checked !== null ? `${snapshot.checked} checked` : null,
    snapshot.ok !== null ? `${snapshot.ok} ok` : null,
    snapshot.down !== null ? `${snapshot.down} down` : null,
    snapshot.unconfirmed ? `${snapshot.unconfirmed} unconfirmed` : null,
    snapshot.skipped !== null ? `${snapshot.skipped} skipped` : null,
    snapshot.parked ? `${snapshot.parked} parked` : null,
  ].filter((part) => part !== null);
  if (health.length > 0) lines.push(`Health: ${health.join(", ")}.`);
  if (snapshot.ms !== null && snapshot.ms >= 0) {
    lines.push(snapshot.ms < 10_000 ? `Finished in ${(snapshot.ms / 1000).toFixed(1)}s.` : `Finished in ${Math.round(snapshot.ms / 1000)}s.`);
  }
  return lines;
}

export type IngestSnapshot = {
  at: Date | null;
  reportedAt: Date | null;
  summary: string | null;
  apps: number | null;
  skipped: number | null;
  events: number | null;
  cloudUsage: number | null;
};

/** Read the `last_ingest` blob. The summary is capped so a bad row cannot flood the page. */
export function readIngestState(value: Record<string, unknown> | null): IngestSnapshot {
  return {
    at: asDate(value?.at),
    reportedAt: asDate(value?.reported_at),
    summary: asText(value?.summary, 500),
    apps: asNumber(value?.apps),
    skipped: asNumber(value?.skipped),
    events: asNumber(value?.events),
    cloudUsage: asNumber(value?.cloud_usage),
  };
}

export function ingestLines(snapshot: IngestSnapshot): string[] {
  const counts = [
    snapshot.apps !== null ? unit(snapshot.apps, "app") : null,
    snapshot.events !== null ? unit(snapshot.events, "event") : null,
    snapshot.cloudUsage !== null ? unit(snapshot.cloudUsage, "usage reading") : null,
    snapshot.skipped !== null ? `${unit(snapshot.skipped, "app")} skipped` : null,
  ].filter((part) => part !== null);
  return counts.length > 0 ? [`Recorded ${counts.join(", ")}.`] : [];
}
