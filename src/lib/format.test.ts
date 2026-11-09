import { describe, expect, it } from "vitest";
import {
  flagLabel,
  formatRelative,
  formatTimestamp,
  httpsUrl,
  ingestLines,
  parseStatusFilter,
  readIngestState,
  readSyncState,
  repoUrl,
  syncLines,
} from "./format";

const now = new Date("2026-11-06T12:00:00.000Z");

describe("formatRelative", () => {
  it("says just now inside 45 seconds", () => {
    expect(formatRelative(new Date("2026-11-06T11:59:20.000Z"), now)).toBe("just now");
    expect(formatRelative(now, now)).toBe("just now");
  });

  it("uses minutes, then hours through two days, then days, then a date", () => {
    expect(formatRelative(new Date("2026-11-06T11:30:00.000Z"), now)).toBe("30 minutes ago");
    expect(formatRelative(new Date("2026-11-06T11:00:00.000Z"), now)).toBe("1 hour ago");
    expect(formatRelative(new Date("2026-11-06T09:00:00.000Z"), now)).toBe("3 hours ago");
    expect(formatRelative(new Date("2026-11-05T10:00:00.000Z"), now)).toBe("26 hours ago");
    expect(formatRelative(new Date("2026-11-04T12:00:00.000Z"), now)).toBe("2 days ago");
    expect(formatRelative(new Date("2026-10-01T12:00:00.000Z"), now)).toBe("2026-10-01");
  });

  it("phrases a future time", () => {
    expect(formatRelative(new Date("2026-11-06T15:00:00.000Z"), now)).toBe("in 3 hours");
  });
});

describe("formatTimestamp", () => {
  it("prints UTC to the minute", () => {
    expect(formatTimestamp(now)).toBe("2026-11-06 12:00 UTC");
  });
});

describe("parseStatusFilter", () => {
  it("accepts a known status and ignores anything else", () => {
    expect(parseStatusFilter("live")).toBe("live");
    expect(parseStatusFilter(["blocked", "live"])).toBe("blocked");
    expect(parseStatusFilter(undefined)).toBeNull();
    expect(parseStatusFilter("shiped")).toBeNull();
    expect(parseStatusFilter("")).toBeNull();
  });
});

describe("httpsUrl and repoUrl", () => {
  it("allows https links only", () => {
    expect(httpsUrl("https://github.com/BreakthruDevelopment/01-build-tracker/actions/runs/1")).toBe(
      "https://github.com/BreakthruDevelopment/01-build-tracker/actions/runs/1",
    );
    expect(httpsUrl("http://example.com")).toBeNull();
    expect(httpsUrl("javascript:alert(1)")).toBeNull();
    expect(httpsUrl(null)).toBeNull();
  });

  it("links a catalog repo name and rejects a path", () => {
    expect(repoUrl("01-build-tracker")).toBe("https://github.com/BreakthruDevelopment/01-build-tracker");
    expect(repoUrl("BreakthruDevelopment/01-build-tracker")).toBeNull();
    expect(repoUrl("../etc")).toBeNull();
  });
});

describe("tracker state readers", () => {
  it("shows unconfirmed health failures only when there are some", () => {
    const lines = syncLines(readSyncState({ health: { checked: 5, ok: 4, down: 0, unconfirmed: 1, skipped: 0 } }));
    expect(lines).toEqual(["Health: 5 checked, 4 ok, 0 down, 1 unconfirmed, 0 skipped."]);
  });

  it("reads a partial sync blob and does not keep the catalog error text", () => {
    const snapshot = readSyncState({
      at: "2026-11-06T11:48:00.000Z",
      catalog: { updated: 0, error: "catalog sync failed: https://secret.example/token" },
      health: { ok: 12, down: 3 },
      ms: 1840,
    });
    expect(snapshot.catalogFailed).toBe(true);
    expect(snapshot.catalogUpdated).toBe(0);
    expect(syncLines(snapshot)).toEqual(["Catalog sync failed.", "Health: 12 ok, 3 down.", "Finished in 1.8s."]);
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });

  it("reads an ingest blob and caps the summary", () => {
    const snapshot = readIngestState({
      at: "2026-11-06T09:00:00.000Z",
      reported_at: "2026-11-06T03:00:00.000Z",
      summary: "x".repeat(600),
      apps: 20,
      events: 1,
      cloud_usage: 4,
      skipped: 0,
    });
    expect(snapshot.summary?.endsWith("…")).toBe(true);
    expect(snapshot.summary?.length).toBe(501);
    expect(ingestLines(snapshot)).toEqual(["Recorded 20 apps, 1 event, 4 usage readings, 0 apps skipped."]);
  });

  it("returns an empty snapshot for garbage", () => {
    expect(readSyncState(null).at).toBeNull();
    expect(syncLines(readSyncState({ catalog: "nope" }))).toEqual([]);
    expect(ingestLines(readIngestState({ summary: "   " }))).toEqual([]);
  });
});

describe("flagLabel", () => {
  it("names the known flags and leaves an unknown kind unchanged", () => {
    expect(flagLabel("failing_ci")).toBe("Failing CI");
    expect(flagLabel("free_tier")).toBe("Free tier");
    expect(flagLabel("custom")).toBe("custom");
  });
});
