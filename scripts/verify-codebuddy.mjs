#!/usr/bin/env node
/**
 * scripts/verify-codebuddy.mjs — T6 e2e verification for CodeBuddy CLI support.
 *
 * Plan: `.omc/plans/omc-codebuddy-support.md` §6 T6 + §7 AC (v5, post D1/D2).
 * Gap report (assertion calibration): `.omc/research/omc-codebuddy-gap-report.md`.
 *
 * Pipeline (each step records PASS/FAIL/SKIP + evidence into a result JSON):
 *   AC1  `codebuddy plugin validate <OMC root>` → 0 error
 *   pre  known_marketplaces "omc" conflict pre-check + byte snapshot of the
 *        three ~/.codebuddy state files (restored byte-for-byte at the end)
 *   AC2  marketplace add (directory) + install → enabledPlugins["oh-my-claudecode@omc"]===true
 *   AC10 `node bin/oh-my-claudecode.js setup --client codebuddy` (real env) →
 *        real ~/.claude managed paths zero-added / zero-modified (noise excluded)
 *   AC3  runtime smoke via `--plugin-dir` (D2 channel): component count line
 *        "19 agent(s), 21 command(s), 31 skill(s), 26 hook(s), 1 MCP server(s)"
 *        + 21 unique `oh-my-claudecode:<cmd>` strings in stream-json output
 *   AC5  in-session MCP connection proof: model actually calls an mcp__t__* tool
 *   AC4  hooks state isolation: new writes under ~/.codebuddy side; ~/.claude/.omc
 *        zero additions inside the session window (evidence events:
 *        SessionStart/Stop/PreToolUse/PostToolUse — UserPromptSubmit is racy in -p)
 *   AC6  agents/ zero git changes + AgentModelResolver `original_models=[] -> resolved_models=[]`
 *   reverify  the applicable items of the gap report's "T3 后需重验项" list
 *   experiment (optional, 30-min timebox)  local git-type marketplace → cache
 *        materialization + whether a plain -p session loads the plugin
 *   cleanup  marketplace remove, delete plugin data/cache entries, restore the
 *        three state files byte-for-byte, terminal `plugin marketplace list` /
 *        `plugin list` state must equal the initial state
 *
 * Usage:
 *   node scripts/verify-codebuddy.mjs [--skip-experiment] [--keep-project]
 *        [--json-out <path>] [--project-dir <dir>]
 *
 * Real-environment safety: only the three snapshot files are restored in place;
 * OMC user-level artifacts newly created under ~/.codebuddy are removed; runtime
 * data (projects/, sessions/, logs/, history.jsonl, …) is exempted by design.
 * Real ~/.claude is only ever READ, never written, by this script.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OMC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const CB = path.join(HOME, '.codebuddy');
const CLAUDE = path.join(HOME, '.claude');

const STATE_FILES = {
  settings: path.join(CB, 'settings.json'),
  knownMarketplaces: path.join(CB, 'plugins', 'known_marketplaces.json'),
  installedPlugins: path.join(CB, 'plugins', 'installed_plugins.json'),
};

// Managed-scope assertion for AC10/AC4 (~/.claude is read-only for us).
const CLAUDE_MANAGED_FILES = [
  'settings.json',
  'CLAUDE.md',
  'CLAUDE-omc.md',
  '.omc-version.json',
  '.omc-config.json',
  '.claude.json',
];
const CLAUDE_MANAGED_DIRS = ['hooks', 'hud', 'agents', 'skills', 'plugins', '.omc'];
// Runtime noise from concurrent user sessions — excluded from the hard assertion.
const CLAUDE_EXCLUDED_NOISE = [
  '.session-stats.json', 'teams', 'tasks', 'projects', 'logs', 'shell-snapshots',
  'todos', 'todo', 'history.jsonl', 'file-history', 'statsig', 'ide', 'jobs',
  'backups', 'cache', 'daemon', 'daemon.lock', 'daemon.log', 'daemon.status.json',
  '.omc-update.log', '.last-cleanup', 'CLAUDE.md.backup.*',
];
// New ~/.codebuddy top-level entries we are allowed to delete at cleanup.
const OMC_ARTIFACT_NAMES = new Set([
  'CODEBUDDY.md', 'CODEBUDDY-omc.md', '.omc-version.json', '.omc-config.json',
  '.mcp.json', 'agents', 'skills', 'hooks', 'hud', '.omc',
]);

const HASH_CAP_BYTES = 16 * 1024 * 1024;
const CMD_TIMEOUT_MS = 115_000;
const EXPERIMENT_TIMEBOX_MS = 30 * 60 * 1000;

const MAIN_PROMPT =
  'Smoke test. Call the MCP tool named mcp__t__notepad_stats (server "t", zero arguments) ' +
  'exactly once, then reply with the raw JSON the tool returned followed by the token T6_SMOKE_OK. ' +
  'Do not call any other tool.';
const CONTROL_PROMPT = 'Reply with exactly the word OK and nothing else.';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const nowIso = () => new Date().toISOString();
const j = (x) => JSON.stringify(x, null, 2);

function parseArgv(argv) {
  const out = { skipExperiment: false, keepProject: false, jsonOut: null, projectDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--skip-experiment') out.skipExperiment = true;
    else if (a === '--keep-project') out.keepProject = true;
    else if (a === '--json-out') out.jsonOut = argv[++i];
    else if (a === '--project-dir') out.projectDir = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'usage: node scripts/verify-codebuddy.mjs [--skip-experiment] [--keep-project] [--json-out <path>] [--project-dir <dir>]\n',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || OMC_ROOT,
    timeout: opts.timeoutMs || CMD_TIMEOUT_MS,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
    env: process.env,
  });
  const stdout = res.stdout ? res.stdout.toString('utf8') : '';
  const stderr = res.stderr ? res.stderr.toString('utf8') : '';
  const timedOut = res.signal === 'SIGTERM' || res.signal === 'SIGKILL' ||
    (res.error && res.error.code === 'ETIMEDOUT');
  return { code: res.status, stdout, stderr, timedOut, error: res.error ? String(res.error) : null };
}

async function sha256File(file) {
  const st = await fsp.stat(file);
  if (!st.isFile()) return { hash: null, size: st.size, mtimeMs: st.mtimeMs };
  if (st.size > HASH_CAP_BYTES) return { hash: null, size: st.size, mtimeMs: st.mtimeMs };
  const buf = await fsp.readFile(file);
  return { hash: createHash('sha256').update(buf).digest('hex'), size: st.size, mtimeMs: st.mtimeMs };
}

/** Recursively map relPath -> {hash,size,mtimeMs} under root (missing root -> empty map). */
async function walkTree(root) {
  const out = new Map();
  async function rec(dir, rel) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full, relPath);
      else if (e.isFile()) out.set(relPath, await sha256File(full));
      else out.set(relPath, { hash: `special:${e.name}`, size: 0, mtimeMs: 0 });
    }
  }
  await rec(root, '');
  return out;
}

function diffTrees(before, after) {
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const modified = [];
  for (const k of before.keys()) {
    if (!after.has(k)) continue;
    const a = before.get(k);
    const b = after.get(k);
    if ((a.hash || `s${a.size}`) !== (b.hash || `s${b.size}`)) modified.push(k);
  }
  return { added, removed, modified };
}

