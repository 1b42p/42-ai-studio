CREATE TABLE "pending_sandbox_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"app_session_id" uuid,
	"source_key" text NOT NULL,
	"amount" bigint NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pending_sandbox_usage_source_key_unique" UNIQUE("source_key"),
	CONSTRAINT "pending_sandbox_usage_amount_positive" CHECK ("pending_sandbox_usage"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "pending_sandbox_usage" ADD CONSTRAINT "pending_sandbox_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_sandbox_usage" ADD CONSTRAINT "pending_sandbox_usage_app_session_id_app_sessions_id_fk" FOREIGN KEY ("app_session_id") REFERENCES "public"."app_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_sandbox_usage_user_idx" ON "pending_sandbox_usage" USING btree ("user_id");