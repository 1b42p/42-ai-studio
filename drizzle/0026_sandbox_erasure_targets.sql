CREATE TABLE "sandbox_erasure_targets" (
	"app_session_id" uuid NOT NULL,
	"daytona_key_id" uuid NOT NULL,
	"daytona_sandbox_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandbox_erasure_targets" ADD CONSTRAINT "sandbox_erasure_targets_app_session_id_app_sessions_id_fk" FOREIGN KEY ("app_session_id") REFERENCES "public"."app_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_erasure_targets" ADD CONSTRAINT "sandbox_erasure_targets_daytona_key_id_daytona_keys_id_fk" FOREIGN KEY ("daytona_key_id") REFERENCES "public"."daytona_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_erasure_targets_identity_idx" ON "sandbox_erasure_targets" USING btree ("app_session_id","daytona_key_id","daytona_sandbox_id");--> statement-breakpoint
CREATE INDEX "sandbox_erasure_targets_machine_idx" ON "sandbox_erasure_targets" USING btree ("daytona_key_id","daytona_sandbox_id");
--> statement-breakpoint
CREATE FUNCTION "track_sandbox_erasure_target"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF (NEW.daytona_key_id, NEW.daytona_sandbox_id, NEW.launch_started_at)
			IS NOT DISTINCT FROM (OLD.daytona_key_id, OLD.daytona_sandbox_id, OLD.launch_started_at) THEN
			RETURN NEW;
		END IF;
	END IF;
	IF NEW.daytona_sandbox_id <> '' THEN
		DELETE FROM sandbox_erasure_targets
		WHERE app_session_id = NEW.app_session_id AND daytona_key_id = NEW.daytona_key_id
			AND daytona_sandbox_id = '';
	ELSIF NEW.starting_kind IS DISTINCT FROM 'create' OR NEW.launch_started_at IS NULL THEN
		RETURN NEW;
	END IF;
	INSERT INTO sandbox_erasure_targets (app_session_id, daytona_key_id, daytona_sandbox_id)
	VALUES (NEW.app_session_id, NEW.daytona_key_id, NEW.daytona_sandbox_id)
	ON CONFLICT DO NOTHING;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "track_sandbox_erasure_target"
AFTER INSERT OR UPDATE OF "daytona_key_id", "daytona_sandbox_id", "launch_started_at" ON "sandboxes"
FOR EACH ROW EXECUTE FUNCTION "track_sandbox_erasure_target"();
--> statement-breakpoint
-- CREATE TRIGGER блокирует записи в sandboxes до коммита этой миграции.
INSERT INTO "sandbox_erasure_targets" ("app_session_id", "daytona_key_id", "daytona_sandbox_id")
SELECT "app_session_id", "daytona_key_id", "daytona_sandbox_id" FROM "sandboxes"
WHERE "daytona_sandbox_id" <> '' OR ("starting_kind" = 'create' AND "launch_started_at" IS NOT NULL);
