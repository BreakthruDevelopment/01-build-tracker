import { describe, expect, it } from "vitest";
import { activityAt, boardHref, boardOptions, selectBoard } from "./board-view";
import type { BoardApp } from "./tracker";

const app = (n: number, extra: Partial<BoardApp> = {}): BoardApp => ({
  n,
  name: `App ${n}`,
  repo: `repo-${n}`,
  subdomain: `app${n}.breakthruventures.ai`,
  liveCloud: "aws",
  status: "planned",
  statusChangedAt: new Date("2026-01-01"),
  health: "unknown",
  healthVersion: null,
  healthAt: null,
  running: "up",
  runningOverridden: false,
  parked: false,
  lastPushAt: null,
  ciConclusion: null,
  ciWorkflow: null,
  ciUrl: null,
  ciAt: null,
  summary: null,
  summaryHealth: null,
  summaryDemo: null,
  ...extra,
});

describe("portfolio URL filters", () => {
  const apps = [
    app(3, { status: "live", liveCloud: "gcp" }),
    app(1, {
      name: "Build Tracker",
      repo: "01-build-tracker",
      status: "building",
    }),
    app(2),
  ];
  it("defaults unknown query values and bounds search text", () => {
    expect(
      boardOptions({
        cloud: "other",
        status: "other",
        sort: "other",
        view: "other",
      }),
    ).toEqual({
      q: "",
      cloud: "all",
      status: null,
      sort: "number",
      view: "table",
    });
    expect(boardOptions({ q: ["a".repeat(120), "ignored"] }).q).toHaveLength(100);
  });
  it("searches both name and repository without case sensitivity", () => {
    expect(selectBoard(apps, boardOptions({ q: "BUILD TRACKER" })).map((a) => a.n)).toEqual([1]);
    expect(selectBoard(apps, boardOptions({ q: "01-BUILD" })).map((a) => a.n)).toEqual([1]);
  });
  it("combines cloud, status and search, and sorts by number without mutating inputs", () => {
    expect(selectBoard(apps, boardOptions({})).map((a) => a.n)).toEqual([1, 2, 3]);
    expect(apps.map((a) => a.n)).toEqual([3, 1, 2]);
    expect(selectBoard(apps, boardOptions({ cloud: "gcp", status: "live", q: "app" })).map((a) => a.n)).toEqual([3]);
    expect(selectBoard(apps, boardOptions({ cloud: "aws", status: "live" }))).toEqual([]);
  });
  it("sorts by latest health, CI, push or status activity, with stable number ties", () => {
    const rows = [
      app(3, { lastPushAt: new Date("2026-01-03") }),
      app(2, { healthAt: new Date("2026-01-04") }),
      app(1, { ciAt: new Date("2026-01-04") }),
    ];
    expect(selectBoard(rows, boardOptions({ sort: "recent" })).map((a) => a.n)).toEqual([1, 2, 3]);
    expect(activityAt(rows[0]).toISOString()).toBe("2026-01-03T00:00:00.000Z");
    expect(selectBoard(apps, boardOptions({ sort: "status" })).map((a) => a.n)).toEqual([2, 1, 3]);
  });
  it("status links preserve search, cloud, sort and view with URL encoding", () => {
    const options = boardOptions({
      q: "build & ship",
      cloud: "azure",
      sort: "recent",
      view: "cards",
      status: "planned",
    });
    const url = new URL(boardHref(options, "live"), "https://example.com");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "build & ship",
      cloud: "azure",
      sort: "recent",
      view: "cards",
      status: "live",
    });
    expect(new URL(boardHref(options, null), url).searchParams.has("status")).toBe(false);
    expect(boardHref(boardOptions({}), null)).toBe("/");
  });
});
