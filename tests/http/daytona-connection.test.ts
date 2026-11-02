import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { DaytonaFileNotFoundError, SandboxState, type Sandbox } from "@daytona/sdk";
import { describe, expect, test, vi } from "vitest";
import { connectDaytona } from "../../agent/lib/daytona-connection";

function fixture() {
  const process = {
    createSession: vi.fn(async (_id: string) => {}),
    executeSessionCommand: vi.fn(async (_id: string, _request: { command: string }) => ({ cmdId: "cmd" })),
    getSessionCommand: vi.fn(async () => ({ exitCode: 7 })),
    getSessionCommandLogs: vi.fn(async (_id: string, _cmd: string, out?: (text: string) => void, err?: (text: string) => void) => {
      if (out && err) { out("Привет"); err("оши"); return; }
      return { stdout: "Привет, мир\n", stderr: "ошибка\n" };
    }),
    executeCommand: vi.fn(async (_command: string) => ({ exitCode: 0 })),
    deleteSession: vi.fn(),
  };
  const fs = {
    getFileDetails: vi.fn(async () => ({ isDir: false })),
    downloadFileStream: vi.fn(async (_path: string, _options: unknown) => Readable.from([Buffer.from("file")])),
    createFolder: vi.fn(async () => {}),
    uploadFiles: vi.fn(async (_files: unknown) => {}),
    deleteFile: vi.fn(async () => {}),
  };
  const sdk = {
    process, fs,
    state: SandboxState.STARTED as Sandbox["state"],
    refreshData: vi.fn(async () => {}),
    stop: vi.fn(async () => { sdk.state = SandboxState.STOPPED; }),
    waitUntilStopped: vi.fn(async () => { sdk.state = SandboxState.STOPPED; }),
  };
  const callbacks = { onStop: vi.fn(async () => {}), onActivity: vi.fn(async () => {}) };
  const connection = connectDaytona(sdk as unknown as Sandbox, callbacks);
  return { sdk, callbacks, connection };
}

async function text(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text();
}

