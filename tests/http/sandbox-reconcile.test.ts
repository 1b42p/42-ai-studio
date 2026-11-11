/** Прямая сверка: настоящая БД, управляемые ответы Daytona на границе backend. */
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import * as backends from "../../agent/lib/daytona-backend";
import { reconcileSandboxStates } from "../../agent/lib/sandbox-queue";
import { appSessions, sandboxes, type Sandbox, type SandboxState } from "../../lib/db/schema";
import { getFakeBackend } from "../../lib/sandbox/fake";
import { loadConfig } from "../../lib/config";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";

const SECRET = "dtn_reconcile_test";
const old = () => new Date(Date.now() - 6 * 60_000);

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
});
afterEach(() => vi.restoreAllMocks());

async function fixture(options: {
  state?: SandboxState; emptyId?: boolean; bound?: boolean; create?: boolean;
  fresh?: boolean; snapshotState?: string;
} = {}) {
  const user = await createUser();
  const key = await createDaytonaKey({ apiKey: SECRET });
  const eveSessionId = randomUUID();
  const name = `studio-${createHash("sha256").update(eveSessionId).digest("hex").slice(0, 32)}`;
  const [session] = await db().insert(appSessions).values({
    userId: user.id, eveSessionId: options.bound === false ? null : eveSessionId,
  }).returning();
  const backend = getFakeBackend(loadConfig().fakeSandboxDir!, SECRET, { cpu: 2, memoryGb: 4, diskGb: 8 });
  const machine = options.create === false ? undefined : await backend.create({ name, appSessionId: session.id });
  const [row] = await db().insert(sandboxes).values({
    appSessionId: session.id, daytonaKeyId: key.id,
    daytonaSandboxId: options.emptyId ? "" : machine?.id ?? "missing",
    state: options.state ?? "starting", startingSince: options.fresh ? new Date() : old(),
    startingKind: "create", slotRequestId: randomUUID(), lastActiveAt: old(), createdAt: old(),
  }).returning();
  const get = vi.fn(backend.get);
  const client: backends.DaytonaBackend = {
    ...backend, get,
    async *list() {
      if (machine && options.snapshotState !== undefined) {
        yield new Proxy(machine, {
          get(target, property, receiver) {
            return property === "state" ? options.snapshotState : Reflect.get(target, property, receiver);
          },
        });
      }
    },
  };
  vi.spyOn(backends, "daytonaBackend").mockReturnValue(client);
  return { row, machine, get, name, session };
}

async function read(row: Sandbox) {
  const [current] = await db().select().from(sandboxes).where(eq(sandboxes.id, row.id));
  return current;
}

test("просроченное создание без id восстанавливается по имени и попадает в карту", async () => {
  const { row, machine, get, name, session } = await fixture({ emptyId: true });
  const machines = await reconcileSandboxStates();
  expect(get).toHaveBeenCalledWith(name);
  expect(await read(row)).toMatchObject({ daytonaSandboxId: machine!.id, state: "started", startingSince: null });
  expect(machines.get(session.id)?.id).toBe(machine!.id);
});

test("404 по имени освобождает только просроченный резерв", async () => {
  const { row, get, name } = await fixture({ emptyId: true, create: false });
  await reconcileSandboxStates();
  expect(get).toHaveBeenCalledWith(name);
  expect(await read(row)).toMatchObject({ state: "gone", startingSince: null });
});

test.each([{ fresh: true }, { bound: false }])("не угадывает имя для свежего или непривязанного резерва: %j", async (options) => {
  const { row, get } = await fixture({ ...options, emptyId: true, create: false });
  expect((await reconcileSandboxStates()).size).toBe(0);
  expect(get).not.toHaveBeenCalled();
  expect(await read(row)).toMatchObject({ state: "starting", daytonaSandboxId: "" });
});

test("устаревший stopped в list не откатывает завершённое пробуждение", async () => {
  const { row, machine, get } = await fixture({ state: "started", snapshotState: "stopped" });
  await reconcileSandboxStates();
  expect(get).toHaveBeenCalledWith(machine!.id);
  expect((await read(row)).state).toBe("started");
});

