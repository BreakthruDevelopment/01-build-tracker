import { describe, expect, it } from "vitest";
import { canTransition, requiresReason, STATUSES, type Status, type StatusActor } from "./status";

// The spec table, written out independently of the implementation.
const ALLOWED: Record<string, StatusActor[]> = {
  "planned>building": ["system", "admin"],
  "building>live": ["system", "admin"],
  "live>shipped": ["admin"],
  "live>building": ["admin"],
  "shipped>live": ["admin"],
  "planned>blocked": ["admin"],
  "building>blocked": ["admin"],
  "live>blocked": ["admin"],
};
const REASON = new Set(["live>building", "shipped>live", "planned>blocked", "building>blocked", "live>blocked"]);
const ACTORS: StatusActor[] = ["system", "admin"];

describe("canTransition: full matrix without blocked_from", () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      for (const actor of ACTORS) {
        const key = `${from}>${to}`;
        const expected =
          from === "blocked"
            ? actor === "admin" && ["planned", "building", "live"].includes(to)
            : (ALLOWED[key] ?? []).includes(actor);
        it(`${actor}: ${from} -> ${to} is ${expected ? "allowed" : "rejected"}`, () => {
          expect(canTransition(from, to, actor)).toBe(expected);
        });
      }
    }
  }
});

describe("blocked restores only the stored state", () => {
  const restorable: Status[] = ["planned", "building", "live"];
  for (const stored of restorable) {
    for (const to of STATUSES) {
      it(`blocked_from=${stored}: admin blocked -> ${to} is ${to === stored ? "allowed" : "rejected"}`, () => {
        expect(canTransition("blocked", to, "admin", stored)).toBe(to === stored);
      });
      it(`blocked_from=${stored}: system blocked -> ${to} is rejected`, () => {
        expect(canTransition("blocked", to, "system", stored)).toBe(false);
      });
    }
  }
});

describe("requiresReason", () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const key = `${from}>${to}`;
      it(`${key}: ${REASON.has(key) ? "needs" : "does not need"} a reason`, () => {
        expect(requiresReason(from, to)).toBe(REASON.has(key));
      });
    }
  }
});
