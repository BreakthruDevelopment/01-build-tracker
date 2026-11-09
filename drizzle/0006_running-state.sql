CREATE TYPE "public"."running_state" AS ENUM('up', 'down');--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "running_override" "running_state";--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "running_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "running_changed_by" text;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "running_reason" text;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "manual_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_running_changed_by_user_id_fk" FOREIGN KEY ("running_changed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;