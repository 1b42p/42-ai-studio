CREATE TYPE "public"."bash_job_status" AS ENUM('running', 'completed', 'interrupted');--> statement-breakpoint
CREATE TABLE "bash_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_session_id" uuid NOT NULL,
	"job_id" text NOT NULL,
	"status" "bash_job_status" NOT NULL,
	"exit_code" integer,
	"stdout_tail" text DEFAULT '' NOT NULL,
	"stderr_tail" text DEFAULT '' NOT NULL,
	"stdout_bytes" bigint DEFAULT 0 NOT NULL,
	"stderr_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bash_jobs" ADD CONSTRAINT "bash_jobs_app_session_id_app_sessions_id_fk" FOREIGN KEY ("app_session_id") REFERENCES "public"."app_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bash_jobs_app_session_job_idx" ON "bash_jobs" USING btree ("app_session_id","job_id");