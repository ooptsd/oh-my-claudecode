/**
 * Subprocess helpers for `omc setup` / `omc install` integration tests.
 *
 * Each helper spawns the real CLI binary (`bin/oh-my-claudecode.js` →
 * `bridge/cli.cjs`) and returns the captured exit code + stdio. The point
 * is to exercise the wire-up end-to-end, not to drive the commander program
 * in-process (that's what the unit-level tests do via `buildProgram()`).
 *
 * Used by `setup-alias.test.ts` (T6) to confirm `omc setup` is now a thin
 * alias that forwards argv to `omc install`.
 *
 * `bridge/cli.cjs` must be in sync with `src/cli/index.ts` — CI runs
 * `npm run build` before `npm test`, so CI refreshes the bridge; locally,
 * run `npm run build:cli` first if you change src/cli/index.ts.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// __tests__/ under src/cli/, repo root is ../../../ from this file.
const repoRoot = resolve(here, '..', '..', '..');
const binPath = join(repoRoot, 'bin', 'oh-my-claudecode.js');
const repoNodeModules = join(repoRoot, 'node_modules');

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliRunEnv {
  HOME?: string;
  cwd?: string;
  // Allow extra passthrough env vars (rarely needed).
  [key: string]: string | undefined;
}

function ensureBuilt(): void {
  if (!existsSync(binPath)) {
    throw new Error(
      `CLI binary missing: ${binPath} — run \`npm run build:cli\` first.`
    );
  }
}

/**
 * Spawn `node bin/oh-my-claudecode.js <command> <args...>` and capture output.
 *
 * Host session ZCODE_* / CODEBUDDY_* env vars are scrubbed (mirrors
 * test-env-hygiene.mjs) so auto-detect lands on `claude` unless the caller
 * overrides OMC_CLIENT. The caller-supplied HOME + cwd let tests target a
 * throwaway tmpdir without polluting the developer's real $HOME.
 */
function runOmcCommand(
  command: string,
  args: string[],
  env: CliRunEnv,
): CliRunResult {
  ensureBuilt();
  const result = spawnSync('node', [binPath, command, ...args], {
    cwd: env.cwd,
    env: {
      HOME: env.HOME ?? '/tmp',
      PATH: process.env.PATH ?? '',
      // Prefer the repo's node_modules so spawned resolves the same deps.
      NODE_PATH: repoNodeModules,
      // Force auto-detect to land on `claude` unless caller overrides.
      OMC_CLIENT: '',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function runOmcSetup(
  args: string[],
  env: CliRunEnv = {},
): CliRunResult {
  return runOmcCommand('setup', args, env);
}

export function runOmcInstall(
  args: string[],
  env: CliRunEnv = {},
): CliRunResult {
  return runOmcCommand('install', args, env);
}
