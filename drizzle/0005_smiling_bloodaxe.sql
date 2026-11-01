CREATE TYPE "public"."sandbox_state" AS ENUM('starting', 'started', 'stopped', 'archived', 'gone');--> statement-breakpoint
CREATE TABLE "daytona_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"usage" jsonb,
	"usage_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_session_id" uuid NOT NULL,
	"daytona_key_id" uuid NOT NULL,
	"daytona_sandbox_id" text NOT NULL,
	"state" "sandbox_state" NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandboxes_app_session_id_unique" UNIQUE("app_session_id")
);
--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_app_session_id_app_sessions_id_fk" FOREIGN KEY ("app_session_id") REFERENCES "public"."app_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_daytona_key_id_daytona_keys_id_fk" FOREIGN KEY ("daytona_key_id") REFERENCES "public"."daytona_keys"("id") ON DELETE no action ON UPDATE no action;