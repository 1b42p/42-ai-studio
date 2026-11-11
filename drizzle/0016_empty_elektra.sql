CREATE TABLE "sandbox_task_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_session_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"call_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"generation" integer NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "sandbox_wait_turns_identity_idx";--> statement-breakpoint
ALTER TABLE "sandbox_wait_turns" ADD COLUMN "scope_id" text DEFAULT 'root' NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_task_calls" ADD CONSTRAINT "sandbox_task_calls_app_session_id_app_sessions_id_fk" FOREIGN KEY ("app_session_id") REFERENCES "public"."app_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_task_calls_identity_idx" ON "sandbox_task_calls" USING btree ("app_session_id","call_id");--> statement-breakpoint
CREATE INDEX "sandbox_task_calls_task_idx" ON "sandbox_task_calls" USING btree ("app_session_id","task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_wait_turns_identity_idx" ON "sandbox_wait_turns" USING btree ("app_session_id","scope_id","turn_id");