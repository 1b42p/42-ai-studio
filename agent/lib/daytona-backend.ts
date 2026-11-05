import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daytona, Image, type Sandbox } from "@daytona/sdk";
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
  start(): Promise<void>;
  recover(): Promise<void>;
  ready(): Promise<void>;
  delete(): Promise<void>;
  connect(callbacks: ConnectionCallbacks): SandboxConnection;
  readJobDirectory(jobId: string): Promise<JobDirectoryReading>;
}

export interface DaytonaBackend {
  get(idOrName: string): Promise<DaytonaMachine>;
  create(options: { name: string; appSessionId: string; dockerfile: string }): Promise<DaytonaMachine>;
}

const clients = new Map<string, Daytona>();

function wrap(sandbox: Sandbox): DaytonaMachine {
  return {
    get id() { return sandbox.id; },
    get state() { return sandbox.state; },
    get recoverable() { return sandbox.recoverable; },
    start: () => sandbox.start(300),
    recover: () => sandbox.recover(300),
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
        autoStopInterval: 15,
        autoArchiveInterval: 7 * 24 * 60,
        autoDeleteInterval: -1,
      }, {
        timeout: 900,
        onSnapshotCreateLogs: (chunk) => console.info("[sandbox:build]", chunk.replaceAll(secret, "[redacted]")),
      }));
    },
  };
}
