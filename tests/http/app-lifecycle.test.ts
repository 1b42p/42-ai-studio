/**
 * Жизненный цикл экземпляров: остановка при отсутствующей переменной и
 * параллельная работа двух `next dev` без конфликта `.next/dev/lock`.
 */
import { spawnSync } from "node:child_process";
import net from "node:net";

import { inject } from "vitest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fetchApp, startApp, type AppHandle } from "./support/app";

describe("отсутствующая переменная останавливает запуск", () => {
  let app: AppHandle;

  beforeAll(async () => {
    app = await startApp({ env: { DATABASE_URL: "" }, expectExit: true });
  });

  test("процесс завершается с ненулевым кодом", async () => {
    expect(await app.exited).not.toBe(0);
  });

  test("вывод называет переменную", () => {
    expect(app.output()).toContain("DATABASE_URL");
  });
});

describe("предел загрузки больше 5 ГиБ останавливает запуск", () => {
  let app: AppHandle;

  beforeAll(async () => {
    app = await startApp({ env: { UPLOAD_MAX_BYTES: "6000000000" }, expectExit: true });
  });

  test("процесс завершается с ненулевым кодом", async () => {
    expect(await app.exited).not.toBe(0);
  });

  test("вывод называет переменную", () => {
    expect(app.output()).toContain("UPLOAD_MAX_BYTES");
  });
});

describe("таймаут готовности не оставляет процесс", () => {
  test("startApp с нулевым таймаутом отклоняется и освобождает порт", async () => {
    const port = Number(new URL(inject("appUrl")).port) + 50;

    // Ноль не зависит от скорости машины: с одним секундным пределом тёплый
    // `next dev` успевает ответить и проверка становится ложноположительной.
    await expect(startApp({ port, readyTimeoutMs: 0 })).rejects.toThrow(/0 мс/);

    const leftover = spawnSync("pgrep", ["-f", `dev --port ${port}`], { encoding: "utf8" });
    expect(leftover.stdout.trim()).toBe("");
    expect(await canListen(port)).toBe(true);
  });
});

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

describe("два экземпляра работают одновременно", () => {
  let second: AppHandle;

  beforeAll(async () => {
    second = await startApp();
  });

  afterAll(async () => {
    await second.stop();
  });

  test("основной экземпляр отвечает", async () => {
    const response = await fetchApp("/api/health");

    expect(response.status).toBe(200);
  });

  test("второй экземпляр отвечает со своего порта", async () => {
    const response = await fetch(`${second.url}/api/health`, { redirect: "manual" });

    expect(second.port).not.toBe(Number(new URL(inject("appUrl")).port));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      checks: { database: "ok", storage: "ok" },
    });
  });
});