async function topEntries(dir) {
  try {
    return (await fsp.readdir(dir)).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Result bookkeeping
// ---------------------------------------------------------------------------

const R = {
  meta: {
    startedAt: nowIso(),
    finishedAt: null,
    script: 'scripts/verify-codebuddy.mjs',
    omcRoot: OMC_ROOT,
    codebuddyVersion: null,
    nodeVersion: process.version,
    evidenceDir: null,
    resultJson: null,
    ambientEnvWarnings: [],
  },
  ac: {},
  reverify: [],
  experiment: { status: 'SKIP', reason: null, steps: [] },
  claudeDiff: { ac10: null, smokeWindow: null, excludedNoise: [] },
  codebuddySideWrites: {},
  cleanup: { steps: [], marketplaceListMatch: null, pluginListMatch: null, stateFilesRestored: false },
  failures: [],
};

function ac(id) {
  if (!R.ac[id]) R.ac[id] = { status: 'SKIP', assertions: [], evidence: [] };
  return R.ac[id];
}

function assertAC(id, name, pass, detail, evidencePath = null) {
  const a = ac(id);
  a.assertions.push({ name, pass: !!pass, detail: String(detail ?? '').slice(0, 6000) });
  if (evidencePath && !a.evidence.includes(evidencePath)) a.evidence.push(evidencePath);
  a.status = a.assertions.every((x) => x.pass) ? 'PASS' : 'FAIL';
  if (!pass) {
    R.failures.push({ ac: id, assertion: name, classification: 'unclassified', detail: String(detail ?? '').slice(0, 2000) });
  }
  return !!pass;
}

function reverify(id, title, status, conclusion, evidence = []) {
  R.reverify.push({ id, title, status, conclusion, evidence });
}

const EV = { dir: null };
async function ev(name, content) {
  if (!EV.dir) return null;
  const file = path.join(EV.dir, name);
  await fsp.writeFile(file, typeof content === 'string' ? content : content);
  return file;
}

const log = (msg) => process.stdout.write(`[t6] ${msg}\n`);

// ---------------------------------------------------------------------------
// Session log capture (~/.codebuddy/logs/<date>/<project>__<hash>.log, append-mode)
// ---------------------------------------------------------------------------

async function snapshotLogIndex() {
  const index = new Map(); // abs path -> size
  let dateDirs = [];
  try {
    dateDirs = (await fsp.readdir(path.join(CB, 'logs'), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return index;
  }
  const recent = dateDirs.slice(-2); // today + rollover safety
  for (const d of recent) {
    const dir = path.join(CB, 'logs', d);
    let files = [];
    try {
      files = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.log')) continue;
      const full = path.join(dir, f);
      try {
        const st = await fsp.stat(full);
        index.set(full, st.size);
      } catch { /* raced */ }
    }
  }
  return index;
}

/**
 * Run one codebuddy -p session and return its stream output plus the NEW bytes
 * appended to this project's session log during the run.
 */
async function runSession({ tag, projectDir, prompt, pluginDir, timeoutMs = CMD_TIMEOUT_MS }) {
  const logsBefore = await snapshotLogIndex();
  const args = [];
  if (pluginDir) args.push('--plugin-dir', pluginDir); // variadic: prompt must come AFTER it
  args.push('-p', '-y', '--output-format', 'stream-json', prompt);
  const startedAt = Date.now();
  const res = run('codebuddy', args, { cwd: projectDir, timeoutMs });
  const durationMs = Date.now() - startedAt;
  const streamPath = await ev(`${tag}.stream.txt`, res.stdout);
  const stderrPath = await ev(`${tag}.stderr.txt`, res.stderr);

  const logsAfter = await snapshotLogIndex();
  const projBase = path.basename(projectDir);
  let logExcerpt = '';
  const logFiles = [];
  for (const [file, sizeNow] of logsAfter) {
    if (!path.basename(file).includes(projBase)) continue;
    const sizeBefore = logsBefore.get(file);
    if (sizeBefore === undefined) {
      logFiles.push(file);
      logExcerpt += await fsp.readFile(file, 'utf8').catch(() => '');
    } else if (sizeNow > sizeBefore) {
      logFiles.push(file);
      const fh = await fsp.open(file, 'r').catch(() => null);
      if (fh) {
        const buf = Buffer.alloc(sizeNow - sizeBefore);
        const { bytesRead } = await fh.read(buf, 0, buf.length, sizeBefore);
        logExcerpt += buf.toString('utf8', 0, bytesRead);
        await fh.close();
      }
    }
  }
  const logPath = logExcerpt ? await ev(`${tag}.sessionlog-excerpt.log`, logExcerpt) : null;
  return {
    tag, code: res.code, timedOut: res.timedOut, error: res.error,
    stdout: res.stdout, stderr: res.stderr, durationMs,
    streamPath, stderrPath, logExcerpt, logPath, logFiles,
  };
}

function extractToolUses(stdout) {
  const names = new Set();
  const deferred = new Set(); // CodeBuddy lazy-execution wrapper: DeferExecuteTool{toolName}
  let toolResults = 0;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'tool_use' && typeof node.name === 'string') {
      names.add(node.name);
      const input = node.input || node.params;
      if ((node.name === 'DeferExecuteTool' || node.name === 'ExecuteTool') &&
          input && typeof input.toolName === 'string') {
        deferred.add(input.toolName);
      }
    }
    if (node.type === 'tool_result') toolResults += 1;
    for (const k of Object.keys(node)) walk(node[k]);
  }
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { walk(JSON.parse(t)); } catch { /* non-JSON line */ }
  }
  return { names: [...names].sort(), deferred: [...deferred].sort(), toolResults };
}

const COUNT_LINE_RE = /Loaded plugin components for (oh-my-claudecode@\S+): (\d+) agent\(s\), (\d+) command\(s\), (\d+) skill\(s\), (\d+) hook\(s\), (\d+) MCP server\(s\)/;

function findComponentCountLine(logText, pluginIdRe = /oh-my-claudecode@\S+/) {
  const lines = logText.split('\n');
  const matches = [];
  for (const line of lines) {
    const m = line.match(new RegExp(`Loaded plugin components for (${pluginIdRe.source}): (\\d+) agent\\(s\\), (\\d+) command\\(s\\), (\\d+) skill\\(s\\), (\\d+) hook\\(s\\), (\\d+) MCP server\\(s\\)`));
    if (m) {
      matches.push({
        line: line.trim(),
        pluginId: m[1],
        counts: { agents: +m[2], commands: +m[3], skills: +m[4], hooks: +m[5], mcp: +m[6] },
      });
    }
  }
  return matches;
}

function countNamespaceCommands(stdout) {
  const found = stdout.match(/oh-my-claudecode:[A-Za-z0-9_-]+/g) || [];
  return { unique: [...new Set(found)].sort(), count: new Set(found).size, total: found.length };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const state = {
  snapshots: {},       // name -> { existed, bytes, mode }
  initialCbTop: [],
  initialPluginsTop: [],
  initialMarketplaceNames: null,
  initialPluginListNames: null,
  addedMarketplaces: [],
  installedPluginIds: [],
  projectDir: null,
  cleaned: false,
};

async function snapshotStateFiles() {
  for (const [name, file] of Object.entries(STATE_FILES)) {
    try {
      const st = await fsp.stat(file);
      state.snapshots[name] = { existed: true, bytes: await fsp.readFile(file), mode: st.mode };
    } catch {
      state.snapshots[name] = { existed: false, bytes: null, mode: null };
    }
  }
}

async function restoreStateFiles() {
  const report = [];
  for (const [name, file] of Object.entries(STATE_FILES)) {
    const snap = state.snapshots[name];
    if (!snap) continue;
    if (snap.existed) {
      await fsp.writeFile(file, snap.bytes, { mode: snap.mode });
      report.push(`${name}: restored (${snap.bytes.length} bytes)`);
    } else {
      await fsp.rm(file, { force: true });
      report.push(`${name}: removed (did not exist before run)`);
    }
  }
  R.cleanup.stateFilesRestored = true;
  return report;
}

async function cleanup(reason) {
  if (state.cleaned) return;
  state.cleaned = true;
  const steps = R.cleanup.steps;
  steps.push({ step: 'cleanup-start', reason });

  // 1. best-effort plugin uninstalls (before marketplace removal)
  for (const pid of [...state.installedPluginIds].reverse()) {
    try {
      const res = run('codebuddy', ['plugin', 'uninstall', pid], { timeoutMs: 30_000 });
      steps.push({ step: `uninstall ${pid}`, code: res.code, stderr: res.stderr.slice(0, 500) });
    } catch (e) {
      steps.push({ step: `uninstall ${pid}`, error: String(e) });
    }
  }

  // 2. marketplace removal
  for (const mp of [...state.addedMarketplaces].reverse()) {
    try {
      const res = run('codebuddy', ['plugin', 'marketplace', 'remove', mp], { timeoutMs: 30_000 });
      steps.push({ step: `marketplace remove ${mp}`, code: res.code, stderr: res.stderr.slice(0, 500) });
    } catch (e) {
      steps.push({ step: `marketplace remove ${mp}`, error: String(e) });
    }
  }

  // 3. plugin data / cache / marketplaces entries we created
  const pluginsDir = path.join(CB, 'plugins');
  const currentPluginsTop = await topEntries(pluginsDir);
  const newPluginsEntries = currentPluginsTop.filter((e) => !state.initialPluginsTop.includes(e));
  for (const e of newPluginsEntries) {
    if (/^(omc|omc-git)$/.test(e) || /^oh-my-claudecode/.test(e)) {
      await fsp.rm(path.join(pluginsDir, e), { recursive: true, force: true });
      steps.push({ step: `rm plugins/${e}` });
    }
  }
  for (const sub of ['data', 'cache', 'marketplaces']) {
    const dir = path.join(pluginsDir, sub);
    let entries = [];
    try { entries = await fsp.readdir(dir); } catch { continue; }
    for (const e of entries) {
      if (/^oh-my-claudecode/.test(e) || e === 'omc' || e === 'omc-git') {
        await fsp.rm(path.join(dir, e), { recursive: true, force: true });
        steps.push({ step: `rm plugins/${sub}/${e}` });
      }
    }
  }

  // 4. OMC user-level artifacts newly created at ~/.codebuddy top level
  const currentCbTop = await topEntries(CB);
  const newCbEntries = currentCbTop.filter((e) => !state.initialCbTop.includes(e));
  for (const e of newCbEntries) {
    if (OMC_ARTIFACT_NAMES.has(e)) {
      await fsp.rm(path.join(CB, e), { recursive: true, force: true });
      steps.push({ step: `rm ~/.codebuddy/${e}` });
    } else {
      steps.push({ step: `left ~/.codebuddy/${e} (not an OMC artifact name)`, note: 'review manually' });
    }
  }

  // 5. byte-restore the three state files (last codebuddy-mutating step)
  steps.push({ step: 'restore state files', report: await restoreStateFiles() });

  // 6. terminal state must equal the initial state
  try {
    const mp = run('codebuddy', ['plugin', 'marketplace', 'list'], { timeoutMs: 30_000 });
    const names = JSON.parse(mp.stdout).map((x) => x.name).sort();
    R.cleanup.marketplaceListMatch = JSON.stringify(names) === JSON.stringify(state.initialMarketplaceNames);
    await ev('final-marketplace-list.txt', mp.stdout);
  } catch (e) {
    R.cleanup.marketplaceListMatch = null;
    steps.push({ step: 'final marketplace list', error: String(e) });
  }
  try {
    const pl = run('codebuddy', ['plugin', 'list'], { timeoutMs: 30_000 });
    const names = [...pl.stdout.matchAll(/>\s*([A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+)/g)].map((m) => m[1]).sort();
    R.cleanup.pluginListMatch = JSON.stringify(names) === JSON.stringify(state.initialPluginListNames);
    await ev('final-plugin-list.txt', pl.stdout);
  } catch (e) {
    R.cleanup.pluginListMatch = null;
    steps.push({ step: 'final plugin list', error: String(e) });
  }

  // 7. temp dirs
  if (state.projectDir && !FLAGS?.keepProject) {
    await fsp.rm(state.projectDir, { recursive: true, force: true });
    steps.push({ step: `rm -rf ${state.projectDir}` });
  }
  if (EXPERIMENT_DIR) {
    await fsp.rm(EXPERIMENT_DIR, { recursive: true, force: true });
    steps.push({ step: `rm -rf ${EXPERIMENT_DIR}` });
  }
  steps.push({ step: 'cleanup-end' });
}

let FLAGS = null;
let EXPERIMENT_DIR = null;
let reverifyPlaceholderRegistry = false;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  FLAGS = parseArgv(process.argv.slice(2));

  // ---- step 0: preflight -------------------------------------------------
  const versionRes = run('codebuddy', ['--version'], { timeoutMs: 15_000 });
  R.meta.codebuddyVersion = versionRes.stdout.trim() || versionRes.stderr.trim();
  log(`codebuddy ${R.meta.codebuddyVersion}, node ${process.version}, OMC root ${OMC_ROOT}`);

  const evidenceDir = `/tmp/omc-t6-evidence-${stamp()}`;
  await fsp.mkdir(evidenceDir, { recursive: true });
  EV.dir = evidenceDir;
  R.meta.evidenceDir = evidenceDir;

  for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_MCP_CONFIG_PATH', 'OMC_CLIENT', 'CODEBUDDY_PLUGIN_ROOT', 'CODEBUDDY_PLUGIN_DIRS', 'CODEBUDDY_PROJECT_DIR']) {
    if (process.env[key]) R.meta.ambientEnvWarnings.push(`${key}=${process.env[key]}`);
  }

  // temp project
  const projectDir = FLAGS.projectDir || '/tmp/omc-t6-project';
  state.projectDir = projectDir;
  await fsp.rm(projectDir, { recursive: true, force: true });
  await fsp.mkdir(projectDir, { recursive: true });
  run('git', ['init', '-q'], { cwd: projectDir, timeoutMs: 15_000 });
  await fsp.writeFile(path.join(projectDir, 'README.md'), '# omc t6 smoke project\n');
  log(`temp project: ${projectDir}`);

  // initial inventories + byte snapshots
  state.initialCbTop = await topEntries(CB);
  state.initialPluginsTop = await topEntries(path.join(CB, 'plugins'));
  const mpBefore = run('codebuddy', ['plugin', 'marketplace', 'list'], { timeoutMs: 30_000 });
  state.initialMarketplaceNames = JSON.parse(mpBefore.stdout).map((x) => x.name).sort();
  const plBefore = run('codebuddy', ['plugin', 'list'], { timeoutMs: 30_000 });
  state.initialPluginListNames = [...plBefore.stdout.matchAll(/>\s*([A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+)/g)].map((m) => m[1]).sort();
  await ev('initial-marketplace-list.txt', mpBefore.stdout);
  await ev('initial-plugin-list.txt', plBefore.stdout);
  await snapshotStateFiles();
  log(`initial marketplaces: [${state.initialMarketplaceNames.join(', ')}]`);

  // ---- step 1: AC1 validate ----------------------------------------------
  const validate = run('codebuddy', ['plugin', 'validate', OMC_ROOT], { timeoutMs: 60_000 });
  await ev('ac1-validate.txt', validate.stdout + '\n--stderr--\n' + validate.stderr);
  let validFlag = false;
  try {
    const jsonPart = validate.stdout.slice(validate.stdout.indexOf('{'));
    validFlag = JSON.parse(jsonPart).valid === true;
  } catch { /* fall through to regex */ }
  if (!validFlag) validFlag = /"valid"\s*:\s*true/.test(validate.stdout);
  assertAC('AC1', 'plugin validate 0 error', validate.code === 0 && validFlag,
    `exit=${validate.code} valid=${validFlag}\n${validate.stdout.slice(0, 1500)}`,
    path.join(evidenceDir, 'ac1-validate.txt'));
  log(`AC1 validate: exit=${validate.code} valid=${validFlag}`);

  // ---- step 2: marketplace conflict pre-check ----------------------------
  if (state.initialMarketplaceNames.includes('omc')) {
    log('known marketplace "omc" already present → removing first');
    const rm = run('codebuddy', ['plugin', 'marketplace', 'remove', 'omc'], { timeoutMs: 30_000 });
    R.cleanup.steps.push({ step: 'pre-check: removed pre-existing omc marketplace', code: rm.code });
  }

  // ---- step 3: AC2 marketplace add + install ------------------------------
  const add = run('codebuddy', ['plugin', 'marketplace', 'add', OMC_ROOT], { timeoutMs: 60_000 });
  await ev('ac2-marketplace-add.txt', add.stdout + '\n--stderr--\n' + add.stderr);
  const addOk = add.code === 0 && /"name"\s*:\s*"omc"/.test(add.stdout);
  if (addOk) state.addedMarketplaces.push('omc');
  assertAC('AC2', 'marketplace add <OMC root>', addOk,
    `exit=${add.code}\n${add.stdout.slice(0, 800)}${add.stderr.slice(0, 400)}`,
    path.join(evidenceDir, 'ac2-marketplace-add.txt'));
  log(`AC2 marketplace add: exit=${add.code} ${add.stdout.trim().slice(0, 120)}`);

  if (addOk) {
    const install = run('codebuddy', ['plugin', 'install', 'oh-my-claudecode@omc'], { timeoutMs: 60_000 });
    await ev('ac2-plugin-install.txt', install.stdout + '\n--stderr--\n' + install.stderr);
    state.installedPluginIds.push('oh-my-claudecode@omc');
    let enabled = null;
    try {
      enabled = JSON.parse(await fsp.readFile(STATE_FILES.settings, 'utf8')).enabledPlugins?.['oh-my-claudecode@omc'];
    } catch (e) {
      ac('AC2').assertions.push({ name: 'settings.json parse', pass: false, detail: String(e) });
    }
    assertAC('AC2', 'install + enabledPlugins["oh-my-claudecode@omc"]===true',
      install.code === 0 && enabled === true,
      `install exit=${install.code}, enabled=${enabled}\n${install.stdout.slice(0, 800)}`,
      path.join(evidenceDir, 'ac2-plugin-install.txt'));
    log(`AC2 install: exit=${install.code} enabledPlugins=${enabled}`);

    // P2 contrast evidence for the gap report (directory install writes no registry/cache)
    const installedPluginsJson = await fsp.readFile(STATE_FILES.installedPlugins, 'utf8').catch(() => '');
    const registryHasOmc = /oh-my-claudecode/.test(installedPluginsJson);
    const cacheOmcExists = await fs.promises.access(path.join(CB, 'plugins', 'cache', 'omc')).then(() => true).catch(() => false);
    R.codebuddySideWrites.afterDirectoryInstall = {
      registryHasOmc, cacheOmcExists,
      note: 'P2: directory install writes settings/known_marketplaces only',
    };
    log(`after directory install: registryHasOmc=${registryHasOmc} cacheOmc=${cacheOmcExists}`);
  }

  // ---- step 4: AC10 setup --client codebuddy (real env) -------------------
  const claudeManagedBefore = await snapshotManagedClaude();
  const cbTopBeforeSetup = await topEntries(CB);
  const settingsBeforeSetup = await fsp.readFile(STATE_FILES.settings, 'utf8').catch(() => null);
  const claudeOmBefore = await walkTree(path.join(CLAUDE, '.omc'));

  const setup = run('node', [path.join(OMC_ROOT, 'bin', 'oh-my-claudecode.js'), 'setup', '--client', 'codebuddy'],
    { cwd: projectDir, timeoutMs: CMD_TIMEOUT_MS });
  await ev('ac10-setup-stdout.txt', setup.stdout);
  await ev('ac10-setup-stderr.txt', setup.stderr);
  log(`AC10 setup --client codebuddy: exit=${setup.code}`);

  const claudeManagedAfter = await snapshotManagedClaude();
  const ac10Diff = diffTrees(claudeManagedBefore.map, claudeManagedAfter.map);
  R.claudeDiff.ac10 = {
    scope: 'managed paths only (see excludedNoise for the rest)',
    added: ac10Diff.added, removed: ac10Diff.removed, modified: ac10Diff.modified,
  };
  assertAC('AC10', 'setup exit 0', setup.code === 0,
    `exit=${setup.code}\nstdout tail:\n${setup.stdout.split('\n').slice(-15).join('\n')}${setup.stderr.slice(0, 800)}`,
    path.join(evidenceDir, 'ac10-setup-stdout.txt'));
  assertAC('AC10', '~/.claude managed scope zero-added', ac10Diff.added.length === 0,
    `added: ${j(ac10Diff.added)}`);
  assertAC('AC10', '~/.claude managed scope zero-modified', ac10Diff.modified.length === 0,
    `modified: ${j(ac10Diff.modified)}`);
  assertAC('AC10', '~/.claude managed scope zero-removed', ac10Diff.removed.length === 0,
    `removed: ${j(ac10Diff.removed)}`);

  // positive evidence: what setup wrote on the codebuddy side (expected)
  const cbTopAfterSetup = await topEntries(CB);
  const settingsAfterSetup = await fsp.readFile(STATE_FILES.settings, 'utf8').catch(() => null);
  const settingsDelta = describeSettingsDelta(settingsBeforeSetup, settingsAfterSetup);
  const mcpJson = await fsp.readFile(path.join(CB, '.mcp.json'), 'utf8').catch(() => null);
  R.codebuddySideWrites.afterSetup = {
    newTopLevelEntries: cbTopAfterSetup.filter((e) => !cbTopBeforeSetup.includes(e)),
    settingsDelta,
    userMcpJson: mcpJson,
  };
  await ev('ac10-codebuddy-side-writes.json', j(R.codebuddySideWrites.afterSetup));
  log(`AC10 codebuddy-side writes: ${j(R.codebuddySideWrites.afterSetup.newTopLevelEntries)}; settings delta keys: ${j(Object.keys(settingsDelta))}`);

  // ---- step 5: AC3/AC5/AC4/AC6 runtime smoke via --plugin-dir -------------
  let smoke = null;
  let smokeAttempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const claudeOmPre = await walkTree(path.join(CLAUDE, '.omc'));
    const cbOmPre = await walkTree(path.join(CB, '.omc'));
    const dataPre = await topEntries(path.join(CB, 'plugins', 'data'));
    const s = await runSession({
      tag: `ac3-smoke-attempt${attempt}`,
      projectDir, prompt: MAIN_PROMPT, pluginDir: OMC_ROOT,
    });
    smokeAttempts.push({ attempt, code: s.code, timedOut: s.timedOut, durationMs: s.durationMs });
    smoke = s;
    smoke._claudeOmPre = claudeOmPre;
    smoke._cbOmPre = cbOmPre;
    smoke._dataPre = dataPre;

    const tools = extractToolUses(s.stdout);
    const ns = countNamespaceCommands(s.stdout);
    const countLines = findComponentCountLine(s.logExcerpt);
    const envFailure = s.timedOut || /network|ECONN|ETIMEDOUT|fetch failed|overloaded|rate.?limit/i.test(s.stderr);
    const mcpCalled = tools.names.some((n) => n.includes('mcp__t__')) ||
      tools.deferred.some((n) => n.includes('mcp__t__'));
    // Retry policy: retry ONLY environment-classified failures (timeout /
    // network / nonzero exit) plus model nondeterminism (no mcp__t__ call,
    // direct or via DeferExecuteTool). Functional assertion misses (count
    // line / namespace count) are recorded as-is without retry.
    const retryable = s.timedOut || envFailure || s.code !== 0 || !mcpCalled;
    if (!retryable) break;
    if (attempt === 1) {
      const why = s.timedOut ? 'timeout' : envFailure ? 'network-ish stderr' :
        (s.code !== 0 ? `exit=${s.code}` : 'model did not reach an mcp__t__ tool call (nondeterminism)');
      log(`smoke attempt 1 incomplete (${why}) — retrying once`);
      R.failures.push({ ac: 'AC3/AC5', assertion: `smoke attempt ${attempt}`, classification: 'environment', detail: why });
    }
  }
  await recordSmokeAssertions(smoke, smokeAttempts);

  // ---- step 6: control session (no --plugin-dir) → A0 reverify ------------
  let control = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const c = await runSession({ tag: `reverify-a0-control`, projectDir, prompt: CONTROL_PROMPT });
    control = c;
    const envFailure = c.timedOut || /network|ECONN|ETIMEDOUT|fetch failed|overloaded/i.test(c.stderr);
    if (c.code === 0 && !envFailure) break;
    if (attempt === 1) log(`control attempt 1 failed (exit=${c.code} timedOut=${c.timedOut}) — retrying once`);
  }
  {
    const countLines = findComponentCountLine(control.logExcerpt);
    const ns = countNamespaceCommands(control.stdout);
    reverify('A0', 'directory marketplace 插件在 -p 会话不加载(P0/P3)',
      countLines.length === 0 && ns.count === 0 ? 'PASS' : 'FAIL',
      countLines.length === 0 && ns.count === 0
        ? '预期不变:install+enable 后无 --plugin-dir 的 -p 会话仍未加载 omc 插件(日志无组件计数行、stream 无命名空间命令)——D2 冒烟通道选择 --plugin-dir 依然必要'
        : `意外加载!计数行:${j(countLines)};命名空间命令数=${ns.count}(若 CodeBuddy 升级让 live-directory 投影提前,R6 回归口径翻转)`,
      [control.logPath, control.streamPath].filter(Boolean));
    R.meta.a0Control = { code: control.code, durationMs: control.durationMs, nsCount: ns.count, countLines: countLines.length };
  }

  // ---- step 7: reverify assembly ------------------------------------------
  assembleReverify(smoke);

  // ---- step 8: optional git-type marketplace experiment -------------------
  if (FLAGS.skipExperiment) {
    R.experiment.reason = '--skip-experiment';
  } else {
    await runExperiment(projectDir).catch((e) => {
      R.experiment.status = 'FAIL';
      R.experiment.steps.push({ step: 'experiment crashed', error: String(e) });
    });
  }

  // ⑥-registry re-verify is filled from the experiment outcome (step 7 left a
  // placeholder because assembleReverify runs before the experiment).
  if (reverifyPlaceholderRegistry) {
    const entry = R.reverify.find((x) => x.id === '⑥-registry');
    const exp = R.experiment;
    if (exp.status === 'PASS' || exp.status === 'PARTIAL') {
      entry.status = exp.status;
      entry.conclusion = exp.conclusion || j(exp.steps.filter((s) => s.observation));
    } else if (exp.status === 'FAIL') {
      entry.status = 'BLOCKED';
      entry.conclusion = `实验失败,无法验证 registry/cache 行为:${exp.conclusion || j(exp.steps)}`;
    } else {
      entry.status = 'SKIP';
      entry.conclusion = '实验未执行(directory 分发不写 registry,OMC 解析器安全 no-op 见 T1⑥;R6/后续分发改型时重验)';
    }
  }
}

