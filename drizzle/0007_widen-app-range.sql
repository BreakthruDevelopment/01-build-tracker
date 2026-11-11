ALTER TABLE "app" DROP CONSTRAINT "app_n_range";--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_n_range" CHECK ("app"."n" between 1 and 40);