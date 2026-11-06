import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { checkpointSourceFingerprint } from "./checkpoint-source.mjs";

/** @typedef {import("eve/evals").EveEvalResult} EveEvalResult */
/** @typedef {{version: 1, target: string, caseIds: string[], startedAt: string, sourceFingerprint: string}} CheckpointManifest */
/** @typedef {{message: string, startIndex: number, phase: 'sending' | 'accepted' | 'settled', receivedEventId?: string}} CheckpointTurn */
/** @typedef {{sessionId: string, turns: CheckpointTurn[]}} CheckpointProgress */

/** An unresolved delivery is not a completed behavioral evaluation.
 * @param {EveEvalResult} result
 */
export function isUnresolvedCheckpoint(result) {
  return result.error?.startsWith("Checkpoint pending: ") === true;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return isRecord(error) && error.code === code;
}

/** @param {unknown} id @returns {asserts id is string} */
function validateId(id) {
  if (typeof id !== "string" || id.length === 0 || /[^a-zA-Z0-9/_-]/.test(id)) {
    throw new Error("Некорректный идентификатор случая checkpoint.");
  }
}

/** @param {unknown} value @returns {CheckpointManifest} */
function validateManifest(value) {
  if (!isRecord(value) || value.version !== 1 || typeof value.target !== "string" ||
    !value.target || !Array.isArray(value.caseIds) || typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) || typeof value.sourceFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)) {
    throw new Error("Повреждён manifest checkpoint.");
  }
  value.caseIds.forEach(validateId);
  if (new Set(value.caseIds).size !== value.caseIds.length) {
    throw new Error("Повтор идентификатора в manifest checkpoint.");
  }
  return /** @type {CheckpointManifest} */ (value);
}

/** @param {unknown} value @returns {EveEvalResult} */
function validateResult(value) {
  if (!isRecord(value)) throw new Error("Повреждён результат checkpoint.");
  validateId(value.id);
  const task = value.result;
  if (!["passed", "failed", "scored", "skipped"].includes(String(value.verdict)) ||
    !Array.isArray(value.assertions) || !isRecord(task) ||
    !["completed", "failed", "waiting"].includes(String(task.status)) ||
    !Array.isArray(task.events) || !Array.isArray(task.traceContexts) || !isRecord(task.derived) ||
    (task.sessions !== undefined && !Array.isArray(task.sessions))) {
    throw new Error(`Повреждён результат checkpoint: ${value.id}.`);
  }
  for (const assertion of value.assertions) {
    if (!isRecord(assertion) || typeof assertion.name !== "string" ||
      !["gate", "soft"].includes(String(assertion.severity)) || typeof assertion.errored !== "boolean" ||
      (assertion.passed !== undefined && typeof assertion.passed !== "boolean")) {
      throw new Error(`Повреждены assertions checkpoint: ${value.id}.`);
    }
  }
  for (const key of ["toolCalls", "skillLoads", "subagentCalls", "inputRequests", "models"]) {
    if (!Array.isArray(task.derived[key])) {
      throw new Error(`Повреждены derived.${key} checkpoint: ${value.id}.`);
    }
  }
  return /** @type {EveEvalResult} */ (/** @type {unknown} */ (value));
}

/** @param {unknown} value @returns {CheckpointProgress} */
function validateProgress(value) {
  if (!isRecord(value) || typeof value.sessionId !== "string" || !value.sessionId.trim() ||
    !Array.isArray(value.turns)) {
    throw new Error("Повреждён progress checkpoint.");
  }
  for (const turn of value.turns) {
    if (!isRecord(turn) || typeof turn.message !== "string" ||
      !Number.isSafeInteger(turn.startIndex) || Number(turn.startIndex) < 0 ||
      !["sending", "accepted", "settled"].includes(String(turn.phase)) ||
      (turn.phase !== "sending" && (typeof turn.receivedEventId !== "string" || !turn.receivedEventId))) {
      throw new Error("Повреждён ход в progress checkpoint.");
    }
  }
  return /** @type {CheckpointProgress} */ (value);
}

/** Only ENOENT means missing; malformed JSON and other I/O errors must propagate.
 * @param {string} path @returns {Promise<unknown>}
 */