/** AC3/AC5/AC4/AC6 assertions over the (possibly retried) smoke session. */
async function recordSmokeAssertions(smoke, attempts) {
  log(`smoke final: exit=${smoke.code} dur=${smoke.durationMs}ms attempts=${attempts.length}`);

  // AC3a: component count line in the session log
  const countLines = findComponentCountLine(smoke.logExcerpt);
  const expected = { agents: 19, commands: 21, skills: 31, hooks: 26, mcp: 1 };
  const good = countLines.find((m) => JSON.stringify(m.counts) === JSON.stringify(expected));
  assertAC('AC3', 'log component count line 19/21/31/26/1', !!good,
    good ? good.line : `no matching line; found: ${j(countLines.map((m) => m.line))}`,
    smoke.logPath);

  // AC3b: 21 unique namespace command strings in stream-json
  const ns = countNamespaceCommands(smoke.stdout);
  await ev('ac3-namespace-commands.txt', ns.unique.join('\n'));
  assertAC('AC3', `stream-json 含 21 个 oh-my-claudecode:<cmd> 命名空间命令(实测 ${ns.count})`,
    ns.count === 21, `unique=${ns.count} total=${ns.total}\n${ns.unique.join(', ')}`,
    path.join(EV.dir, 'ac3-namespace-commands.txt'));
  ac('AC3').attempts = attempts;

  // AC5: real MCP connection — the model actually invoked an mcp__t__* tool,
  // either directly or through CodeBuddy's lazy DeferExecuteTool wrapper
  // (ToolSearch finds it, DeferExecuteTool{toolName} executes it).
  const tools = extractToolUses(smoke.stdout);
  const mcpCalls = [...tools.names, ...tools.deferred].filter((n) => n.includes('mcp__t__'));
  await ev('ac5-tool-uses.txt', j(tools));
  assertAC('AC5', '会话内实际调用 mcp__t__* 工具(连接证据)', mcpCalls.length > 0,
    mcpCalls.length > 0
      ? `调用工具: ${mcpCalls.join(', ')}${tools.deferred.length ? '(经 DeferExecuteTool 延迟执行通道)' : ''};tool_result 事件数=${tools.toolResults};全部 tool_use: ${tools.names.join(', ')};回显检查:${/T6_SMOKE_OK/.test(smoke.stdout) ? '含 T6_SMOKE_OK' : '未见 token(以 tool_use/tool_result 为准)'}`
      : `无 mcp__t__ 工具调用;本次全部 tool_use: ${j(tools.names)};deferred: ${j(tools.deferred)};exit=${smoke.code} stderr=${smoke.stderr.slice(0, 500)}`,
    path.join(EV.dir, 'ac5-tool-uses.txt'));

  // AC4: hooks state isolation
  const cbOmAfter = await walkTree(path.join(CB, '.omc'));
  const cbOmDiff = diffTrees(smoke._cbOmPre, cbOmAfter);
  const cbDataAfter = await topEntries(path.join(CB, 'plugins', 'data'));
  const newData = cbDataAfter.filter((e) => !smoke._dataPre.includes(e));
  await ev('ac4-codebuddy-om-diff.json', j({ cbOmDiff, newData }));
  assertAC('AC4', 'OMC hooks 状态落在 ~/.codebuddy 侧(会话窗口内 .omc 新写入)',
    cbOmDiff.added.length > 0 || cbOmDiff.modified.length > 0 || newData.some((e) => e.startsWith('oh-my-claudecode')),
    `.omc added=${j(cbOmDiff.added)} modified=${j(cbOmDiff.modified)};plugins/data 新增=${j(newData)}`,
    path.join(EV.dir, 'ac4-codebuddy-om-diff.json'));

  const claudeOmAfter = await walkTree(path.join(CLAUDE, '.omc'));
  const claudeOmDiff = diffTrees(smoke._claudeOmPre, claudeOmAfter);
  R.claudeDiff.smokeWindow = { scope: '~/.claude/.omc', ...claudeOmDiff };
  // Distinguish our session from concurrent user sessions: OMC cache-occupancy
  // files embed the watched directory — a hit on the smoke project is ours.
  let pollutionByOurSession = false;
  for (const rel of claudeOmDiff.added) {
    if (!rel.startsWith('cache-occupancy/')) continue;
    const content = await fsp.readFile(path.join(CLAUDE, '.omc', rel), 'utf8').catch(() => '');
    if (content.includes(path.basename(state.projectDir))) pollutionByOurSession = true;
  }
  assertAC('AC4', '~/.claude/.omc 会话窗口内零新增', claudeOmDiff.added.length === 0,
    claudeOmDiff.added.length === 0
      ? '零新增(T2 四镜像 client 化的反向证明成立)'
      : `新增=${j(claudeOmDiff.added)};其中引用冒烟项目路径(功能性污染)=${pollutionByOurSession};modified=${j(claudeOmDiff.modified)}(并发用户会话噪音按排除清单口径单独列出)`);

  // AC4 evidence events from the session log excerpt
  const hookSpawn = (re) => {
    const lines = smoke.logExcerpt.split('\n').filter((l) => /HookExecutor\] spawn/.test(l) && re.test(l));
    return lines.length;
  };
  const events = {
    SessionStart: hookSpawn(/scripts\/(session-start|wiki-session-start|project-memory-session)\.mjs/),
    Stop: hookSpawn(/scripts\/(context-guard-stop|session-end|wiki-session-end|verify-deliverables)\.mjs/),
    PreToolUse: hookSpawn(/scripts\/pre-tool-enforcer\.mjs/),
    PostToolUse: hookSpawn(/scripts\/(post-tool-verifier|post-tool-use-failure|post-tool-rules-injector|project-memory-posttool|subagent-tracker)\.mjs/),
    UserPromptSubmit: hookSpawn(/scripts\/(keyword-detector|skill-injector)\.mjs/),
  };
  await ev('ac4-hook-events.json', j(events));
  const evOk = events.SessionStart > 0 && events.Stop > 0 && events.PreToolUse > 0 && events.PostToolUse > 0;
  assertAC('AC4', 'hook 证据事件 SessionStart/Stop/PreToolUse/PostToolUse spawn 记录', evOk,
    `${j(events)}(UserPromptSubmit 在 -p 有竞态,不作判据;预期 0)`,
    path.join(EV.dir, 'ac4-hook-events.json'));

  // AC6: agents/ untouched + resolver fallback
  const gitAgents = run('git', ['-C', OMC_ROOT, 'status', '--porcelain', '--', 'agents/'], { timeoutMs: 15_000 });
  assertAC('AC6', 'git status --porcelain -- agents/ 为空', gitAgents.code === 0 && gitAgents.stdout.trim() === '',
    `exit=${gitAgents.code} output=${j(gitAgents.stdout)}`);
  const resolverLines = smoke.logExcerpt.split('\n').filter((l) => /AgentModelResolver\] agent "\S+" original_models=\[\] -> resolved_models=\[\]/.test(l));
  const architectResolved = resolverLines.some((l) => /agent "architect"/.test(l));
  await ev('ac6-resolver-lines.txt', resolverLines.join('\n'));
  assertAC('AC6', 'AgentModelResolver original_models=[] -> resolved_models=[] 回退(天然 inherit)', architectResolved,
    `空模型回退行数=${resolverLines.length};architect 命中=${architectResolved};样本=${resolverLines[0]?.trim() ?? '无'}`,
    path.join(EV.dir, 'ac6-resolver-lines.txt'));
}

