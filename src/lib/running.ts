import type { ServiceHealth } from "@/lib/format";

/**
 * Up / Down: whether an app is meant to be running. Pure functions, shared by the data layer, sync and the UI.
 *
 * Why it exists: Azure Container Apps scale to zero, and every health ping wakes a replica that Azure bills for
 * several minutes. So Azure apps are Down ("parked") by default: sync never contacts them and the board says so.
 * Down is a cost decision, not an outage.
 */

export type Running = "up" | "down";
export type Cloud = "aws" | "azure" | "gcp" | "oci";

/** Azure apps are parked by default; every other cloud is up. */
export function defaultRunning(cloud: Cloud): Running {
  return cloud === "azure" ? "down" : "up";
}

/** The state that counts: the admin's override if there is one, otherwise the default for the cloud. */
export function effectiveRunning(cloud: Cloud, override: Running | null): Running {
  return override ?? defaultRunning(cloud);
}

/**
 * Parked means sync makes no request at all. An admin's explicit Down is always honoured, whatever the status.
 * Down only by default (Azure) does not park a planned app (a healthy deployment is what promotes it) or a
 * building app (it must be checked to be verified live); once live it is parked.
 */
export function isParked(app: { status: string; liveCloud: Cloud; runningOverride: Running | null }): boolean {
  if (effectiveRunning(app.liveCloud, app.runningOverride) !== "down") return false;
  if (app.runningOverride === "down") return true;
  return app.status !== "planned" && app.status !== "building";
}

export const PARKED_HINT = "Parked: not checked, wakes on first visit";
export const PARKED_SUB = "Parked to save cost";

export type RunningView = {
  label: "Up" | "Down";
  /** Visual tone: `up` is green, `down` is yellow (parked, not an outage). */
  tone: Running;
  /** Tooltip text; the same words are also shown as visible subtext where there is room. */
  hint: string;
  sub: string | null;
};

export function runningView(app: { running: Running; parked: boolean; overridden?: boolean }): RunningView {
  if (app.running === "up") {
    return { label: "Up", tone: "up", hint: app.overridden ? "Up (set by an admin)" : "Up: checked by sync", sub: null };
  }
  if (app.parked) return { label: "Down", tone: "down", hint: PARKED_HINT, sub: PARKED_SUB };
  return {
    label: "Down",
    tone: "down",
    hint: "Parked by default, but still checked until it goes live",
    sub: "Checked until it goes live",
  };
}

const HEALTH_LABEL: Record<ServiceHealth, string> = { ok: "Healthy", degraded: "Degraded", down: "Down", unknown: "Unknown" };

/** What the Health column says. A parked app's stored health is not current, so it is shown as not checked. */
export function healthView(health: ServiceHealth, parked: boolean): { label: string; neutral: boolean } {
  if (parked) return { label: "Not checked (parked)", neutral: true };
  return { label: HEALTH_LABEL[health], neutral: false };
}
