CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"app_session_id" uuid,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"source_key" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_kind_check" CHECK ("usage_records"."kind" in ('sandbox_seconds', 'model_input_tokens', 'model_output_tokens')),
	CONSTRAINT "usage_records_amount_positive" CHECK ("usage_records"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "running_since" timestamp (3) with time zone;--> statement-breakpoint
UPDATE "sandboxes" SET "running_since" = coalesce("last_active_at", now()) WHERE "state" = 'started';--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_app_session_id_app_sessions_id_fk" FOREIGN KEY ("app_session_id") REFERENCES "public"."app_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_kind_source_idx" ON "usage_records" USING btree ("kind","source_key");--> statement-breakpoint
CREATE INDEX "usage_records_recorded_at_idx" ON "usage_records" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "usage_records_user_recorded_at_idx" ON "usage_records" USING btree ("user_id","recorded_at");
