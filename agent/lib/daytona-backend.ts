import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Daytona, DaytonaConflictError, Image, SandboxState, type Sandbox } from "@daytona/sdk";
import { SANDBOX_AGENT_ENV, type SandboxConnection } from "eve/sandbox/provider";
import { loadConfig } from "@/lib/config";
import { getFakeBackend } from "@/lib/sandbox/fake";
import { readDaytonaJobDirectory, type JobDirectoryReading } from "@/lib/sandbox/job-directory";
import { connectDaytona } from "./daytona-connection";

export interface ConnectionCallbacks {
  onStop(): Promise<void>;
  onActivity(): Promise<void>;
}

export interface DaytonaMachine {
  readonly id: string;
  readonly state?: string;
  readonly recoverable?: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly lastActivityAt: Date | undefined;
  readonly stoppedAt: Date | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
  archive(): Promise<void>;
  refreshActivity(): Promise<void>;
  configureLifecycle(): Promise<void>;
  recover(): Promise<void>;
  ready(): Promise<void>;
  delete(): Promise<void>;
  connect(callbacks: ConnectionCallbacks): SandboxConnection;
  readJobDirectory(jobId: string): Promise<JobDirectoryReading>;
}

export interface DaytonaBackend {
  list(): AsyncIterable<DaytonaMachine>;
  get(idOrName: string): Promise<DaytonaMachine>;
  create(options: { name: string; appSessionId: string; dockerfile: string }): Promise<DaytonaMachine>;
}

const clients = new Map<string, Daytona>();

export function daytonaSandboxName(eveSessionId: string): string {
  return `studio-${createHash("sha256").update(eveSessionId).digest("hex").slice(0, 32)}`;
}

function parsedDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

async function retryLifecycleConflict(action: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof DaytonaConflictError) || attempt >= 4) throw error;
      await delay(250 * 2 ** attempt);
    }
  }
}

function wrap(sandbox: Sandbox): DaytonaMachine {
  let stoppedAt: Date | undefined;
  const configureLifecycle = async () => {
    const config = loadConfig();
    await retryLifecycleConflict(() => sandbox.setAutostopInterval(config.sandboxIdleStopMinutes));
    await retryLifecycleConflict(() => sandbox.setAutoArchiveInterval(config.sandboxArchiveAfterDays * 24 * 60));
  };
  return {
    get id() { return sandbox.id; },
    get state() { return sandbox.state; },
    get recoverable() { return sandbox.recoverable; },
    get labels() { return { ...sandbox.labels }; },
    get lastActivityAt() { return parsedDate(sandbox.lastActivityAt); },
    // SDK 0.226.1 has no stoppedAt. Metadata updates can move updatedAt
    // forward, so this conservatively delays archiving, never advances it.
    get stoppedAt() {
      if (sandbox.state !== "stopped") return undefined;
      const updatedAt = parsedDate(sandbox.updatedAt);
      if (stoppedAt === undefined) return updatedAt;
      return new Date(Math.max(stoppedAt.getTime(), updatedAt?.getTime() ?? 0));
    },
    start: async () => {
      await sandbox.start(300);
      stoppedAt = undefined;
      await configureLifecycle();
    },
    stop: async () => {
      await sandbox.stop(300);
      stoppedAt = new Date();
    },
    archive: () => sandbox.archive(),
    refreshActivity: async () => {
      await sandbox.refreshActivity();
      await sandbox.refreshData();
    },
    configureLifecycle,
    recover: async () => {
      await sandbox.recover(300);
      await configureLifecycle();
    },
    ready: () => sandbox.waitUntilStarted(300),
    delete: () => sandbox.delete(300, true),
    connect: (callbacks) => connectDaytona(sandbox, callbacks),
    readJobDirectory: (jobId) => readDaytonaJobDirectory(sandbox, jobId),
  };
}

export function daytonaBackend(keyId: string, secret: string): DaytonaBackend {
  const config = loadConfig();
  if (config.appTestMode) {
    return getFakeBackend(config.fakeSandboxDir!, secret, {
      cpu: config.sandboxCpu,
      memoryGb: config.sandboxMemoryGb,
      diskGb: config.sandboxDiskGb,
    });
  }
  const cacheKey = `${keyId}:${createHash("sha256").update(secret).digest("hex")}`;
  let client = clients.get(cacheKey);
  if (client === undefined) {
    client = new Daytona({ apiKey: secret, apiUrl: config.daytonaApiUrl });
    clients.set(cacheKey, client);
  }
  const daytona = client;
  return {
    async *list() {
      const states = Object.values(SandboxState).filter((state) =>
        state !== SandboxState.DESTROYED && state !== SandboxState.UNKNOWN_DEFAULT_OPEN_API,
      );
      for await (const sandbox of daytona.list({ states })) yield wrap(sandbox);
    },
    async get(id) { return wrap(await daytona.get(id)); },
    async create({ name, appSessionId, dockerfile }) {
      const directory = await mkdtemp(join(tmpdir(), "studio-daytona-"));
      let image: Image;
      try {
        const path = join(directory, "Dockerfile");
        await writeFile(path, dockerfile, { mode: 0o600 });
        image = Image.fromDockerfile(path);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      return wrap(await daytona.create({
        name, image,
        resources: { cpu: config.sandboxCpu, memory: config.sandboxMemoryGb, disk: config.sandboxDiskGb },
        labels: { studio_session: appSessionId },
        envVars: { ...SANDBOX_AGENT_ENV },
        autoStopInterval: config.sandboxIdleStopMinutes,
        autoArchiveInterval: config.sandboxArchiveAfterDays * 24 * 60,
        autoDeleteInterval: -1,
      }, {
        timeout: 900,
        onSnapshotCreateLogs: (chunk) => console.info("[sandbox:build]", chunk.replaceAll(secret, "[redacted]")),
      }));
    },
  };
}
