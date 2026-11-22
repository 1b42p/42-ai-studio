CREATE TABLE "late_upload_cleanups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"next_attempt_at" timestamp (3) with time zone NOT NULL,
	"final_sweep_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "late_upload_cleanups_due_idx" ON "late_upload_cleanups" USING btree ("next_attempt_at","id");