async function readJson(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

/** @param {string} path @param {unknown} value @param {boolean} immutable
 * @returns {Promise<boolean>} false means an immutable destination already exists.
 */
async function writeJson(path, value, immutable) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = join(dirname(path), `.checkpoint-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.chmod(0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (immutable) {
      // Unlike rename, link publishes atomically without replacing another result.
      try {
        await link(temporary, path);
      } catch (error) {
        if (hasCode(error, "EEXIST")) return false;
        throw error;
      }
    } else {
      await rename(temporary, path);
    }
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return true;
  } finally {
    // Never sweep another writer's temporary files, including after a crash.
    await unlink(temporary).catch((error) => {
      if (!hasCode(error, "ENOENT")) throw error;
    });
  }
}

export class CheckpointStore {
  /** @type {CheckpointManifest | undefined} */
  #manifest;

  /** @param {string} directory */
  constructor(directory) {
    if (typeof directory !== "string" || !directory.trim()) {
      throw new Error("Укажите каталог checkpoint.");
    }
    /** @type {string} */
    this.directory = resolve(directory);
  }

  /** @param {{target: string, caseIds: string[]}} options @returns {Promise<CheckpointManifest>} */
  async initialize({ target, caseIds }) {
    target = new URL(target).href;
    const candidate = validateManifest({ version: 1, target, caseIds: [...caseIds], startedAt: new Date().toISOString(),
      sourceFingerprint: await checkpointSourceFingerprint() });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (((await directory.stat()).mode & 0o777) !== 0o700) {
        throw new Error("Каталог checkpoint должен быть приватным (права 0700); чужие права не меняются.");
      }
    } finally {
      await directory.close();
    }
    const path = join(this.directory, "manifest.json");
    let stored = await readJson(path);
    if (stored === undefined) {
      await writeJson(path, candidate, true);
      stored = await readJson(path);
    }
    const manifest = validateManifest(stored);
    if (manifest.sourceFingerprint !== candidate.sourceFingerprint) {
      throw new Error("Исходники агента или оценок изменились; результаты разных версий не смешиваются.");
    }
    if (manifest.target !== target) throw new Error("Target checkpoint не совпадает с адресом запуска.");
    if (candidate.caseIds.some((id) => !manifest.caseIds.includes(id))) {
      throw new Error("Случай запуска отсутствует в исходном manifest checkpoint.");
    }
    this.#manifest = manifest;
    return this.manifest();
  }

  /** Original full run manifest, even after initialization with a resumed subset.
   * @returns {CheckpointManifest}
   */
  manifest() {
    if (!this.#manifest) throw new Error("CheckpointStore не инициализирован.");
    return { ...this.#manifest, caseIds: [...this.#manifest.caseIds] };
  }

  /** @param {'result' | 'progress'} kind @param {string} id @returns {string} */
  #path(kind, id) {
    validateId(id);
    if (!this.manifest().caseIds.includes(id)) throw new Error(`Неизвестный случай checkpoint: ${id}.`);
    return join(this.directory, `${kind}-${encodeURIComponent(id)}.json`);
  }

  /** @param {string} id @returns {Promise<EveEvalResult | undefined>} */
  async readResult(id) {
    const value = await readJson(this.#path("result", id));
    if (value === undefined) return undefined;
    const result = validateResult(value);
    if (result.id !== id) throw new Error(`Идентификатор результата checkpoint не совпадает: ${id}.`);
    return result;
  }

  /** Persist the full native result without changing verdicts, failures, or assertions.
   * @param {EveEvalResult} result @returns {Promise<void>}
   */
  async writeResult(result) {
    if (isUnresolvedCheckpoint(result)) throw new Error("Неподтверждённый ход остаётся pending, а не итоговым failed.");
    const snapshot = validateResult(JSON.parse(JSON.stringify(result)));
    const path = this.#path("result", snapshot.id);
    if (!await writeJson(path, snapshot, true)) {
      const existing = await this.readResult(snapshot.id);
      if (!isDeepStrictEqual(existing, snapshot)) {
        throw new Error(`Другой результат уже сохранён для ${snapshot.id}.`);
      }
    }
  }

  /** @param {string} id @returns {Promise<CheckpointProgress | undefined>} */
  async readProgress(id) {
    const value = await readJson(this.#path("progress", id));
    return value === undefined ? undefined : validateProgress(value);
  }

  /** @param {string} id @param {CheckpointProgress} progress @returns {Promise<void>} */
  async writeProgress(id, progress) {
    const snapshot = validateProgress(JSON.parse(JSON.stringify(progress)));
    await writeJson(this.#path("progress", id), snapshot, false);
  }

  /** @returns {Promise<EveEvalResult[]>} */
  async results() {
    const values = await Promise.all(this.manifest().caseIds.map((id) => this.readResult(id)));
    return values.filter((value) => value !== undefined);
  }

  /** @param {string} fingerprint */
  async bindRuntime(fingerprint) {
    const path = join(this.directory, "runtime.json");
    const runtime = { fingerprint };
    if (!await writeJson(path, runtime, true) && !isDeepStrictEqual(await readJson(path), runtime)) {
      throw new Error("Модель или конфигурация сервера/судьи изменились; checkpoint не переиспользуется.");
    }
  }

  /** Preserve an invocation failure independently of its immutable case result.
   * @param {string} message
   */
  async block(message) { await writeJson(join(this.directory, "blocked.json"), { message }, true); }

  async assertNotBlocked() {
    const blocked = await readJson(join(this.directory, "blocked.json"));
    if (blocked !== undefined) throw new Error(`Серия остановлена из-за ошибки завершения: ${JSON.stringify(blocked)}`);
  }
}
