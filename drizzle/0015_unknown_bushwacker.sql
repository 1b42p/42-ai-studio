CREATE TABLE "sandbox_wait_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_session_id" uuid NOT NULL,
	"turn_id" text NOT NULL,
	"generation" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_session_id" uuid NOT NULL,
	"eve_session_id" text NOT NULL,
	"turn_id" text,
	"turn_sequence" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'idle' NOT NULL,
	"event_id" text,
	CONSTRAINT "sandbox_workers_eve_session_id_unique" UNIQUE("eve_session_id")
);
--> statement-breakpoint
ALTER TABLE "app_sessions" ADD COLUMN "sandbox_wait_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD COLUMN "wait_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "wait_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "launch_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_wait_turns" ADD CONSTRAINT "sandbox_wait_turns_app_session_id_app_sessions_id_fk" FOREIGN KEY ("app_session_id") REFERENCES "public"."app_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_workers" ADD CONSTRAINT "sandbox_workers_app_session_id_app_sessions_id_fk" FOREIGN KEY ("app_session_id") REFERENCES "public"."app_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_wait_turns_identity_idx" ON "sandbox_wait_turns" USING btree ("app_session_id","turn_id");--> statement-breakpoint
CREATE INDEX "sandbox_workers_busy_idx" ON "sandbox_workers" USING btree ("app_session_id","state");