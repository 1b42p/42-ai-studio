CREATE TABLE "memory_recall_snapshots" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"content" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memory" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "memory_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_recall_snapshots" ADD CONSTRAINT "memory_recall_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory" ADD CONSTRAINT "user_memory_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_recall_snapshots_created_at_idx" ON "memory_recall_snapshots" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_memory_user_text_unique" ON "user_memory" USING btree ("user_id","text");--> statement-breakpoint
CREATE INDEX "user_memory_user_id_idx" ON "user_memory" USING btree ("user_id","id");