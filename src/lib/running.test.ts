import { describe, expect, it } from "vitest";
import {
  type AppFacts,
  SYSTEM_PROMPT,
  buildAppLine,
  evaluateRules,
  ruleOnlySummary,
} from "@/lib/ai/daily-health-summary";
import { PARKED_HINT, defaultRunning, effectiveRunning, healthView, isParked, runningView } from "./running";

describe("running state defaults", () => {
  it("is Down for Azure and Up for every other cloud", () => {
    expect(defaultRunning("azure")).toBe("down");
    for (const cloud of ["aws", "gcp", "oci"] as const) expect(defaultRunning(cloud)).toBe("up");
  });

  it("lets an override win over the default, in both directions", () => {
    expect(effectiveRunning("azure", null)).toBe("down");
    expect(effectiveRunning("azure", "up")).toBe("up");
    expect(effectiveRunning("aws", null)).toBe("up");
    expect(effectiveRunning("aws", "down")).toBe("down");
  });
});

describe("isParked", () => {
  const app = (status: string, liveCloud: "aws" | "azure", runningOverride: "up" | "down" | null) => ({ status, liveCloud, runningOverride });

  it("parks live, shipped and blocked Down apps", () => {
    for (const status of ["live", "shipped", "blocked"]) {
      expect(isParked(app(status, "azure", null))).toBe(true);
      expect(isParked(app(status, "aws", "down"))).toBe(true);
      expect(isParked(app(status, "azure", "up"))).toBe(false);
      expect(isParked(app(status, "aws", null))).toBe(false);
    }
  });

  it("keeps checking planned apps, whatever their state", () => {
    expect(isParked(app("planned", "azure", null))).toBe(false);
    expect(isParked(app("planned", "aws", "down"))).toBe(false);
  });

  it("checks a building app that is Down only by default, but honours an explicit Down", () => {
    expect(isParked(app("building", "azure", null))).toBe(false);
    expect(isParked(app("building", "aws", "down"))).toBe(true);
  });
});

describe("runningView and healthView", () => {
  it("labels Up and Down in words, with the parked explanation", () => {
    expect(runningView({ running: "up", parked: false })).toMatchObject({ label: "Up", tone: "up", sub: null });
    expect(runningView({ running: "down", parked: true })).toMatchObject({
      label: "Down",
      tone: "down",
      hint: PARKED_HINT,
      sub: "Parked to save cost",
    });
    expect(PARKED_HINT).toBe("Parked: not checked, wakes on first visit");
  });

  it("explains a Down app that is still being checked until it goes live", () => {
    expect(runningView({ running: "down", parked: false }).sub).toBe("Checked until it goes live");
  });

  it("shows a parked app's health as not checked, and others as stored", () => {
    expect(healthView("ok", true)).toEqual({ label: "Not checked (parked)", neutral: true });
    expect(healthView("down", true).label).toBe("Not checked (parked)");
    expect(healthView("down", false)).toEqual({ label: "Down", neutral: false });
    expect(healthView("ok", false).label).toBe("Healthy");
  });
});

describe("AI summary input treats parked apps as parked", () => {
  const NOW = new Date("2026-11-04T12:00:00Z");
  const facts: AppFacts = {
    n: 6,
    name: "Read Later",
    status: "live",
    statusChangedAt: NOW,
    health: "parked",
    healthVersion: null,
    lastPushAt: NOW,
    ciConclusion: "success",
    ciWorkflow: "ci",
    liveCloud: "azure",
    eventTitles: [],
    stalled: [],
    usage: [],
  };

  it("raises no health flag for a parked live app", () => {
    expect(evaluateRules(facts, NOW)).toEqual({ floor: "green", flags: [] });
  });

  it("says parked in the rule-only text and in the prompt line, never unknown or down", () => {
    const summary = ruleOnlySummary(facts, evaluateRules(facts, NOW)).summary;
    expect(summary).toContain("parked to save cost");
    expect(summary).not.toMatch(/unknown|down/i);
    expect(JSON.parse(buildAppLine(facts, evaluateRules(facts, NOW), NOW)).health).toBe("parked");
    expect(SYSTEM_PROMPT).toContain('"parked" means the app is deliberately switched off');
  });
});
