import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const exec = promisify(execFile);

const deliveryArtifact = z.object({
  templateKey: z.string().min(1),
  dockerfile: z.string().min(1),
  files: z.array(z.object({ path: z.string().min(1), content: z.string() })),
});

const preparedManifest = z.object({
  kind: z.literal("eve-sandbox-prepared-artifacts"),
  version: z.literal(2),
  entries: z.array(z.object({
    nodeId: z.string(),
    providerName: z.string(),
    artifact: z.unknown(),
  })),
});

/** Настоящий eve build; наружу выходят только JSON-байты, не исходные файлы. */
export async function buildSandboxDeliveryArtifact(files: Record<string, string | Uint8Array>) {
  await fs.mkdir("/tmp/opencode", { recursive: true });
  const directory = await fs.mkdtemp("/tmp/opencode/sandbox-delivery-");
  try {
    // Allowlist намеренно не включает .env*, .eve, .git и результаты сборок.
    // sandbox.ts импортирует stub-eval-media, а тот — фикстуры из evals/.
    for (const entry of ["agent", "lib", "evals", "package.json", "tsconfig.json"]) {
      await fs.cp(path.join(projectRoot, entry), path.join(directory, entry), {
        recursive: true,
        filter: (source) => !path.basename(source).startsWith(".env"),
      });
    }
    await fs.symlink(path.join(projectRoot, "node_modules"), path.join(directory, "node_modules"), "dir");
    for (const [filename, content] of Object.entries(files)) {
      const destination = path.resolve(directory, filename);
      if (!destination.startsWith(`${directory}${path.sep}`)) {
        throw new Error("Build fixture must stay inside its temporary directory");
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
    }

    // Не наследуем APP_*, DATABASE_*/DB_*, S3_*, TELEGRAM_*, AGENT_*,
    // SECRETS_*, токены провайдеров или NODE_OPTIONS от тестового приложения.
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    for (const name of ["PATH", "LANG", "LC_ALL", "TZ", "CI", "NO_COLOR"]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    env.HOME = path.join(directory, "home");
    env.XDG_CONFIG_HOME = path.join(directory, "config");
    env.XDG_CACHE_HOME = path.join(directory, "cache");
    await fs.mkdir(env.HOME, { recursive: true });
    await exec(process.execPath, ["node_modules/eve/bin/eve.js", "build"], {
      cwd: directory,
      env,
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    // Production build публикует compiler artifacts внутри .output/.eve;
    // исходный .eve/compile принадлежит dev и сборкой не обновляется.
    const manifest = preparedManifest.parse(JSON.parse(await fs.readFile(
      path.join(directory, ".output/.eve/compile/sandbox-prepared-artifacts.json"), "utf8",
    )));
    const root = manifest.entries.find((entry) => entry.nodeId === "__root__");
    if (root?.providerName !== "studio-daytona") {
      throw new Error("eve build did not prepare the root Daytona sandbox");
    }
    return deliveryArtifact.parse(root.artifact);
  } finally {
    // Только каталог, созданный этим вызовом; node_modules — symlink.
    await fs.rm(directory, { recursive: true, force: true });
  }
}
