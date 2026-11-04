import { loadConfig } from "../../../lib/config";
import {
  FakeStore,
  type FakeCreateFailure,
  type FakeDeleteFailure,
  type FakeResources,
  type FakeRule,
  type FakeUsageFailure,
} from "../../../lib/sandbox/fake-store";

function store(): FakeStore {
  const config = loadConfig();
  if (!config.appTestMode || !config.fakeSandboxDir) {
    throw new Error("fakeSandbox requires APP_TEST_MODE=1 and FAKE_SANDBOX_DIR");
  }
  return new FakeStore(config.fakeSandboxDir);
}

/** File-backed controls shared with both application processes. */
export const fakeSandbox = {
  seed: (appSessionId: string, files: Record<string, string | Uint8Array>) => store().seed(appSessionId, files),
  rules: {
    set: (rules: readonly FakeRule[]) => store().setRules(rules),
    clear: () => store().setRules([]),
  },
  files: {
    read: (appSessionId: string, path: string) => store().read(appSessionId, path),
    write: (appSessionId: string, path: string, data: string | Uint8Array) => store().write(appSessionId, path, data),
    list: (appSessionId: string, directory: string) => store().list(appSessionId, directory),
  },
  calls: (appSessionId: string) => store().calls(appSessionId),
  stop: (appSessionId: string) => store().stop(appSessionId),
  archive: (appSessionId: string) => store().archive(appSessionId),
  killProcess: (appSessionId: string, jobId: string) => store().killProcess(appSessionId, jobId),
  failNextCreate: (kind: FakeCreateFailure) => store().failNextCreate(kind),
  failNextDelete: (kind: FakeDeleteFailure) => store().failNextDelete(kind),
  setCreateDelay: (ms: number) => store().setCreateDelay(ms),
  setQuota: (apiKey: string, quota: FakeResources) => store().setQuota(apiKey, quota),
  setOrganization: (apiKey: string, organizationId: string) => store().setOrganization(apiKey, organizationId),
  failUsage: (apiKey: string, failure: FakeUsageFailure | null) => store().failUsage(apiKey, failure),
  usageCalls: (apiKey?: string) => store().usageCalls(apiKey),
  counters: () => store().counters(),
  reset: () => store().reset(),
};
