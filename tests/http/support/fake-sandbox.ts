import { loadConfig } from "../../../lib/config";
import { FakeStore, type FakeRule, type FakeCreateFailure } from "../../../lib/sandbox/fake-store";

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
  failNextCreate: (kind: FakeCreateFailure) => store().failNextCreate(kind),
  counters: () => store().counters(),
  reset: () => store().reset(),
};
