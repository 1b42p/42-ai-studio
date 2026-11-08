/**
 * HTTP-тесты: запускают настоящее приложение и ходят в него по HTTP.
 * Запуск — одной командой `npm run test:http` после `docker compose up -d`.
 */
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Тот же псевдоним, что у приложения: канал eve импортирует серверные
    // модули через `@/`, и тесты читают этот файл напрямую.
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "http",
          include: ["tests/http/**/*.test.ts"],
          exclude: ["tests/http/documents.test.ts"],
          globalSetup: ["tests/http/global-setup.ts"],
          // Перед каждым HTTP-файлом: resetDatabase() и очистка бакета.
          setupFiles: ["tests/http/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "documents",
          include: ["tests/http/documents.test.ts"],
          // Проверка файлов не требует приложения, Postgres или S3.
          globalSetup: [],
          setupFiles: [],
        },
      },
    ],
    // resetDatabase() перед каждым файлом требует последовательного прогона.
    fileParallelism: false,
    // Холодный старт next dev вместе с eve занимает до 180 с.
    hookTimeout: 240_000,
    testTimeout: 30_000,
    teardownTimeout: 60_000,
  },
});
