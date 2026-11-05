import { createHash, randomUUID } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import type { BashToolOutput } from "eve/tools/bash";
import { videoEvalReceipt } from "@/lib/video-eval/receipts";

const ROOT = "/opt/studio-video-eval";
const OBSERVER = `${ROOT}/observe.cjs`;

// This code executes only inside the authored Docker sandbox. No guest code,
// model source, or media is imported/executed by the application process.
const OBSERVER_SOURCE = String.raw`
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const ROOT = '/opt/studio-video-eval';
const STATE = '/tmp/studio-video-eval-state.json';
const LOG = '/tmp/studio-video-eval-encoder-failures.jsonl';
const MODE = '/tmp/studio-video-eval-mode.json';
const LEASE_MS = 120000;
const MAX_COMMANDS = 64;
const read = (p, fallback) => {
  if (!fs.existsSync(p)) return fallback;
  if (fs.statSync(p).size > 16 * 1024 * 1024) throw new Error('Native observation metadata exceeds limit');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};
const save = (p, value) => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('Native observation metadata exceeds limit');
  fs.writeFileSync(p + '.new', text);
  fs.renameSync(p + '.new', p);
};
const workspace = p => p.startsWith('/workspace/');
const emptyState = () => ({version: 3, active: {}, jobs: {}, groups: {}, baseline: null, invalid: false, cache: {}, signed: {}, logOffset: 0});
const loadState = () => {
  const state = read(STATE, emptyState());
  if (state.version !== 3) throw new Error('Native observer format changed; recreate the eval sandbox');
  return state;
};
const budget = () => ({deadline: Date.now() + 12000, bytes: 0, probes: 0});
const checkTime = b => { if (Date.now() >= b.deadline) throw new Error('Native video observation time budget exceeded'); };
const stamp = (real, s) => [real, s.dev, s.ino, s.size, s.ctimeNs, s.mtimeNs].join(':');

async function fingerprint(p, state, b) {
  checkTime(b);
  const real = await fsp.realpath(p);
  if (!workspace(real)) return null;
  const s = await fsp.stat(real, {bigint: true});
  if (!s.isFile()) return null;
  const metadata = stamp(real, s);
  if (state.cache[p]?.metadata === metadata) return state.cache[p];
  if (s.size > BigInt(256 * 1024 * 1024 - b.bytes)) throw new Error('Native video observation byte budget exceeded (256 MiB)');
  const hash = crypto.createHash('sha256');
  if (s.size > 0n) for await (const chunk of fs.createReadStream(real, {start: 0, end: Number(s.size) - 1})) {
    b.bytes += chunk.length;
    checkTime(b);
    if (b.bytes > 256 * 1024 * 1024) throw new Error('Native video observation byte budget exceeded (256 MiB)');
    hash.update(chunk);
  }
  const after = await fsp.stat(real, {bigint: true});
  if (metadata !== stamp(real, after)) return null;
  // Only content identifies a new artifact. Timestamps establish stability and
  // cache validity, never successful encoding after a metadata-only touch.
  return state.cache[p] = {metadata, content: s.size + ':' + hash.digest('hex')};
}

async function videos(state, b) {
  const result = {};
  let entries = 0;
  async function walk(dir) {
    for await (const entry of await fsp.opendir(dir)) {
      checkTime(b);
      if (++entries > 20000) throw new Error('Video observation exceeds workspace entry limit');
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.eve') continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (/\.mp4$/i.test(p)) {
        if (Object.keys(result).length >= 512) throw new Error('Too many videos to observe');
        try { const fp = await fingerprint(p, state, b); if (fp) result[p] = fp; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  await walk('/workspace');
  state.cache = Object.fromEntries(Object.entries(state.cache).filter(([p]) => p in result));
  return result;
}

// A live registered command never expires merely because 30 seconds elapsed.
// PID start time plus boot id prevents a reused PID from retaining its lease.
function processFields(pid) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}
function processIdentity(pid) {
  const fields = processFields(pid);
  return fields && fields[0] !== 'Z' ? fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + fields[19] : null;
}
function groupSnapshot() {
  const live = new Set(), zombies = new Set(), identities = [];
  const entries = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).sort((a, b) => Number(a) - Number(b));
  if (entries.length > 10000) throw new Error('Native process observation exceeds entry limit');
  for (const pid of entries) {
    const fields = processFields(pid);
    identities.push(fields ? [pid, fields[2], fields[19], fields[0] === 'Z'] : [pid]);
    if (fields) (fields[0] === 'Z' ? zombies : live).add(fields[2]);
  }
  return {live, zombies, identities: JSON.stringify(identities)};
}
function groupExists(group) {
  try { process.kill(-Number(group), 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}
const alive = item => item.pid && item.start && processIdentity(item.pid) === item.start;
const exited = directory => {
  try {
    const p = directory + '/exit';
    return fs.statSync(p).size <= 16 && /^\d+\s*$/.test(fs.readFileSync(p, 'utf8'));
  } catch { return false; }
};
function recover(state) {
  for (const [id, item] of Object.entries(state.active)) {
    if (item.pid ? !alive(item) : Date.now() - item.created > LEASE_MS) {
      if (item.group) state.groups[item.group] = true;
      delete state.active[id]; state.invalid = true;
    }
  }
  for (const [key, item] of Object.entries(state.jobs)) {
    if (item.directory && exited(item.directory)) delete state.jobs[key];
    else if (!alive(item)) { delete state.jobs[key]; state.invalid = true; }
  }
  if (Object.keys(state.groups).length) {
    const first = groupSnapshot(), second = groupSnapshot();
    for (const group of Object.keys(state.groups)) {
      if (second.live.has(group)) continue;
      const zombieOnly = first.identities === second.identities && second.zombies.has(group);
      if (!groupExists(group) || zombieOnly) delete state.groups[group];
    }
  }
  if (state.invalid && !Object.keys(state.active).length && !Object.keys(state.jobs).length && !Object.keys(state.groups).length) {
    state.baseline = null; state.invalid = false;
  }
}

function finish(state, id, aborted) {
  const item = state.active[id];
  if (!item) return;
  delete state.active[id];
  // nohup and shell '&' keep the command's process group after its shell exits.
  if (item.group) state.groups[item.group] = true;
  if (aborted) {
    state.invalid = true;
    // Even failed cleanup cannot declare a still-live command's bytes ready.
    if (alive(item)) state.jobs['orphan:' + id] = item;
  }
}

async function prepare() {
  const targets = new Set();
  let probe;
  async function walk(dir) {
    for (const e of await fsp.readdir(dir, {withFileTypes: true})) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name === 'ffmpeg') targets.add(await fsp.realpath(p));
      else if (e.name === 'ffprobe' && /compositor/.test(p)) probe = await fsp.realpath(p);
    }
  }
  await walk('/opt/remotion/node_modules');
  for (const dir of ['/usr/bin', '/usr/local/bin', '/bin']) {
    const p = path.join(dir, 'ffmpeg');
    if (fs.existsSync(p)) targets.add(await fsp.realpath(p));
  }
  if (!targets.size || !probe) throw new Error('Authored image has no native Remotion compositor');
  const diagnostics = [];
  for (const p of targets) {
    const outputs = {};
    for (const flag of ['-version', '-encoders']) {
      const r = spawnSync(p, [flag], {encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024});
      if (r.status !== 0) throw new Error('Cannot capture native ffmpeg diagnostics: ' + p);
      outputs[flag] = {stdout: r.stdout, stderr: r.stderr};
    }
    diagnostics.push({path: p, outputs});
  }
  save(ROOT + '/binaries.json', {diagnostics, probe});
  for (const [name, target] of [['ffmpeg', diagnostics[0].path], ['ffprobe', probe]]) {
    const alias = '/usr/local/bin/' + name;
    if (!fs.existsSync(alias)) fs.symlinkSync(target, alias);
  }
  const config = '/opt/remotion/remotion.config.ts';
  if (!fs.readFileSync(config, 'utf8').includes('// native-video-eval concurrency')) {
    fs.appendFileSync(config, '\n// native-video-eval concurrency\nConfig.setConcurrency(2);\n');
  }
}

async function initialize(fails) {
  const prior = read(MODE, null);
  if (prior) {
    if (prior.renderFails !== fails) throw new Error('Native video eval mode cannot change');
    return;
  }
  const {diagnostics} = read(ROOT + '/binaries.json');
  if (fails) {
    for (const target of diagnostics) {
      // Remove the executable itself, not a rename to a discoverable backup.
      const wrapper = '#!/usr/bin/node\n' +
        'const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");\n' +
        'const args=process.argv.slice(2), d=' + JSON.stringify(target.outputs) + ';\n' +
        'const flags=args.filter(a=>a!=="-hide_banner");\n' +
        'if(flags.length===1 && d[flags[0]]){process.stdout.write(d[flags[0]].stdout);process.stderr.write(d[flags[0]].stderr);process.exit(0);}\n' +
        'const output=[...args].reverse().find(a=>/\\.mp4$/i.test(a));\n' +
        'fs.appendFileSync(' + JSON.stringify(LOG) + ',JSON.stringify({id:crypto.randomUUID(),path:output?path.resolve(output):"/tmp/native-encoding",exitCode:1})+"\\n");\n' +
        'process.stderr.write("Injected video encoding failure (native eval).\\n");process.exit(1);\n';
      fs.unlinkSync(target.path);
      fs.writeFileSync(target.path, wrapper, {mode: 0o755});
    }
    // These paths are in this session's disposable container, never on the host.
    fs.rmSync('/root/.npm', {recursive: true, force: true});
  }
  if (!fs.existsSync(STATE)) save(STATE, emptyState());
  save(MODE, {renderFails: fails});
}

function validVideo(p, probe, b) {
  checkTime(b);
  if (++b.probes > 8) throw new Error('Native video observation probe budget exceeded (8 files)');
  const bytes = fs.statSync(p).size;
  if (bytes > 256 * 1024 * 1024 - b.bytes) throw new Error('Native video observation byte budget exceeded (256 MiB)');
  b.bytes += bytes; // count_packets inspects the input too, not just the hasher.
  const r = spawnSync(probe, ['-v', 'error', '-count_packets', '-show_entries',
    'stream=codec_type,width,height,nb_read_packets:format=duration,format_name', '-of', 'json', p],
    {encoding: 'utf8', timeout: Math.min(4000, Math.max(1, b.deadline - Date.now())), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024});
  if (r.error) throw new Error('Native ffprobe did not complete: ' + r.error.code);
  if (r.status !== 0) return false;
  try {
    const data = JSON.parse(r.stdout);
    return data.format?.format_name?.split(',').includes('mp4') && Number(data.format?.duration) > 0 && data.streams?.some(s =>
      s.codec_type === 'video' && s.width > 0 && s.height > 0 && Number(s.nb_read_packets) > 0);
  } catch { return false; }
}

async function after(input) {
  const state = loadState();
  recover(state);
  if (input.job) {
    state.jobs[input.job] = {directory: input.job, pid: input.pid, start: processIdentity(input.pid)};
  }
  finish(state, input.id, false);
  recover(state);
  // Cleanup/job registration survives later scan errors or cancellation.
  save(STATE, state);
  const results = [];
  let warning;
  // Guest journal is evidence of the non-adversarial fault injection, not a
  // security boundary. Only the server adds an authenticated receipt to it.
  if (fs.existsSync(LOG)) {
    const size = fs.statSync(LOG).size;
    if (size > 1024 * 1024 || size < state.logOffset) throw new Error('Invalid encoder failure journal');
    const text = fs.readFileSync(LOG, 'utf8');
    const end = text.lastIndexOf('\n') + 1;
    for (const line of text.slice(state.logOffset, end).split('\n').filter(Boolean).slice(0, 128)) {
      const item = JSON.parse(line);
      if (item.exitCode !== 1 || typeof item.path !== 'string') throw new Error('Invalid encoder failure');
      results.push({path: item.path, exitCode: 1});
      state.logOffset += line.length + 1;
    }
  }
  // A valid header in a still-being-written MP4 is not completed encoding.
  // One oldest content baseline covers the whole concurrent batch; polling
  // neither appends snapshots nor consumes a pending-observation slot.
  if (!Object.keys(state.active).length && !Object.keys(state.jobs).length && !Object.keys(state.groups).length && state.baseline && !state.invalid) {
    const b = budget();
    try {
      const current = await videos(state, b);
      const {probe} = read(ROOT + '/binaries.json');
      for (const [p, fp] of Object.entries(current)) {
        if (state.signed[p] === fp.content || state.baseline[p] === fp.content) continue;
        if (validVideo(p, probe, b)) {
          const now = await fingerprint(p, state, b);
          if (now?.metadata === fp.metadata && now.content === fp.content) {
            results.push({path: p, exitCode: 0});
            state.signed[p] = fp.content;
          }
        }
      }
      state.signed = Object.fromEntries(Object.entries(state.signed).filter(([p]) => p in current));
    } catch (error) {
      // Unknown/uninspected outcomes are not success. Keep native bash output
      // and failure receipts, and report the bounded observer's limitation.
      warning = error.message;
    }
    state.baseline = null;
  }
  save(STATE, state);
  process.stdout.write(JSON.stringify({results, warning}));
}

(async () => {
  const action = process.argv[2];
  const input = JSON.parse(process.argv[3] || '{}');
  if (action === 'prepare') await prepare();
  else if (action === 'initialize') await initialize(input.renderFails);
  else if (action === 'before') {
    const state = loadState();
    recover(state);
    // Enforce the limit before launching a new command, after reaping exits.
    // Existing jobs remain observable and are never discarded to meet a cap.
    if (Object.keys(state.active).length + Object.keys(state.jobs).length + Object.keys(state.groups).length >= MAX_COMMANDS) {
      save(STATE, state);
      throw new Error('Too many live native video commands (64)');
    }
    try {
      if (!state.baseline) state.baseline = Object.fromEntries(
        Object.entries(await videos(state, budget())).map(([p, fp]) => [p, fp.content]));
      state.active[input.id] = {created: Date.now()};
    } finally { save(STATE, state); }
  } else if (action === 'attach' || action === 'finish' || action === 'abort') {
    const state = loadState();
    if (action === 'attach') {
      const item = state.active[input.id];
      if (!item) throw new Error('Native observation lease expired before command start');
      item.pid = Number(process.argv[4]);
      item.start = processIdentity(item.pid);
      item.group = processFields(item.pid)?.[2];
      if (!item.start) throw new Error('Cannot identify native command process');
    } else finish(state, input.id, action === 'abort');
    save(STATE, state);
  } else if (action === 'after') await after(input);
  else throw new Error('Unknown native video observation phase');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;

// Eve hashes environment options for prepared images, not imported helper bodies.
export const NATIVE_VIDEO_EVAL_REVISION = createHash("sha256").update(OBSERVER_SOURCE).digest("hex");

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function observerCommand(seconds = 15): string {
  // Waiting follows the caller's cancellation; the owner has a bounded lifetime.
  return `flock /tmp/studio-video-eval.lock timeout -s KILL ${seconds}s node ${OBSERVER}`;
}

async function runObserver(sandbox: SandboxSession, phase: string, input: object = {}): Promise<string> {
  const result = await sandbox.run({
    command: `${observerCommand(phase === "prepare" ? 120 : 15)} ${phase} ${quote(JSON.stringify(input))}`,
  });
  if (result.exitCode !== 0) throw new Error(`Native video eval ${phase}: ${result.stderr}`);
  return result.stdout;
}

/** Called only while preparing the Docker image; never touches host binaries. */
export async function prepareNativeVideoEval(sandbox: SandboxSession): Promise<void> {
  const result = await sandbox.run({ command: `mkdir -p ${ROOT}` });
  if (result.exitCode !== 0) throw new Error("Cannot prepare native video eval observer");
  await sandbox.writeTextFile({ path: OBSERVER, content: OBSERVER_SOURCE });
  await runObserver(sandbox, "prepare");
}

/** renderFails must come from the selector's verified eval initiator. */
export async function initializeNativeVideoEval(sandbox: SandboxSession, renderFails: boolean): Promise<void> {
  await runObserver(sandbox, "initialize", { renderFails });
}

/** Pair the id with nativeVideoEvalCommand to register its live guest PID. */
export async function beforeNativeVideoEvalCommand(sandbox: SandboxSession): Promise<string> {
  const id = randomUUID();
  await runObserver(sandbox, "before", { id });
  return id;
}

/** Guest-side cleanup still runs when the public sandbox handle is aborted. */
export function nativeVideoEvalCommand(id: string, command: string): string {
  const input = quote(JSON.stringify({ id }));
  const phase = (name: string) => `${observerCommand()} ${name} ${input}`;
  return [
    "(",
    `trap ${quote(`${phase("finish")} >/dev/null 2>&1`)} EXIT`,
    `trap ${quote(`${phase("abort")} >/dev/null 2>&1; exit 143`)} TERM`,
    `trap ${quote(`${phase("abort")} >/dev/null 2>&1; exit 130`)} INT`,
    `${phase("attach")} "$BASHPID" || exit $?`,
    `bash -c ${quote(command)}`,
    ")",
  ].join("\n");
}

/** Best-effort on an abort-bound handle; guest traps and PID recovery back it up. */
export async function abortNativeVideoEvalCommand(sandbox: SandboxSession, id: string): Promise<void> {
  await runObserver(sandbox, "abort", { id });
}

/** Signs only observations collected after native execution, with a host-only key. */
export async function afterNativeVideoEvalCommand(
  sandbox: SandboxSession, id: string, output: BashToolOutput, token: string,
): Promise<BashToolOutput> {
  const text = await runObserver(sandbox, "after", {
    id, job: output.status === "running" ? output.outputDirectory : null,
    pid: output.status === "running" ? output.pid : null,
  });
  const report: unknown = JSON.parse(text);
  if (!report || typeof report !== "object" || !("results" in report)) throw new Error("Invalid native video report");
  const observations: unknown = report.results;
  if (!Array.isArray(observations) || observations.length > 1024) throw new Error("Invalid native video observations");
  const receipts = observations.map((value: unknown) => {
    if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string" ||
      value.path.length > 2048 || !("exitCode" in value) || (value.exitCode !== 0 && value.exitCode !== 1)) {
      throw new Error("Invalid native video observation");
    }
    return videoEvalReceipt(value.path, token, value.exitCode);
  });
  const warning = "warning" in report && typeof report.warning === "string" ? report.warning.slice(0, 1024) : undefined;
  return {
    ...output,
    stdout: receipts.length ? `${output.stdout}\n${receipts.join("\n")}\n` : output.stdout,
    stderr: warning ? `${output.stderr}\nNative video observation incomplete: ${warning}\n` : output.stderr,
  };
}
