import { afterEach, expect, test, vi } from "vitest";

const { selectJobs, sql, observeBashJob, keepBashJobsAlive } = vi.hoisted(() => ({
  selectJobs: vi.fn(),
  sql: vi.fn(),
  observeBashJob: vi.fn(),
  keepBashJobsAlive: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({ where: () => ({ orderBy: selectJobs }) }),
        }),
      }),
    }),
  }),
  getSqlClient: () => sql,
}));

vi.mock("@/lib/sandbox/job-service", () => ({ observeBashJob, keepBashJobsAlive }));

import { startBashJobWatchdog } from "@/lib/sandbox/job-watchdog";

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { __studioBashJobWatchdog?: boolean }).__studioBashJobWatchdog;
  vi.resetAllMocks();
});

test("продлевает активность новых машин, даже если сборщики вывода заняты", async () => {
  vi.useFakeTimers();
  sql.mockResolvedValue([{ id: "lease" }]);
  keepBashJobsAlive.mockResolvedValue(undefined);
  const stalled = Promise.withResolvers<void>();
  observeBashJob.mockReturnValue(stalled.promise);

  function candidate(index: number, machine: string) {
    return {
      job: { id: String(index), jobId: index.toString(16).padStart(8, "0") },
      sandbox: { id: machine, daytonaSandboxId: machine, state: "started" },
    };
  }
  const backlog = Array.from({ length: 20 }, (_, index) => candidate(index, `machine-${index % 16}`));
  const next = candidate(20, "next");
  selectJobs.mockResolvedValueOnce(backlog).mockResolvedValue([...backlog, next]);

  try {
    startBashJobWatchdog();
    await vi.advanceTimersByTimeAsync(0);
    expect(observeBashJob).toHaveBeenCalledTimes(16);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(keepBashJobsAlive.mock.calls.map(([sandbox]) => sandbox.id)).toContain("next");
    expect(keepBashJobsAlive.mock.calls.filter(([sandbox]) => sandbox.id === "machine-0"))
      .toEqual([[backlog[0]?.sandbox, ["00000000", "00000010"], expect.any(Function)]]);
    expect(observeBashJob).toHaveBeenCalledTimes(16);
  } finally {
    stalled.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
});
