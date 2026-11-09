export type Status =
  | "shipped"
  | "unknown"
  | "live"
  | "healthy"
  | "building"
  | "degraded"
  | "blocked"
  | "down"
  | "failed"
  | "passed"
  | "not-started"
  | "up"
  | "parked";

const config: Record<Status, { label: string; className: string; dot: string }> = {
  shipped: {
    label: "Shipped",
    className: "bg-live-soft text-live",
    dot: "bg-live",
  },
  unknown: {
    label: "Unknown",
    className: "bg-idle-soft text-idle",
    dot: "bg-idle",
  },
  live: { label: "Live", className: "bg-live-soft text-live", dot: "bg-live" },
  healthy: {
    label: "Healthy",
    className: "bg-live-soft text-live",
    dot: "bg-live",
  },
  passed: {
    label: "Passed",
    className: "bg-live-soft text-live",
    dot: "bg-live",
  },
  building: {
    label: "Building",
    className: "bg-building-soft text-building",
    dot: "bg-building",
  },
  degraded: {
    label: "Degraded",
    className: "bg-building-soft text-building",
    dot: "bg-building",
  },
  blocked: {
    label: "Blocked",
    className: "bg-blocked-soft text-blocked",
    dot: "bg-blocked",
  },
  down: {
    label: "Down",
    className: "bg-blocked-soft text-blocked",
    dot: "bg-blocked",
  },
  failed: {
    label: "Failed",
    className: "bg-blocked-soft text-blocked",
    dot: "bg-blocked",
  },
  // Up and Down (parked) are running states. Parked is yellow: a cost decision, not an outage.
  up: { label: "Up", className: "bg-live-soft text-live", dot: "bg-live" },
  parked: { label: "Down", className: "bg-building-soft text-building", dot: "bg-building" },
  // Not started is neutral on purpose: it is a plan, not a problem.
  "not-started": {
    label: "Not started",
    className: "bg-idle-soft text-idle",
    dot: "bg-idle",
  },
};

/** Status and health label. Always shows text, so color is never the only signal. */
export function StatusBadge({ status, label, title }: { status: Status; label?: string; title?: string }) {
  const c = config[status];
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-sm font-medium ${c.className}`}
    >
      <span aria-hidden className={`size-2 rounded-full ${c.dot}`} />
      {label ?? c.label}
    </span>
  );
}