describe("connectDaytona", () => {
  test("real Bash wrapper preserves cwd, env, heredocs, quotes and substitutions", async () => {
    const { sdk, connection } = fixture();
    const directory = await mkdtemp(join(tmpdir(), "studio-connection-"));
    try {
      const cwd = join(directory, "cwd with 'quotes'");
      await mkdir(cwd);
      let output = "";
      sdk.process.executeSessionCommand.mockImplementation(async (_id, request) => {
        // Execute the exact remote wrapper locally, remapping only its private
        // control directory so this test can clean up all of its own files.
        const command = request.command.replace(/\/tmp\/\.studio-exec-[a-f0-9-]+/g, `${directory}/control`);
        const result = await promisify(execFile)("bash", ["-c", command], {
          // Test the sandbox script, not the developer's login-shell profile.
          env: { HOME: directory, PATH: "/usr/bin:/bin", NODE_ENV: "test" },
          timeout: 5000,
        });
        output = result.stdout;
        return { cmdId: "local" };
      });
      sdk.process.getSessionCommand.mockResolvedValue({ exitCode: 0 });
      sdk.process.getSessionCommandLogs.mockImplementation(async (_id, _cmd, out, err) => {
        if (out && err) { out(output); return; }
        return { stdout: output, stderr: "" };
      });
      const process = await connection.spawn({
        command: "printf '%s\\n' \"$PWD\" \"$EXAMPLE\" \"$(printf substituted)\"\ncat <<'END'\n'quoted' \"double\" $(literal)\nEND",
        workingDirectory: cwd,
        env: { EXAMPLE: "a'b\n$(not-executed)" },
      });
      expect(await text(process.stdout)).toBe(`${cwd}\na'b\n$(not-executed)\nsubstituted\n'quoted' "double" $(literal)\n`);
      expect(await process.wait()).toEqual({ exitCode: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("asynchronous session, separate streams, final snapshot tail and exit code", async () => {
    const { sdk, connection } = fixture();
    const process = await connection.spawn({ command: "printf hi", workingDirectory: "/workspace", env: {} });
    const [out, err, status] = await Promise.all([text(process.stdout), text(process.stderr), process.wait()]);
    expect(out).toBe("Привет, мир\n");
    expect(err).toBe("ошибка\n");
    expect(status.exitCode).toBe(7);
    expect(sdk.process.executeSessionCommand).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      runAsync: true, suppressInputEcho: true,
    }));
    await process.kill();
    await connection.close?.();
    expect(sdk.process.executeCommand).not.toHaveBeenCalled();
    expect(sdk.process.deleteSession).not.toHaveBeenCalled();
    expect(sdk.stop).not.toHaveBeenCalled();
  });

  test("failed follow socket recovers from the persisted final snapshot without leaking errors", async () => {
    const { sdk, connection } = fixture();
    sdk.process.getSessionCommandLogs.mockImplementation(async (_id, _cmd, out) => {
      if (out) { out("Привет"); throw new Error("Authorization: secret"); }
      return { stdout: "Привет, мир\n", stderr: "" };
    });
    const process = await connection.spawn({ command: "echo", workingDirectory: "/workspace", env: {} });
    expect(await text(process.stdout)).toBe("Привет, мир\n");
    expect(await process.wait()).toEqual({ exitCode: 7 });
  });

  test("abort kills the dedicated process group and fails both streams and wait", async () => {
    const { sdk, connection } = fixture();
    sdk.process.getSessionCommandLogs.mockImplementation(async () => new Promise<never>(() => {}));
    const abort = new AbortController();
    const process = await connection.spawn({ command: "sleep 90", workingDirectory: "/workspace", env: {}, abortSignal: abort.signal });
    const out = text(process.stdout).catch((e: Error) => e.name);
    const err = text(process.stderr).catch((e: Error) => e.name);
    const wait = process.wait().catch((e: Error) => e.name);
    abort.abort();
    expect(await wait).toBe("AbortError");
    expect(await out).toBe("AbortError");
    expect(await err).toBe("AbortError");
    expect(sdk.process.executeCommand).toHaveBeenCalledTimes(1);
    expect(sdk.process.executeCommand.mock.calls[0]?.[0]).toContain("kill -KILL");
    expect(sdk.process.deleteSession).not.toHaveBeenCalled();
  });

  test("pre-aborted operations do not contact Daytona", async () => {
    const { sdk, connection } = fixture();
    const abortSignal = AbortSignal.abort();
    await expect(connection.spawn({ command: "echo", workingDirectory: "/workspace", env: {}, abortSignal })).rejects.toHaveProperty("name", "AbortError");
    await expect(connection.readFile({ path: "/file", abortSignal })).rejects.toHaveProperty("name", "AbortError");
    await expect(connection.writeFiles({ files: [], abortSignal })).rejects.toHaveProperty("name", "AbortError");
    await expect(connection.removePath({ path: "/file", abortSignal })).rejects.toHaveProperty("name", "AbortError");
    expect(sdk.process.createSession).not.toHaveBeenCalled();
    expect(sdk.fs.downloadFileStream).not.toHaveBeenCalled();
  });

  test("abort during dispatch leaves a tombstone for a late-starting command", async () => {
    const { sdk, connection } = fixture();
    let finishDispatch!: (value: { cmdId: string }) => void;
    sdk.process.executeSessionCommand.mockImplementation(() => new Promise((resolve) => { finishDispatch = resolve; }));
    const abort = new AbortController();
    const spawn = connection.spawn({ command: "sleep 90", workingDirectory: "/workspace", env: {}, abortSignal: abort.signal });
    const rejected = expect(spawn).rejects.toHaveProperty("name", "AbortError");
    await vi.waitFor(() => expect(sdk.process.executeSessionCommand).toHaveBeenCalledTimes(1));
    abort.abort();
    await rejected;
    finishDispatch({ cmdId: "late" });
    expect(sdk.process.executeCommand).toHaveBeenCalledTimes(1);
    const launch = sdk.process.executeSessionCommand.mock.calls[0][1].command;
    expect(launch).toContain("setsid --wait");
    expect(launch.match(/exit 137/g)).toHaveLength(2);
    expect(sdk.process.executeCommand.mock.calls[0][0]).toContain("/cancel");
    expect(sdk.process.getSessionCommandLogs).not.toHaveBeenCalled();
  });

  test("a late read stream error does not expose its message, headers or cause", async () => {
    const { sdk, connection } = fixture();
    const unsafe = Object.assign(new Error("Authorization: secret"), { headers: { secret: "secret" } });
    sdk.fs.downloadFileStream.mockResolvedValueOnce(new Readable({
      read() { this.destroy(unsafe); },
    }));
    const result = await connection.readFile({ path: "/file" });
    const error = await text(result as ReadableStream<Uint8Array>).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", expect.stringContaining("daytona_unavailable:"));
    expect(error).not.toHaveProperty("headers");
    expect(error).not.toHaveProperty("cause");
  });

  test("activity callback errors are sanitized before reaching eve", async () => {
    const { callbacks, connection } = fixture();
    callbacks.onActivity.mockRejectedValue(new Error("postgres://user:secret@db"));
    await expect(connection.spawn({ command: "echo", workingDirectory: "/workspace", env: {} })).rejects.not.toThrow("secret");
    await expect(connection.readFile({ path: "/file" })).rejects.not.toThrow("secret");
  });

  test("aborted directory preparation prevents dispatching the bulk upload", async () => {
    const { sdk, connection } = fixture();
    let finishDirectory!: () => void;
    sdk.fs.createFolder.mockImplementation(() => new Promise((resolve) => { finishDirectory = resolve; }));
    const abort = new AbortController();
    const write = connection.writeFiles({ files: [{ path: "/a/file", content: new Uint8Array() }], abortSignal: abort.signal });
    const rejected = expect(write).rejects.toHaveProperty("name", "AbortError");
    await vi.waitFor(() => expect(sdk.fs.createFolder).toHaveBeenCalled());
    abort.abort();
    await rejected;
    finishDirectory();
    expect(sdk.fs.uploadFiles).not.toHaveBeenCalled();
  });

  test("read returns a web stream; only a missing path is null", async () => {
    const { sdk, connection } = fixture();
    const result = await connection.readFile({ path: "/file" });
    expect(result).toBeInstanceOf(ReadableStream);
    expect(await text(result as ReadableStream<Uint8Array>)).toBe("file");
    sdk.fs.getFileDetails.mockRejectedValueOnce(new DaytonaFileNotFoundError("missing"));
    expect(await connection.readFile({ path: "/missing" })).toBeNull();
    sdk.fs.getFileDetails.mockResolvedValueOnce({ isDir: true });
    await expect(connection.readFile({ path: "/directory" })).rejects.toThrow("daytona_unavailable:");
    sdk.fs.getFileDetails.mockRejectedValueOnce(new Error("Authorization: secret"));
    await expect(connection.readFile({ path: "/denied" })).rejects.not.toThrow("secret");
  });

  test("writes create unique parent directories and upload one zero-copy batch", async () => {
    const { sdk, connection } = fixture();
    const content = new Uint8Array([0, 1, 2, 3]).subarray(1, 3);
    await connection.writeFiles({ files: [{ path: "/a/b/file", content }, { path: "/a/b/other", content }] });
    expect(sdk.fs.createFolder).toHaveBeenCalledExactlyOnceWith("/a/b", "755");
    expect(sdk.fs.uploadFiles).toHaveBeenCalledTimes(1);
    const files = sdk.fs.uploadFiles.mock.calls[0]?.[0] as { source: Buffer; destination: string }[];
    expect(files[0].source).toEqual(Buffer.from([1, 2]));
    expect(files[0].source.buffer).toBe(content.buffer);
  });

  test("remove forwards recursive and ignores missing paths only with force", async () => {
    const { sdk, connection } = fixture();
    await connection.removePath({ path: "/tree", recursive: true });
    expect(sdk.fs.deleteFile).toHaveBeenCalledWith("/tree", true);
    sdk.fs.deleteFile.mockRejectedValue(new DaytonaFileNotFoundError("missing"));
    await connection.removePath({ path: "/missing", force: true });
    await expect(connection.removePath({ path: "/missing" })).rejects.toThrow("daytona_unavailable:");
    sdk.fs.deleteFile.mockRejectedValue(new Error("Authorization: secret"));
    await expect(connection.removePath({ path: "/denied", force: true })).rejects.not.toThrow("secret");
  });

  test("stop is shared, persists state once and skips already stopped SDK instances", async () => {
    const { sdk, callbacks, connection } = fixture();
    await Promise.all([connection.stop(), connection.stop()]);
    expect(sdk.stop).toHaveBeenCalledTimes(1);
    expect(callbacks.onStop).toHaveBeenCalledTimes(1);
    await connection.stop();
    expect(sdk.stop).toHaveBeenCalledTimes(1);
    const other = fixture();
    other.sdk.state = SandboxState.STOPPED;
    await other.connection.stop();
    expect(other.sdk.stop).not.toHaveBeenCalled();
    expect(other.callbacks.onStop).toHaveBeenCalledTimes(1);
  });
});
