CREATE TABLE "session_deletion_retries" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_deletions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "app_sessions_user_list_idx";--> statement-breakpoint
ALTER TABLE "app_sessions" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_deletion_retries" ADD CONSTRAINT "session_deletion_retries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_deletions" ADD CONSTRAINT "session_deletions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_deletions_user_idx" ON "session_deletions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "app_sessions_user_list_idx" ON "app_sessions" USING btree ("user_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "app_sessions"."eve_session_id" is not null and "app_sessions"."deleted_at" is null;