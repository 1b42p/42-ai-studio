DROP INDEX "app_sessions_user_updated_idx";--> statement-breakpoint
ALTER TABLE "app_sessions" ADD COLUMN "title_search" text;--> statement-breakpoint
-- lower() зависит от LC_CTYPE и в локали C не трогает кириллицу.
-- «ё» снимается до lower(), оставшаяся пропись переводится явно.
UPDATE "app_sessions" SET "title_search" = translate(lower(translate("title", 'Ёё', 'Ее')), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'абвгдеежзийклмнопрстуфхцчшщъыьэюя') WHERE "title" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "app_sessions_user_list_idx" ON "app_sessions" USING btree ("user_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "app_sessions"."eve_session_id" is not null;