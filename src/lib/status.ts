/**
 * The app status state machine, pure and free of I/O so every pair can be tested.
 * Spec: ai-dev-os/specs/01-build-tracker.md, "Status state machine".
 */

export const STATUSES = ["planned", "building", "live", "shipped", "blocked"] as const;
export type Status = (typeof STATUSES)[number];

/** States an app can be blocked from, and therefore restored to. */
export const RESTORABLE = ["planned", "building", "live"] as const satisfies readonly Status[];

export type StatusActor = "system" | "admin";

type Rule = { actors: readonly StatusActor[]; reason: boolean };

const BOTH = ["system", "admin"] as const;
const ADMIN = ["admin"] as const;

/** Every allowed (from, to) pair other than leaving `blocked`. Anything absent is rejected. */
const RULES: Partial<Record<Status, Partial<Record<Status, Rule>>>> = {
  planned: {
    building: { actors: BOTH, reason: false },
    blocked: { actors: ADMIN, reason: true },
  },
  building: {
    live: { actors: BOTH, reason: false },
    blocked: { actors: ADMIN, reason: true },
  },
  live: {
    shipped: { actors: ADMIN, reason: false },
    building: { actors: ADMIN, reason: true },
    blocked: { actors: ADMIN, reason: true },
  },
  shipped: {
    live: { actors: ADMIN, reason: true },
  },
};

/**
 * Is `from` to `to` allowed for this actor? Leaving `blocked` is admin-only and only to the
 * stored `blockedFrom` state; pass it when known. Without it, any restorable state passes
 * (the data layer always supplies it).
 */
export function canTransition(
  from: Status,
  to: Status,
  actor: StatusActor,
  blockedFrom?: Status | null,
): boolean {
  if (from === "blocked") {
    if (actor !== "admin") return false;
    if (blockedFrom) return to === blockedFrom && (RESTORABLE as readonly Status[]).includes(to);
    return (RESTORABLE as readonly Status[]).includes(to);
  }
  const rule = RULES[from]?.[to];
  return !!rule && rule.actors.includes(actor);
}

/** Does this move need a written reason (rollback, rework, blocking)? Public in the history. */
export function requiresReason(from: Status, to: Status): boolean {
  if (from === "blocked") return false;
  return RULES[from]?.[to]?.reason ?? false;
}
