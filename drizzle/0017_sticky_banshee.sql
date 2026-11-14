CREATE TABLE "session_preview_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_session_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"sandbox_path" text NOT NULL,
	"result" jsonb NOT NULL,
	"replaced_media_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_sessions" ADD COLUMN "preview_media_id" uuid;--> statement-breakpoint
ALTER TABLE "session_preview_calls" ADD CONSTRAINT "session_preview_calls_app_session_id_app_sessions_id_fk" FOREIGN KEY ("app_session_id") REFERENCES "public"."app_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_preview_calls_identity_idx" ON "session_preview_calls" USING btree ("app_session_id","call_id","sandbox_path");--> statement-breakpoint
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_preview_media_id_media_id_fk" FOREIGN KEY ("preview_media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;