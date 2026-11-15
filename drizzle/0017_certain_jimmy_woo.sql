DROP INDEX "app_sessions_user_list_idx";--> statement-breakpoint
ALTER TABLE "app_sessions" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "app_sessions_user_list_idx" ON "app_sessions" USING btree ("user_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "app_sessions"."eve_session_id" is not null and "app_sessions"."deleted_at" is null;