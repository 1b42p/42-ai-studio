CREATE TYPE "public"."sandbox_launch" AS ENUM('create', 'wake', 'restore');--> statement-breakpoint
ALTER TABLE "daytona_keys" ADD COLUMN "exhausted_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "starting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "starting_kind" "sandbox_launch";