test("nullable-поля резерва сравниваются через IS NULL", async () => {
  const { row } = await fixture({ state: "stopped" });
  await db().update(sandboxes).set({ startingSince: null, startingKind: null, slotRequestId: null })
    .where(eq(sandboxes.id, row.id));
  await reconcileSandboxStates();
  expect((await read(row)).state).toBe("started");
});

test("отсутствие известного id подтверждается get/404", async () => {
  const { row, get } = await fixture({ state: "started", create: false });
  await reconcileSandboxStates();
  expect(get).toHaveBeenCalledWith("missing");
  expect((await read(row)).state).toBe("gone");
});

test("недоступность get не означает утрату машины", async () => {
  const { row, get } = await fixture({ state: "started" });
  get.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { status: 503 }));
  expect((await reconcileSandboxStates()).size).toBe(0);
  expect((await read(row)).state).toBe("started");
});

test.each(["startingSince", "slotRequestId", "daytonaSandboxId", "maintenanceToken"] as const)(
  "404 не затирает конкурентное изменение %s", async (field) => {
    const { row, get } = await fixture({ emptyId: true, create: false });
    const value = field === "startingSince" ? new Date() : randomUUID();
    get.mockImplementationOnce(async () => {
      await db().update(sandboxes).set({ [field]: value }).where(eq(sandboxes.id, row.id));
      throw Object.assign(new Error("not found"), { status: 404 });
    });
    expect((await reconcileSandboxStates()).size).toBe(0);
    expect((await read(row)).state).toBe("starting");
  },
);

test("успешный get не перезаписывает новый резерв и не возвращает старую машину", async () => {
  const { row, machine, get } = await fixture({ emptyId: true });
  const startingSince = new Date();
  get.mockImplementationOnce(async () => {
    await db().update(sandboxes).set({ startingSince }).where(eq(sandboxes.id, row.id));
    return machine!;
  });
  expect((await reconcileSandboxStates()).size).toBe(0);
  expect(await read(row)).toMatchObject({ state: "starting", daytonaSandboxId: "", startingSince });
});

test.each([
  ["started", "started"], ["stopped", "stopped"], ["stopping", "stopped"],
  ["archived", "archived"], ["archiving", "archived"],
  ["destroying", "starting"], ["destroyed", "gone"],
  ["creating", "starting"], ["starting", "starting"], ["restoring", "starting"],
  ["pending_build", "starting"], ["building_snapshot", "starting"],
  ["pulling_snapshot", "starting"], ["resizing", "starting"],
  ["snapshotting", "starting"], ["forking", "starting"], ["resuming", "starting"],
  ["error", "stopped"], ["build_failed", "stopped"],
] as const)("подтверждённое %s отображается в %s", async (state, expected) => {
  const { row, machine, get } = await fixture({ state: "stopped" });
  get.mockResolvedValue(new Proxy(machine!, {
    get(target, property, receiver) {
      return property === "state" ? state : Reflect.get(target, property, receiver);
    },
  }));
  await reconcileSandboxStates();
  expect((await read(row)).state).toBe(expected);
});

test("повторный снимок активности не омолаживает строку", async () => {
  const { row, machine } = await fixture({ state: "started" });
  const activity = machine!.lastActivityAt!;
  const lastActiveAt = new Date(activity.getTime() - 60_000);
  await db().update(sandboxes).set({ daytonaActivityAt: activity, lastActiveAt })
    .where(eq(sandboxes.id, row.id));
  await reconcileSandboxStates();
  expect((await read(row)).lastActiveAt).toEqual(lastActiveAt);
});

test("новая активность сдвигает lastActiveAt и запоминается один раз", async () => {
  const { row, machine } = await fixture({ state: "started" });
  await reconcileSandboxStates();
  expect(await read(row)).toMatchObject({
    lastActiveAt: machine!.lastActivityAt, daytonaActivityAt: machine!.lastActivityAt,
  });
});