async function snapshotManagedClaude() {
  const map = new Map();
  const excluded = [];
  let top = [];
  try { top = await fsp.readdir(CLAUDE); } catch { return { map, excluded }; }
  for (const name of top) {
    if (CLAUDE_MANAGED_FILES.includes(name)) {
      map.set(name, await sha256File(path.join(CLAUDE, name)));
    } else if (CLAUDE_MANAGED_DIRS.includes(name)) {
      const sub = await walkTree(path.join(CLAUDE, name));
      for (const [k, v] of sub) map.set(`${name}/${k}`, v);
    } else {
      excluded.push(name);
    }
  }
  R.claudeDiff.excludedNoise = excluded;
  return { map, excluded };
}

function describeSettingsDelta(before, after) {
  if (!before || !after) return { note: 'settings.json missing before or after' };
  try {
    const b = JSON.parse(before); const a = JSON.parse(after);
    const delta = {};
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
    for (const k of keys) {
      if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) delta[k] = { before: b[k], after: a[k] };
    }
    return delta;
  } catch (e) {
    return { note: `parse failure: ${e}` };
  }
}

function assembleReverify(smoke) {
  // item 2: UserPromptSubmit race — the PLUGIN-level hook must not spawn in -p
  // (T1: HookExtensionLoader registers too late). Note: the user-level
  // settings.json hook (installed by `omc setup`) registers synchronously and
  // DOES fire — distinguish by command string, only the plugin-level spawn
  // (`$CLAUDE_PLUGIN_ROOT"/scripts/...`) counts for the race conclusion.
  const spawnLines = smoke.logExcerpt.split('\n').filter((l) => /HookExecutor\] spawn/.test(l));
  const isPluginLevel = (l) => l.includes('$CLAUDE_PLUGIN_ROOT');
  const kwPlugin = spawnLines.filter((l) => /keyword-detector\.mjs/.test(l) && isPluginLevel(l)).length;
  const kwUser = spawnLines.filter((l) => /keyword-detector\.mjs/.test(l) && !isPluginLevel(l)).length;
  const siPlugin = spawnLines.filter((l) => /skill-injector\.mjs/.test(l) && isPluginLevel(l)).length;
  reverify('②-竞态', '插件级 UserPromptSubmit 在 -p 不触发(T1 竞态结论复验)',
    kwPlugin === 0 && siPlugin === 0 ? 'PASS' : 'FAIL',
    `插件级 spawn:keyword-detector=${kwPlugin}, skill-injector=${siPlugin}(预期 0,T1 竞态结论成立——OMC 关键词检测在 CodeBuddy headless 插件通道失效,已知限制);用户级 settings hook(omc setup 装入 ~/.codebuddy/settings.json)同步注册不受竞态影响,实测 keyword-detector spawn=${kwUser}(正向证据:用户级 hook 通道可用)`,
    [smoke.logPath].filter(Boolean));

  // item 3: ~/.claude zero writes — mirrors AC4/AC10 evidence
  const ac4pass = R.ac.AC4?.status === 'PASS';
  const ac10pass = R.ac.AC10?.status === 'PASS';
  reverify('②-落盘', '~/.claude 零写入(T2/T4 后应已修复为 ~/.codebuddy 侧)',
    ac4pass && ac10pass ? 'PASS' : 'FAIL',
    `AC10(setup 窗口)=${R.ac.AC10?.status ?? 'SKIP'}:${j(R.claudeDiff.ac10)};AC4(会话窗口 ~/.claude/.omc)=${R.ac.AC4?.status ?? 'SKIP'}:${j(R.claudeDiff.smokeWindow)}`);

  // item 4: counts — mirrors AC3
  reverify('④-计数', '组件计数 19/21/31/26/1 + 21 命名空间命令字符串',
    R.ac.AC3?.status === 'PASS' ? 'PASS' : 'FAIL',
    `AC3=${R.ac.AC3?.status ?? 'SKIP'}`);

  // item 5: ⑨ union semantics — variants cancelled (D1): no agents field must exist anywhere
  const pluginJson = fs.readFileSync(path.join(OMC_ROOT, '.claude-plugin', 'plugin.json'), 'utf8');
  const noAgentsField = !/"agents"\s*:/.test(pluginJson);
  reverify('⑨-并集', 'agents 变体已取消(D1):清单无 agents 指针,无遮蔽问题',
    noAgentsField ? 'PASS' : 'FAIL',
    noAgentsField ? '.claude-plugin/plugin.json 无 agents 字段(与 D1 裁决一致;交互模式 marketplace 命名空间形态仍未测,T7 已知未测项)'
      : 'plugin.json 出现 agents 字段——与 D1 冲突,需排查');

  // item 6: ⑦ deny enforcement — version unchanged → R6 regression item only
  reverify('⑦-deny', 'PreToolUse deny 在 -p 解析但不强制(P10)',
    R.meta.codebuddyVersion?.trim() === '2.140.0' ? 'PASS' : 'NEEDS-RERUN',
    `本机 CodeBuddy ${R.meta.codebuddyVersion}(T1 实测同版本,结论沿用;版本变更时按 R6 回归重测 deny 是否开始强制;enforcer 策略按 D3 降级为文档已知限制)`);

  // item 7: ⑥ registry — recorded after the git experiment (if it ran)
  reverify('⑥-registry', 'git/zip 型分发:installed_plugins registry 写入 + cache 物化 + roots 解析',
    'PENDING-EXPERIMENT',
    '由可选实验(T6 step 10)回填;directory 分发不写 registry,OMC 解析器安全 no-op 见 T1⑥');
  reverifyPlaceholderRegistry = true;

  // item 8: ① alias fallback — mirrors AC6 resolver evidence
  reverify('①-别名回退', '未知模型别名 original_models=[] -> resolved_models=[] 回退主模型',
    R.ac.AC6?.status === 'PASS' ? 'PASS' : 'FAIL',
    `AC6=${R.ac.AC6?.status ?? 'SKIP'}(未文档化实现细节,CodeBuddy 升级必重验;若开始硬失败则变体方案复活,但需先解决 ⑨ 遮蔽)`);
}

