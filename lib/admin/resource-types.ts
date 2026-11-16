/** Публичные JSON-контракты отчётов; даты передаются строками ISO. */
export interface AdminResourceUser {
  id: string;
  name: string;
  username: string | null;
}

export interface AdminSandboxesResponse {
  generatedAt: string;
  counts: { running: number; stopped: number; archived: number; queued: number };
  running: {
    appSessionId: string;
    sessionRef: string;
    user: AdminResourceUser;
    keyId: string;
    keyLabel: string;
    state: "starting" | "started";
    runningSince: string | null;
    runningSeconds: number;
    lastActiveAt: string;
    busy: boolean;
  }[];
  queue: {
    position: number;
    appSessionId: string;
    sessionRef: string;
    user: AdminResourceUser;
    need: "create" | "wake" | "restore";
    reason: "capacity" | "own_session_busy";
    keyLabel: string | null;
    enqueuedAt: string;
    waitingSeconds: number;
  }[];
}

export interface AdminUsageResponse {
  period: { from: string; to: string; tz: string };
  totals: {
    sandboxSeconds: number;
    inputTokens: number;
    outputTokens: number;
    openSandboxSeconds: number;
  };
  byDay: {
    date: string;
    sandboxSeconds: number;
    inputTokens: number;
    outputTokens: number;
  }[];
  byUser: {
    user: AdminResourceUser;
    sandboxSeconds: number;
    openSandboxSeconds: number;
    inputTokens: number;
    outputTokens: number;
  }[];
  othersCount: number;
}
