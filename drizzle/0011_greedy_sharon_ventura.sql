CREATE TYPE "public"."queue_reason" AS ENUM('capacity', 'own_session_busy');--> statement-breakpoint
CREATE TABLE "queue_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"need" "sandbox_launch" NOT NULL,
	"daytona_key_id" uuid,
	"reason" "queue_reason" DEFAULT 'capacity' NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_entries_app_session_id_unique" UNIQUE("app_session_id")
);
--> statement-breakpoint
CREATE TABLE "sandbox_dispatchers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"reconciled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "slot_request_id" uuid;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_app_session_id_app_sessions_id_fk" FOREIGN KEY ("app_session_id") REFERENCES "public"."app_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_daytona_key_id_daytona_keys_id_fk" FOREIGN KEY ("daytona_key_id") REFERENCES "public"."daytona_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "queue_entries_order_idx" ON "queue_entries" USING btree ("enqueued_at","id");