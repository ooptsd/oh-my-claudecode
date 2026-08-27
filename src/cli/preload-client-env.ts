/**
 * Client env preload — side-effect module (T4a)
 *
 * The installer freezes `CLAUDE_CONFIG_DIR` (and derived paths) into
 * module-level constants at import time (src/installer/index.ts:39-46), and
 * src/cli/index.ts statically imports the installer. The only way to steer a
 * CodeBuddy session at `~/.codebuddy` before those constants freeze is to set
 * the environment BEFORE the installer module is evaluated. This module does
 * exactly that and must remain the FIRST import of src/cli/index.ts (all three
 * npm bins converge on the esbuild bundle bridge/cli.cjs whose entry preserves
 * import order, so the side effect runs before any installer module body).
 *
 * Resolution rules (see resolvePreloadPlan):
 *   1. Explicit `--client codebuddy` (space or `=` form) presets
 *      CLAUDE_CONFIG_DIR=~/.codebuddy, CLAUDE_MCP_CONFIG_PATH=~/.codebuddy/.mcp.json
 *      and OMC_CLIENT=codebuddy, overriding pre-existing values with a
 *      one-shot stderr warning.
 *   2. Explicit `--client claude` sets OMC_CLIENT=claude only (suppresses
 *      auto-detection; user keeps full CLAUDE_CONFIG_DIR semantics).
 *   3. No flag: auto-detect the CodeBuddy session signature
 *      (src/utils/client.ts). CodeBuddy → same preset as (1); anything else →
 *      complete no-op (zero env writes, Claude behavior byte-identical).
 *   4. Test guard: NODE_ENV=test or OMC_PRELOAD_DISABLED=1 disables (3)
 *      auto-detection only — explicit --client flags still apply so tests can
 *      pin the client explicitly.
 *
 * Invalid `--client <value>` is ignored here; commander's choices validation
 * on `omc setup --client` rejects it with a usage error.
 *
 * The module also exports the pure planner (resolvePreloadPlan) and applier
 * (applyPreloadPlan) for unit tests; the side effect runs exactly once, at
 * import time.
 */

import { homedir } from 'os';
import { join, normalize } from 'path';
import { detectClient } from '../utils/client.js';

export type PreloadClient = 'claude' | 'codebuddy';

export interface ClientEnvPreloadPlan {
  /** Resolved client, or null when the plan writes nothing. */
  client: PreloadClient | null;
  /** env assignments to apply (empty object = zero env writes). */
  env: Record<string, string>;
  /** Human-readable override warnings (emitted once, to stderr). */
  warnings: string[];
  /** True when auto-detection was skipped by the test guard. */
  autoDetectionSkipped: boolean;
}

const CLIENT_FLAG = '--client';
const VALID_CLIENTS: readonly PreloadClient[] = ['claude', 'codebuddy'];

/** Extract a valid `--client <name>` / `--client=<name>` value from raw argv. */
export function parseClientFlagArgv(argv: readonly string[]): PreloadClient | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === CLIENT_FLAG) {
      const value = argv[index + 1];
      return VALID_CLIENTS.includes(value as PreloadClient) ? (value as PreloadClient) : undefined;
    }
    if (arg.startsWith(`${CLIENT_FLAG}=`)) {
      const value = arg.slice(CLIENT_FLAG.length + 1);
      return VALID_CLIENTS.includes(value as PreloadClient) ? (value as PreloadClient) : undefined;
    }
  }
  return undefined;
}

function trimmed(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Build the env preset + warnings for a codebuddy target (flag or detected). */
function buildCodebuddyPlan(env: NodeJS.ProcessEnv): ClientEnvPreloadPlan {
  const configDir = normalize(join(homedir(), '.codebuddy'));
  const mcpConfigPath = normalize(join(homedir(), '.codebuddy', '.mcp.json'));

  const overridden: string[] = [];
  const recordOverridden = (key: string, nextValue: string): void => {
    const existing = trimmed(env, key);
    if (existing && normalize(existing) !== normalize(nextValue)) {
      overridden.push(`${key}="${existing}"`);
    }
  };
  recordOverridden('CLAUDE_CONFIG_DIR', configDir);
  recordOverridden('CLAUDE_MCP_CONFIG_PATH', mcpConfigPath);

  const warnings = overridden.length > 0
    ? [
      `[omc] CodeBuddy client preset is overriding explicitly set environment variables: ${overridden.join(', ')} (set OMC_CLIENT=claude to keep them)`,
    ]
    : [];

  return {
    client: 'codebuddy',
    env: {
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_MCP_CONFIG_PATH: mcpConfigPath,
      OMC_CLIENT: 'codebuddy',
    },
    warnings,
    autoDetectionSkipped: false,
  };
}

const NOOP_PLAN: ClientEnvPreloadPlan = {
  client: null,
  env: {},
  warnings: [],
  autoDetectionSkipped: false,
};

/**
 * Pure planner: decide which env assignments the preload should apply for the
 * given raw argv (post-node/script args, i.e. process.argv.slice(2) shape —
 * scanning the full argv is equally safe) and environment.
 */
export function resolvePreloadPlan(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ClientEnvPreloadPlan {
  const flagged = parseClientFlagArgv(argv);
  if (flagged === 'codebuddy') {
    return buildCodebuddyPlan(env);
  }
  if (flagged === 'claude') {
    return { client: 'claude', env: { OMC_CLIENT: 'claude' }, warnings: [], autoDetectionSkipped: false };
  }

  // No (valid) flag. Explicit flags are absent, so honour the test guard.
  const autoDetectionSkipped = env.NODE_ENV === 'test' || env.OMC_PRELOAD_DISABLED === '1';
  if (autoDetectionSkipped) {
    return { ...NOOP_PLAN, autoDetectionSkipped: true };
  }

  return detectClient(env) === 'codebuddy' ? buildCodebuddyPlan(env) : NOOP_PLAN;
}

/** Apply a plan: mutate env and emit warnings (single stderr write). */
export function applyPreloadPlan(
  plan: ClientEnvPreloadPlan,
  env: NodeJS.ProcessEnv = process.env,
  writeWarning: (message: string) => void = (message) => { process.stderr.write(`${message}\n`); },
): void {
  for (const [key, value] of Object.entries(plan.env)) {
    env[key] = value;
  }
  if (plan.warnings.length > 0) {
    writeWarning(plan.warnings.join('\n'));
  }
}

// Side effect: runs once, at import time, before any importer module body.
applyPreloadPlan(resolvePreloadPlan(process.argv.slice(2), process.env));
