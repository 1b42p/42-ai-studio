ALTER TABLE "app_sessions" ADD COLUMN "sandbox_work_state" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_sessions" ADD COLUMN "sandbox_work_turn_id" text;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "maintenance_token" uuid;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "maintenance_until" timestamp with time zone;