// ---------------------------------------------------------------------------
// Optional experiment: local git-type marketplace (30-min timebox)
// ---------------------------------------------------------------------------

async function currentMarketplaceNames() {
  try {
    const res = run('codebuddy', ['plugin', 'marketplace', 'list'], { timeoutMs: 30_000 });
    return JSON.parse(res.stdout).map((x) => x.name).sort();
  } catch {
    return [];
  }
}

async function runExperiment(projectDir) {
  const startedAt = Date.now();
  const exp = R.experiment;
  exp.status = 'RUNNING';
  const step = (s) => { exp.steps.push(s); log(`experiment: ${s.step}`); };
  const timeLeft = () => EXPERIMENT_TIMEBOX_MS - (Date.now() - startedAt);

  EXPERIMENT_DIR = `/tmp/omc-t6-exp-${stamp().slice(5)}`;
  await fsp.mkdir(EXPERIMENT_DIR, { recursive: true });
  const work = path.join(EXPERIMENT_DIR, 'work');
  const bare = path.join(EXPERIMENT_DIR, 'omc-git-mp.git');

  // clone OMC root, rename marketplace omc -> omc-git (avoid name clash), push to a local bare repo
  const clone = run('git', ['clone', '-q', '--no-hardlinks', OMC_ROOT, work], { timeoutMs: 120_000 });
  step({ step: 'clone OMC root', code: clone.code, stderr: clone.stderr.slice(0, 300) });
  if (clone.code !== 0) { exp.status = 'FAIL'; exp.conclusion = 'clone 失败'; return; }

  const mpFile = path.join(work, '.claude-plugin', 'marketplace.json');
  let mpJson = JSON.parse(await fsp.readFile(mpFile, 'utf8'));
  mpJson.name = 'omc-git';
  await fsp.writeFile(mpFile, j(mpJson));
  const commit = run('git', ['-C', work, '-c', 'user.email=t6@local', '-c', 'user.name=t6',
    'commit', '-qam', 't6 experiment: rename marketplace to omc-git'], { timeoutMs: 30_000 });
  run('git', ['-C', work, 'branch', '-M', 'main'], { timeoutMs: 15_000 });
  const initBare = run('git', ['init', '-q', '--bare', bare], { timeoutMs: 15_000 });
  const push = run('git', ['-C', work, 'push', '-q', bare, 'HEAD:refs/heads/main'], { timeoutMs: 60_000 });
  step({ step: 'prepare bare git marketplace', commit: commit.code, initBare: initBare.code, push: push.code });
  if (push.code !== 0) { exp.status = 'FAIL'; exp.conclusion = '本地 git 仓库准备失败'; return; }

  // marketplace add — try plain path, then file:// URL. The CLI infers the
  // type from the source; track EVERY marketplace name that actually appeared
  // (a misclassification can add junk like "temp") so cleanup removes it.
  const namesBeforeAdd = await currentMarketplaceNames();
  let add = run('codebuddy', ['plugin', 'marketplace', 'add', bare], { timeoutMs: 90_000 });
  let addForm = 'path';
  await ev('exp-marketplace-add-path.txt', add.stdout + '\n--stderr--\n' + add.stderr);
  if (add.code !== 0 || !/omc-git/.test(add.stdout)) {
    const add2 = run('codebuddy', ['plugin', 'marketplace', 'add', `file://${bare}`], { timeoutMs: 90_000 });
    await ev('exp-marketplace-add-fileurl.txt', add2.stdout + '\n--stderr--\n' + add2.stderr);
    if (add2.code === 0) { add = add2; addForm = 'file:// URL'; }
  }
  const namesAfterAdd = await currentMarketplaceNames();
  const addedNames = namesAfterAdd.filter((n) => !namesBeforeAdd.includes(n));
  for (const n of addedNames) state.addedMarketplaces.push(n);
  step({
    step: `marketplace add (${addForm})`,
    code: add.code,
    stdout: add.stdout.slice(0, 300),
    marketplacesActuallyAdded: addedNames,
  });
  if (!addedNames.includes('omc-git')) {
    exp.status = 'FAIL';
    exp.conclusion = `marketplace add 本地 git 仓库未识别为 git 型源${addedNames.length ? `(被误判为 directory 型市场 ${addedNames.join('/')},未读 manifest)` : '(add 失败)'};CodeBuddy 2.140.0 的 add 无 --type 选项,类型由 source 推断——本地 git 型市场需真实远程 git URL(https/git@)才可测,本机不可行;分发冒烟通道维持 --plugin-dir(已清理误加市场)`;
    for (const n of addedNames) {
      const rm = run('codebuddy', ['plugin', 'marketplace', 'remove', n], { timeoutMs: 30_000 });
      step({ step: `marketplace remove misclassified ${n}`, code: rm.code });
    }
    return;
  }

  const install = run('codebuddy', ['plugin', 'install', 'oh-my-claudecode@omc-git'], { timeoutMs: 90_000 });
  await ev('exp-plugin-install.txt', install.stdout + '\n--stderr--\n' + install.stderr);
  step({ step: 'install oh-my-claudecode@omc-git', code: install.code, stdout: install.stdout.slice(0, 300) });
  if (install.code !== 0) {
    exp.status = 'FAIL';
    exp.conclusion = 'git 型 install 失败';
    return;
  }
  state.installedPluginIds.push('oh-my-claudecode@omc-git');

  // observation: registry entry + cache materialization + marketplace clone
  const registry = await fsp.readFile(STATE_FILES.installedPlugins, 'utf8').catch(() => '{}');
  let registryEntry = null;
  try { registryEntry = JSON.parse(registry).plugins?.['oh-my-claudecode@omc-git'] ?? null; } catch { /* keep null */ }
  const cacheBase = path.join(CB, 'plugins', 'cache', 'omc-git');
  const cacheEntries = await topEntries(cacheBase);
  const cacheDeep = cacheEntries.length
    ? await topEntries(path.join(cacheBase, cacheEntries[0])) : [];
  const mpCloneExists = await fsp.access(path.join(CB, 'plugins', 'marketplaces', 'omc-git')).then(() => true).catch(() => false);
  step({
    step: 'observation: registry/cache/marketplace-clone',
    observation: {
      registryEntry, cacheTop: cacheEntries, cachePluginDir: cacheDeep, mpCloneExists,
    },
  });

  // does a plain -p session (no --plugin-dir) load it now?
  if (timeLeft() < 60_000) {
    step({ step: '-p load probe skipped (timebox)' });
    exp.status = 'PARTIAL';
    exp.conclusion = `registry/cache 观察完成但 -p 探测超出时间盒;registryEntry=${JSON.stringify(!!registryEntry)},cache 物化=${cacheEntries.length > 0}`;
    return;
  }
  let probe = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const c = await runSession({ tag: 'exp-plugindirless-probe', projectDir, prompt: CONTROL_PROMPT, timeoutMs: 90_000 });
    probe = c;
    if (c.code === 0 && !c.timedOut) break;
  }
  const countLines = findComponentCountLine(probe.logExcerpt);
  const ns = countNamespaceCommands(probe.stdout);
  const loaded = countLines.some((m) => m.pluginId.includes('oh-my-claudecode'));
  step({
    step: '-p load probe (no --plugin-dir)',
    loaded, countLines: countLines.map((m) => m.line), namespaceCommandCount: ns.count,
  });
  exp.loadedInPrintMode = loaded;
  exp.conclusion = loaded
    ? `本地 git 型 marketplace:install 写入 registry=${!!registryEntry},cache 物化=${cacheEntries.length > 0}(cache/${cacheEntries.join('/')});-p 会话实际加载(计数行+${ns.count} 命名空间命令)——git 型分发可作为比 --plugin-dir 更贴近真实分发的冒烟通道`
    : `本地 git 型 marketplace:install 写入 registry=${!!registryEntry},cache 物化=${cacheEntries.length > 0};但 -p 会话仍不加载(cache-first 投影对本地 git 型同样不生效或需要后台事务)——分发冒烟通道维持 --plugin-dir`;
  exp.status = loaded ? 'PASS' : 'PARTIAL';
}

