CREATE TYPE "public"."media_kind" AS ENUM('upload', 'tool_media', 'message_file', 'preview');--> statement-breakpoint
CREATE TYPE "public"."message_file_reason" AS ENUM('not_found', 'outside_workspace', 'too_large', 'too_many', 'copy_failed');--> statement-breakpoint
CREATE TYPE "public"."message_file_state" AS ENUM('copying', 'ready', 'missing');--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"app_session_id" uuid NOT NULL,
	"kind" "media_kind" NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"original_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_session_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"sandbox_path" text NOT NULL,
	"media_id" uuid,
	"state" "message_file_state" NOT NULL,
	"reason" "message_file_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_call_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_session_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"sandbox_path" text NOT NULL,
	"media_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_app_session_id_app_sessions_id_fk" FOREIGN KEY ("app_session_id") REFERENCES "public"."app_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_files" ADD CONSTRAINT "message_files_app_session_id_app_sessions_id_fk" FOREIGN KEY ("app_session_id") REFERENCES "public"."app_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_files" ADD CONSTRAINT "message_files_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_media" ADD CONSTRAINT "tool_call_media_app_session_id_app_sessions_id_fk" FOREIGN KEY ("app_session_id") REFERENCES "public"."app_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_media" ADD CONSTRAINT "tool_call_media_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_files_message_path_idx" ON "message_files" USING btree ("app_session_id","message_id","sandbox_path");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_media_call_path_idx" ON "tool_call_media" USING btree ("app_session_id","call_id","sandbox_path");