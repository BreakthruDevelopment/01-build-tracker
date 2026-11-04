CREATE TYPE "public"."app_status" AS ENUM('planned', 'building', 'live', 'shipped', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."cloud_name" AS ENUM('aws', 'azure', 'gcp', 'oci');--> statement-breakpoint
CREATE TYPE "public"."event_source" AS ENUM('github', 'health', 'ops_monitor', 'admin');--> statement-breakpoint
CREATE TYPE "public"."health_state" AS ENUM('ok', 'degraded', 'down', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."summary_health" AS ENUM('green', 'amber', 'red');--> statement-breakpoint
CREATE TABLE "app" (
	"n" integer PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"name" text NOT NULL,
	"subdomain" text NOT NULL,
	"live_cloud" "cloud_name" NOT NULL,
	"status" "app_status" DEFAULT 'planned' NOT NULL,
	"blocked_from" "app_status",
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"health_url" text,
	"health" "health_state" DEFAULT 'unknown' NOT NULL,
	"health_version" text,
	"health_ms" integer,
	"health_at" timestamp with time zone,
	"last_push_at" timestamp with time zone,
	"ci_conclusion" text,
	"ci_workflow" text,
	"ci_url" text,
	"ci_at" timestamp with time zone,
	CONSTRAINT "app_repo_unique" UNIQUE("repo"),
	CONSTRAINT "app_n_range" CHECK ("app"."n" between 1 and 30)
);
--> statement-breakpoint
CREATE TABLE "app_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_n" integer NOT NULL,
	"source" "event_source" NOT NULL,
	"kind" text NOT NULL,
	"delivery_id" text,
	"title" text NOT NULL,
	"url" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_event_delivery_id_unique" UNIQUE("delivery_id"),
	CONSTRAINT "app_event_title_len" CHECK (char_length("app_event"."title") <= 200)
);
--> statement-breakpoint
CREATE TABLE "cloud_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud" "cloud_name" NOT NULL,
	"metric" text NOT NULL,
	"used_pct" integer NOT NULL,
	"charge_cents" integer DEFAULT 0 NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_usage_pct_range" CHECK ("cloud_usage"."used_pct" between 0 and 100),
	CONSTRAINT "cloud_usage_charge_nonneg" CHECK ("cloud_usage"."charge_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "health_summary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_n" integer NOT NULL,
	"day" date NOT NULL,
	"health" "summary_health" NOT NULL,
	"summary" text NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"demo" boolean DEFAULT false NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_n" integer NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_body_len" CHECK (char_length("note"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "status_transition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_n" integer NOT NULL,
	"from_status" "app_status" NOT NULL,
	"to_status" "app_status" NOT NULL,
	"reason" text,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_transition_reason_len" CHECK (char_length("status_transition"."reason") <= 500)
);
--> statement-breakpoint
DROP TABLE "item" CASCADE;--> statement-breakpoint
ALTER TABLE "app_event" ADD CONSTRAINT "app_event_app_n_app_n_fk" FOREIGN KEY ("app_n") REFERENCES "public"."app"("n") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_summary" ADD CONSTRAINT "health_summary_app_n_app_n_fk" FOREIGN KEY ("app_n") REFERENCES "public"."app"("n") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_app_n_app_n_fk" FOREIGN KEY ("app_n") REFERENCES "public"."app"("n") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_transition" ADD CONSTRAINT "status_transition_app_n_app_n_fk" FOREIGN KEY ("app_n") REFERENCES "public"."app"("n") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_transition" ADD CONSTRAINT "status_transition_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_status_idx" ON "app" USING btree ("status");--> statement-breakpoint
CREATE INDEX "app_event_app_occurred_idx" ON "app_event" USING btree ("app_n","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cloud_usage_latest_idx" ON "cloud_usage" USING btree ("cloud","metric","reported_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "health_summary_app_day_uq" ON "health_summary" USING btree ("app_n","day");--> statement-breakpoint
CREATE INDEX "note_app_created_idx" ON "note" USING btree ("app_n","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "note_author_idx" ON "note" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "status_transition_app_created_idx" ON "status_transition" USING btree ("app_n","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "status_transition_actor_idx" ON "status_transition" USING btree ("actor_id");