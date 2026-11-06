import { createHash } from "node:crypto";
import { readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

/** Hash only executable project sources, never .env, reports, or generated videos. */
export async function checkpointSourceFingerprint() {
  // eve bundles authored modules into a cache: import.meta.url is not the source root.
  const root = process.cwd();
  const hash = createHash("sha256");
  async function visit(relative) {
    let entries;
    try { entries = await readdir(join(root, relative), { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".env")) continue;
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        hash.update(`${path}\0`);
        const bytes = entry.isSymbolicLink() ? await readlink(join(root, path)) : await readFile(join(root, path));
        hash.update(bytes).update("\0");
      }
    }
  }
  for (const directory of ["agent", "lib", "evals", "app/api/health"]) await visit(directory);
  for (const path of ["package.json", "package-lock.json", "next.config.ts"]) {
    try { hash.update(path).update("\0").update(await readFile(join(root, path))).update("\0"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return hash.digest("hex");
}
