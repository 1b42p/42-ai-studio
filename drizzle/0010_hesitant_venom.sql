CREATE TABLE "pending_sandbox_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"daytona_key_id" uuid NOT NULL,
	"daytona_sandbox_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_sandbox_deletions" ADD CONSTRAINT "pending_sandbox_deletions_daytona_key_id_daytona_keys_id_fk" FOREIGN KEY ("daytona_key_id") REFERENCES "public"."daytona_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_sandbox_deletions_key_sandbox_idx" ON "pending_sandbox_deletions" USING btree ("daytona_key_id","daytona_sandbox_id");