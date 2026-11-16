CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"slug" text NOT NULL,
	"url" text NOT NULL,
	"auth_kind" text NOT NULL,
	"credentials_encrypted" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_user_name_idx" ON "mcp_servers" USING btree ("user_id","name_key");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_user_slug_idx" ON "mcp_servers" USING btree ("user_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_user_url_idx" ON "mcp_servers" USING btree ("user_id","url");