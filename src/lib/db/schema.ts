import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth with the admin plugin).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Build Tracker domain tables. See ai-dev-os/specs/01-build-tracker.md.
// ---------------------------------------------------------------------------

export const appStatus = pgEnum("app_status", [
  "planned",
  "building",
  "live",
  "shipped",
  "blocked",
]);
export const cloudName = pgEnum("cloud_name", ["aws", "azure", "gcp", "oci"]);
export const healthState = pgEnum("health_state", ["ok", "degraded", "down", "unknown"]);
export const eventSource = pgEnum("event_source", ["github", "health", "ops_monitor", "admin"]);
export const summaryHealth = pgEnum("summary_health", ["green", "amber", "red"]);

/** One row per portfolio app (n = 1..30). Admin-written portfolio data, public to read. */
export const app = pgTable(
  "app",
  {
    n: integer("n").primaryKey(),
    repo: text("repo").notNull().unique(),
    name: text("name").notNull(),
    subdomain: text("subdomain").notNull(),
    liveCloud: cloudName("live_cloud").notNull(),
    status: appStatus("status").notNull().default("planned"),
    /** The state to restore when leaving `blocked`. */
    blockedFrom: appStatus("blocked_from"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
    healthUrl: text("health_url"),
    // Denormalized "now" columns so the board is one cheap query.
    health: healthState("health").notNull().default("unknown"),
    healthVersion: text("health_version"),
    healthMs: integer("health_ms"),
    healthAt: timestamp("health_at", { withTimezone: true }),
    lastPushAt: timestamp("last_push_at", { withTimezone: true }),
    ciConclusion: text("ci_conclusion"),
    ciWorkflow: text("ci_workflow"),
    ciUrl: text("ci_url"),
    ciAt: timestamp("ci_at", { withTimezone: true }),
  },
  (t) => [
    check("app_n_range", sql`${t.n} between 1 and 30`),
    index("app_status_idx").on(t.status),
  ],
);

/** Allow-listed facts from GitHub, health polls, the ops monitor and admin actions. Never raw payloads. */
export const appEvent = pgTable(
  "app_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appN: integer("app_n")
      .notNull()
      .references(() => app.n, { onDelete: "cascade" }),
    source: eventSource("source").notNull(),
    kind: text("kind").notNull(),
    /** X-GitHub-Delivery; makes webhook handling idempotent. Null for non-webhook events. */
    deliveryId: text("delivery_id").unique(),
    title: text("title").notNull(),
    url: text("url"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("app_event_title_len", sql`char_length(${t.title}) <= 200`),
    index("app_event_app_occurred_idx").on(t.appN, t.occurredAt.desc()),
  ],
);

/** Public status history. actor_id null = the system; set null if the admin account is deleted. */
export const statusTransition = pgTable(
  "status_transition",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appN: integer("app_n")
      .notNull()
      .references(() => app.n, { onDelete: "cascade" }),
    fromStatus: appStatus("from_status").notNull(),
    toStatus: appStatus("to_status").notNull(),
    reason: text("reason"),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("status_transition_reason_len", sql`char_length(${t.reason}) <= 500`),
    index("status_transition_app_created_idx").on(t.appN, t.createdAt.desc()),
    index("status_transition_actor_idx").on(t.actorId),
  ],
);

/** Admin-only private notes; only the author may edit or delete. Removed with the author. */
export const note = pgTable(
  "note",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appN: integer("app_n")
      .notNull()
      .references(() => app.n, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("note_body_len", sql`char_length(${t.body}) between 1 and 2000`),
    index("note_app_created_idx").on(t.appN, t.createdAt.desc()),
    index("note_author_idx").on(t.authorId),
  ],
);

/** Free-tier usage reported by the ops monitor; the latest row per (cloud, metric) feeds flags. */
export const cloudUsage = pgTable(
  "cloud_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cloud: cloudName("cloud").notNull(),
    metric: text("metric").notNull(),
    usedPct: integer("used_pct").notNull(),
    chargeCents: integer("charge_cents").notNull().default(0),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("cloud_usage_pct_range", sql`${t.usedPct} between 0 and 100`),
    check("cloud_usage_charge_nonneg", sql`${t.chargeCents} >= 0`),
    index("cloud_usage_latest_idx").on(t.cloud, t.metric, t.reportedAt.desc()),
  ],
);

/** The daily AI summary cache: one row per app per day. */
export const healthSummary = pgTable(
  "health_summary",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appN: integer("app_n")
      .notNull()
      .references(() => app.n, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    health: summaryHealth("health").notNull(),
    summary: text("summary").notNull(),
    flags: jsonb("flags")
      .$type<{ kind: string; detail: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    demo: boolean("demo").notNull().default(false),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last (re)generation; the regenerate limit of one per app per hour is measured from here. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("health_summary_app_day_uq").on(t.appN, t.day)],
);

/**
 * Tiny key-value store for machine bookkeeping that /admin shows later: `last_sync` and
 * `last_ingest`, each `{ at: ISO time, ...small summary }`. Never holds secrets or payloads.
 */
export const trackerState = pgTable("tracker_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof user.$inferSelect;
export type App = typeof app.$inferSelect;
export type AppEvent = typeof appEvent.$inferSelect;
export type StatusTransition = typeof statusTransition.$inferSelect;
export type Note = typeof note.$inferSelect;
export type CloudUsage = typeof cloudUsage.$inferSelect;
export type HealthSummary = typeof healthSummary.$inferSelect;