// ---------------------------------------------------------------------------
// Entry / output
// ---------------------------------------------------------------------------

function classifyFailures() {
  for (const f of R.failures) {
    if (f.classification !== 'unclassified') continue;
    // default heuristic: exit-code/timeout/network → environment, else functional
    f.classification = /timeout|network|nondeterminism/i.test(f.assertion + f.detail)
      ? 'environment' : 'functional';
  }
}

function printSummary() {
  const line = '='.repeat(72);
  process.stdout.write(`\n${line}\nT6 verify-codebuddy summary\n${line}\n`);
  for (const id of ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC10']) {
    const a = R.ac[id];
    if (!a) { process.stdout.write(`${id.padEnd(5)} SKIP (not reached)\n`); continue; }
    process.stdout.write(`${id.padEnd(5)} ${a.status}\n`);
    for (const x of a.assertions) {
      process.stdout.write(`      [${x.pass ? 'x' : ' '}] ${x.name}${x.pass ? '' : ` — ${x.detail.split('\n')[0].slice(0, 160)}`}\n`);
    }
  }
  process.stdout.write(`\nre-verify items:\n`);
  for (const rv of R.reverify) process.stdout.write(`  ${rv.status.padEnd(10)} ${rv.id}  ${rv.conclusion.split('\n')[0].slice(0, 150)}\n`);
  process.stdout.write(`\nexperiment: ${R.experiment.status}${R.experiment.conclusion ? ` — ${R.experiment.conclusion.split('\n')[0].slice(0, 200)}` : ''}\n`);
  process.stdout.write(`\ncleanup: stateFilesRestored=${R.cleanup.stateFilesRestored} marketplaceListMatch=${R.cleanup.marketplaceListMatch} pluginListMatch=${R.cleanup.pluginListMatch}\n`);
  process.stdout.write(`evidence: ${R.meta.evidenceDir}\nresult:   ${R.meta.resultJson}\n${line}\n`);
}

