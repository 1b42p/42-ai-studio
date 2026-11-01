/**
 * GET /api/sessions: только свои начатые сессии, страницы по (updated_at, id),
 * поиск по названию. Время для границ страниц вставляется SQL, включая
 * микросекунды, которые столбец округляет до миллисекунд.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";

import { getSqlClient } from "../../lib/db/client";
import { appSessions } from "../../lib/db/schema";
import { sleep } from "../../lib/sleep";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, sendAndWait } from "./support/chat";
import { createUser, db, resetDatabase } from "./support/db";

beforeEach(async () => {
  await resetDatabase();
});

interface ListItem {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListPage {
  items: ListItem[];
  nextCursor: string | null;
}

function sessionId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

async function insertSession(options: {
  id: string;
  userId: string;
  eveSessionId: string | null;
  title?: string | null;
  titleSearch?: string | null;
  createdAt: string;
  updatedAt: string;
}): Promise<void> {
  await getSqlClient()`
    insert into app_sessions (
      id, user_id, eve_session_id, title, title_search, created_at, updated_at
    ) values (
      ${options.id}::uuid,
      ${options.userId}::uuid,
      ${options.eveSessionId},
      ${options.title ?? null},
      ${options.titleSearch ?? null},
      ${options.createdAt}::timestamptz,
      ${options.updatedAt}::timestamptz
    )
  `;
}

async function readList(cookie: string, params: Record<string, string> = {}): Promise<{
  status: number;
  cacheControl: string | null;
  body: ListPage;
  errorCode: string | null;
}> {
  const search = new URLSearchParams(params);
  const query = search.toString();
  const response = await fetchApp(query === "" ? "/api/sessions" : `/api/sessions?${query}`, {
    headers: { cookie },
  });
  const payload = (await response.json()) as ListPage & {
    error?: { code: string };
  };
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: payload,
    errorCode: payload.error?.code ?? null,
  };
}

async function readAll(cookie: string, params: Record<string, string> = {}): Promise<ListPage[]> {
  const pages: ListPage[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 8; page += 1) {
    const nextParams = { ...params };
    if (cursor !== null) nextParams.cursor = cursor;
    const result = await readList(cookie, nextParams);
    expect(result.status).toBe(200);
    pages.push(result.body);
    if (result.body.nextCursor === null) return pages;
    cursor = result.body.nextCursor;
  }
  throw new Error("слишком много страниц");
}

describe("GET /api/sessions", () => {
  test("без входа — 401", async () => {
    const response = await fetchApp("/api/sessions");
    expect(response.status).toBe(401);
  });

  test("отдаёт только начатые сессии текущего пользователя", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const cookieA = await loginAs(userA);
    const cookieB = await loginAs(userB);
    const idsA = [1, 2, 3].map(sessionId);
    const idsB = [4, 5].map(sessionId);

    for (const [index, id] of idsA.entries()) {
      await insertSession({
        id,
        userId: userA.id,
        eveSessionId: `eve-a-${index}`,
        title: `Сессия ${index}`,
        titleSearch: `сессия ${index}`,
        createdAt: "2026-06-01 10:00:00+00",
        updatedAt: `2026-06-01 12:00:0${index}+00`,
      });
    }
    await insertSession({
      id: sessionId(9),
      userId: userA.id,
      eveSessionId: null,
      title: "Ещё не начата",
      titleSearch: "ещё не начата",
      createdAt: "2026-06-01 10:00:00+00",
      updatedAt: "2026-06-01 13:00:00+00",
    });
    for (const [index, id] of idsB.entries()) {
      await insertSession({
        id,
        userId: userB.id,
        eveSessionId: `eve-b-${index}`,
        title: "Чужой ролик",
        titleSearch: "чужой ролик",
        createdAt: "2026-06-01 10:00:00+00",
        updatedAt: `2026-06-01 18:00:0${index}+00`,
      });
    }

    const own = await readList(cookieA);
    expect(own.status).toBe(200);
    expect(own.cacheControl).toBe("no-store");
    expect(own.body.items.map((item) => item.id)).toEqual([idsA[2], idsA[1], idsA[0]]);
    expect(own.body.nextCursor).toBeNull();
    expect(own.body.items[0]).toMatchObject({
      title: "Сессия 2",
      createdAt: "2026-06-01T10:00:00.000Z",
    });
    expect(Object.keys(own.body.items[0]).sort()).toEqual([
      "createdAt",
      "id",
      "title",
      "updatedAt",
    ]);

    const foreignCursor = (await readList(cookieB, { limit: "1" })).body.nextCursor;
    expect(foreignCursor).not.toBeNull();
    const withForeignCursor = await readList(cookieA, { cursor: foreignCursor ?? "" });
    const withForeignQuery = await readList(cookieA, { q: "чужой" });
    const visible = [
      ...own.body.items,
      ...withForeignCursor.body.items,
      ...withForeignQuery.body.items,
    ].map((item) => item.id);
    expect(visible.every((id) => idsA.includes(id))).toBe(true);
    expect(visible).not.toContain(sessionId(9));
  });

  test("35 сессий по 10, без потерь и повторов, последняя страница без курсора", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    for (let n = 1; n <= 35; n += 1) {
      await insertSession({
        id: sessionId(n),
        userId: user.id,
        eveSessionId: `eve-${n}`,
        createdAt: "2026-01-01 00:00:00+00",
        updatedAt: `2026-01-01 00:00:${String(n).padStart(2, "0")}+00`,
      });
    }

    const first = await readList(cookie);
    expect(first.body.items).toHaveLength(30);
    expect(first.body.nextCursor).not.toBeNull();
    expect(first.body.items.map((item) => item.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => sessionId(35 - index)),
    );

    const pages = await readAll(cookie, { limit: "10" });
    expect(pages).toHaveLength(4);
    expect(pages[3].nextCursor).toBeNull();
    expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(
      Array.from({ length: 35 }, (_, index) => sessionId(35 - index)),
    );
  });

  test("одинаковая миллисекунда и соседняя не теряются на границе страницы", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    // .100400 округляется к .100, .100500 — к .101, как и .101000.
    const rows = [
      ["1", "2026-06-01 12:00:00.100000+00"],
      ["2", "2026-06-01 12:00:00.100400+00"],
      ["3", "2026-06-01 12:00:00.101000+00"],
      ["4", "2026-06-01 12:00:00.100500+00"],
    ] as const;
    for (const [suffix, updatedAt] of rows) {
      await insertSession({
        id: sessionId(Number(suffix)),
        userId: user.id,
        eveSessionId: `eve-ms-${suffix}`,
        createdAt: "2026-06-01 12:00:00+00",
        updatedAt,
      });
    }

    const pages = await readAll(cookie, { limit: "2" });
    expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual([
      sessionId(4),
      sessionId(3),
      sessionId(2),
      sessionId(1),
    ]);
    expect(pages[1].nextCursor).toBeNull();
  });

  test("неверный limit, cursor и длинный q — 400", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const invalid: Record<string, string>[] = [
      { limit: "0" },
      { limit: "101" },
      { limit: "abc" },
      { limit: "" },
      { cursor: "xxx" },
      { cursor: "" },
      { q: "а".repeat(101) },
    ];
    for (const params of invalid) {
      const result = await readList(cookie, params);
      expect(result.status).toBe(400);
      expect(result.errorCode).toBe("invalid_request");
    }

    await insertSession({
      id: sessionId(1),
      userId: user.id,
      eveSessionId: "eve-spaces",
      title: "Видна",
      titleSearch: "видна",
      createdAt: "2026-06-01 12:00:00+00",
      updatedAt: "2026-06-01 12:00:00+00",
    });
    const spaces = await readList(cookie, { q: " ".repeat(101) });
    expect(spaces.status).toBe(200);
    expect(spaces.body.items.map((item) => item.id)).toEqual([sessionId(1)]);
  });

  test("поиск подстроки без учёта регистра и «ё», % и _ — буквально", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const rows = [
      [1, "Промо для кофейни", "промо для кофейни"],
      [2, "Ролик про Ёжиков", "ролик про ежиков"],
      [3, "Отчёт за квартал", "отчет за квартал"],
    ] as const;
    for (const [n, title, titleSearch] of rows) {
      await insertSession({
        id: sessionId(n),
        userId: user.id,
        eveSessionId: `eve-search-${n}`,
        title,
        titleSearch,
        createdAt: "2026-06-01 12:00:00+00",
        updatedAt: `2026-06-01 12:00:0${n}+00`,
      });
    }
    await insertSession({
      id: sessionId(8),
      userId: user.id,
      eveSessionId: "eve-untitled",
      title: null,
      titleSearch: null,
      createdAt: "2026-06-01 12:00:00+00",
      updatedAt: "2026-06-01 12:00:09+00",
    });

    expect((await readList(cookie, { q: "КОФЕЙН" })).body.items.map((item) => item.title)).toEqual([
      "Промо для кофейни",
    ]);
    expect((await readList(cookie, { q: "ежик" })).body.items.map((item) => item.title)).toEqual([
      "Ролик про Ёжиков",
    ]);
    expect((await readList(cookie, { q: "отчет" })).body.items.map((item) => item.title)).toEqual([
      "Отчёт за квартал",
    ]);
    expect((await readList(cookie, { q: "%" })).body.items).toEqual([]);
    expect((await readList(cookie, { q: "_" })).body.items).toEqual([]);
    expect((await readList(cookie, { q: "  кофе  " })).body.items.map((item) => item.title)).toEqual([
      "Промо для кофейни",
    ]);

    const unfiltered = await readList(cookie);
    expect(unfiltered.body.items.map((item) => item.id)).toContain(sessionId(8));
    expect(unfiltered.body.items.find((item) => item.id === sessionId(8))?.title).toBeNull();
  });

  test("поиск со страницами не теряет и не повторяет строки", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    for (let n = 1; n <= 5; n += 1) {
      await insertSession({
        id: sessionId(n),
        userId: user.id,
        eveSessionId: `eve-coffee-${n}`,
        title: `Кофе ${n}`,
        titleSearch: `кофе ${n}`,
        createdAt: "2026-06-01 12:00:00+00",
        updatedAt: `2026-06-01 12:00:0${n}+00`,
      });
    }
    await insertSession({
      id: sessionId(6),
      userId: user.id,
      eveSessionId: "eve-tea",
      title: "Чай",
      titleSearch: "чай",
      createdAt: "2026-06-01 12:00:00+00",
      updatedAt: "2026-06-01 12:00:09+00",
    });

    const pages = await readAll(cookie, { q: "кофе", limit: "2" });
    expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual([
      sessionId(5),
      sessionId(4),
      sessionId(3),
      sessionId(2),
      sessionId(1),
    ]);
  });
});

describe("название из первого сообщения", () => {
  test("ставится один раз и попадает в список", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const { id } = await createSessionAs(user);

    await sendAndWait(user, id, "сделай ролик про пингвинов");

    let title: string | null = null;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const response = await fetchApp(`/api/sessions/${id}`, { headers: { cookie } });
      const body = (await response.json()) as { title: string | null };
      if (typeof body.title === "string" && body.title !== "") {
        title = body.title;
        break;
      }
      await sleep(200);
    }
    expect(title).toBe("Сделай ролик про пингвинов");

    const list = await readList(cookie);
    expect(list.body.items.map((item) => item.id)).toContain(id);
    expect(list.body.items.find((item) => item.id === id)?.title).toBe(
      "Сделай ролик про пингвинов",
    );

    await sendAndWait(user, id, "второе сообщение про другой ролик");
    const again = await fetchApp(`/api/sessions/${id}`, { headers: { cookie } });
    const againBody = (await again.json()) as { title: string | null };
    expect(againBody.title).toBe("Сделай ролик про пингвинов");

    const [row] = await db().select().from(appSessions).where(eq(appSessions.id, id));
    expect(row?.titleSearch).toBe("сделай ролик про пингвинов");
  });
});

describe("страница /s", () => {
  test("первая страница поиска уже в HTML", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const rows = [
      [1, "Промо для кофейни", "промо для кофейни"],
      [2, "Ролик про Ёжиков", "ролик про ежиков"],
      [3, "Отчёт за квартал", "отчет за квартал"],
    ] as const;
    for (const [n, title, titleSearch] of rows) {
      await insertSession({
        id: sessionId(n),
        userId: user.id,
        eveSessionId: `eve-page-${n}`,
        title,
        titleSearch,
        createdAt: "2026-06-01 12:00:00+00",
        updatedAt: `2026-06-01 12:00:0${n}+00`,
      });
    }

    const response = await fetchApp(`/s?q=${encodeURIComponent("кофейн")}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Промо для кофейни");
    expect(html).not.toContain("Отчёт за квартал");
  });

  test("слишком длинный q показывает ошибку, а не падает", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const response = await fetchApp(`/s?q=${"а".repeat(101)}`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Не удалось загрузить сессии");
  });

  test("заголовок вкладки — своё название, чужое не попадает в ответ", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const cookie = await loginAs(owner);
    await insertSession({
      id: sessionId(1),
      userId: owner.id,
      eveSessionId: "eve-own-title",
      title: "Секретный ролик",
      titleSearch: "секретный ролик",
      createdAt: "2026-06-01 12:00:00+00",
      updatedAt: "2026-06-01 12:00:01+00",
    });
    await insertSession({
      id: sessionId(2),
      userId: owner.id,
      eveSessionId: null,
      title: null,
      createdAt: "2026-06-01 12:00:00+00",
      updatedAt: "2026-06-01 12:00:02+00",
    });
    await insertSession({
      id: sessionId(3),
      userId: stranger.id,
      eveSessionId: "eve-foreign-title",
      title: "Чужое секретное название",
      titleSearch: "чужое секретное название",
      createdAt: "2026-06-01 12:00:00+00",
      updatedAt: "2026-06-01 12:00:03+00",
    });

    const own = await fetchApp(`/s/${sessionId(1)}`, { headers: { cookie } });
    expect(own.status).toBe(200);
    expect(await own.text()).toContain("Секретный ролик · 42 AI Studio");

    const untitled = await fetchApp(`/s/${sessionId(2)}`, { headers: { cookie } });
    expect(untitled.status).toBe(200);
    expect(await untitled.text()).toContain("Новая сессия · 42 AI Studio");

    const foreign = await fetchApp(`/s/${sessionId(3)}`, { headers: { cookie } });
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).not.toContain("Чужое секретное название");
  });
});
