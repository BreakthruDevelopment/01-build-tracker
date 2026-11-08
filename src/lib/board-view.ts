import { z } from "zod";
import { parseStatusFilter } from "@/lib/format";
import { STATUSES, type Status } from "@/lib/status";
import type { BoardApp } from "@/lib/tracker";

export type BoardQuery = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
export function boardOptions(query: BoardQuery) {
  return {
    q: (first(query.q) ?? "").trim().slice(0, 100),
    cloud: z.enum(["all", "aws", "azure", "gcp", "oci"]).catch("all").parse(first(query.cloud)),
    sort: z.enum(["number", "recent", "status"]).catch("number").parse(first(query.sort)),
    view: z.enum(["table", "cards"]).catch("table").parse(first(query.view)),
    status: parseStatusFilter(query.status),
  };
}
export type BoardOptions = ReturnType<typeof boardOptions>;

export function activityAt(app: BoardApp): Date {
  return new Date(
    Math.max(...[app.lastPushAt, app.ciAt, app.healthAt, app.statusChangedAt].map((at) => at?.getTime() ?? 0)),
  );
}

export function selectBoard(apps: BoardApp[], options: BoardOptions): BoardApp[] {
  const needle = options.q.toLowerCase();
  return apps
    .filter(
      (app) =>
        (!options.status || app.status === options.status) &&
        (options.cloud === "all" || app.liveCloud === options.cloud) &&
        (!needle || `${app.name} ${app.repo}`.toLowerCase().includes(needle)),
    )
    .sort((a, b) => {
      if (options.sort === "recent") return activityAt(b).getTime() - activityAt(a).getTime() || a.n - b.n;
      if (options.sort === "status") return STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.n - b.n;
      return a.n - b.n;
    });
}

/** Status tabs preserve all other filters, sorting, and the selected view. */
export function boardHref(options: BoardOptions, status: Status | null): string {
  const query = new URLSearchParams();
  if (options.q) query.set("q", options.q);
  if (options.cloud !== "all") query.set("cloud", options.cloud);
  if (options.sort !== "number") query.set("sort", options.sort);
  if (options.view !== "table") query.set("view", options.view);
  if (status) query.set("status", status);
  return query.size ? `/?${query}` : "/";
}