async function writeResult() {
  R.meta.finishedAt = nowIso();
  classifyFailures();
  let out = FLAGS?.jsonOut;
  if (!out) {
    // Prefer the enclosing parent repo's .omc/research (plan/research docs live
    // there when OMC is checked out as a submodule); fall back to OMC root.
    let dir = null;
    let cur = OMC_ROOT;
    for (let i = 0; i < 4 && !dir; i += 1) {
      const candidate = path.join(cur, '.omc', 'research');
      if (fs.existsSync(candidate)) dir = candidate;
      else cur = path.dirname(cur);
    }
    out = path.join(dir || path.join(OMC_ROOT, '.omc'), 'omc-codebuddy-t6-result.json');
  }
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, j(R));
  R.meta.resultJson = out;
  return out;
}

let exiting = false;
async function exitWith(code) {
  if (exiting) process.exit(code);
  exiting = true;
  try { await cleanup('exit'); } catch (e) { process.stderr.write(`[t6] cleanup error: ${e}\n`); }
  await writeResult();
  printSummary();
  process.exit(code);
}

process.on('SIGINT', () => { exitWith(130); });
process.on('SIGTERM', () => { exitWith(143); });
// Crash resilience: cleanup + result write must run even on programming
// errors inside async helpers (an unhandled rejection would otherwise kill
// the process with the real ~/.codebuddy still mutated).
process.on('unhandledRejection', (reason) => {
  if (exiting) return;
  process.stderr.write(`[t6] unhandled rejection: ${reason?.stack || reason}\n`);
  R.failures.push({ ac: 'FATAL', assertion: 'unhandled rejection', classification: 'functional', detail: String(reason?.stack || reason) });
  exitWith(1);
});
process.on('uncaughtException', (err) => {
  if (exiting) return;
  process.stderr.write(`[t6] uncaught exception: ${err?.stack || err}\n`);
  R.failures.push({ ac: 'FATAL', assertion: 'uncaught exception', classification: 'functional', detail: String(err?.stack || err) });
  exitWith(1);
});

main()
  .then(async () => {
    const required = ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC10'];
    const notPassed = required.filter((id) => R.ac[id]?.status !== 'PASS');
    await exitWith(notPassed.length === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    process.stderr.write(`[t6] fatal: ${e?.stack || e}\n`);
    R.failures.push({ ac: 'FATAL', assertion: 'script crashed', classification: 'functional', detail: String(e?.stack || e) });
    await exitWith(1);
  });
