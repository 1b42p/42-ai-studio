/**
 * Выполняется перед каждым тестовым файлом: база очищается через
 * `resetDatabase()`, бакет — через `deletePrefix("")`. После файла подключение
 * к базе закрывается, чтобы процесс воркера завершался чисто.
 */
import { afterAll } from "vitest";

import { closeDb } from "../../lib/db/client";
import { resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import { s3 } from "./support/s3";

await resetDatabase();
await fakeSandbox.reset();
await s3().deletePrefix("");

afterAll(async () => {
  await closeDb();
});
