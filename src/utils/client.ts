/**
 * Client (host CLI) Detection and Session Config-Dir Resolution
 *
 * OMC hooks and runtime helpers execute inside multiple host CLIs. This
 * module is the TypeScript source of truth for deciding which client the
 * current process belongs to and which user-level config directory it should
 * use. It stays pure: env in, decision out — no installer imports, no
 * filesystem writes, no stderr output.
 *
 * Detection priority (specificity first):
 *   1. `OMC_CLIENT=claude|codebuddy|zcode` — explicit override. Any other value is
 *      ignored and detection falls through, so a typo never blinds the
 *      auto-detection below.
 *   2. CodeBuddy session signature: any of `CODEBUDDY_PLUGIN_ROOT`,
 *      `CODEBUDDY_PLUGIN_DIRS`, `CODEBUDDY_PLUGIN_DATA` set to a non-empty
 *      value (hook-process evidence, gap-report P9). Weak signals such as
 *      `CODEBUDDY_PROJECT_DIR` or `CODEBUDDY_SERVICE_PROXY_URL` exist in
 *      non-plugin contexts too and are deliberately NOT sufficient on their
 *      own.
 *   3. ZCode session signature: any of `ZCODE_APP_VERSION`,
 *      `ZCODE_PLUGIN_ROOT`, `ZCODE_PLUGIN_DATA` set to a non-empty value
 *      (spec §5.2, 2026-09-18 探针).
 *   4. (claude) ambient `CLAUDE_CONFIG_DIR` is honoured verbatim.
 *   5. (claude) default `~/.claude`.
 *
 * Layer 2 intentionally outranks an ambient `CLAUDE_CONFIG_DIR` export: a
 * shell-level export must never redirect CodeBuddy session state into
 * `~/.claude` (state isolation, plan principle P2). Callers that want to
 * surface that override may emit a stderr warning at the call site — the
 * warning lives with the callers so this module remains pure. Layer 3 gives
 * ZCode sessions the same isolation, resolving to `~/.zcode`; an explicit
 * `OMC_CLIENT=claude` suppresses the signature.
 *
 * Multi-surface mirrors (hand-written, keep semantics in sync — enforced by
 * src/__tests__/client-config-dir-mirrors.test.ts):
 *   scripts/lib/config-dir.mjs   — ESM hook/HUD runtime
 *   scripts/lib/config-dir.cjs   — CJS bridge runtime
 *   scripts/lib/config-dir.sh    — POSIX shell runtime (env existence checks
 *                                  only: no trimming/case-folding, so feed it
 *                                  clean lowercase values)
 *   scripts/lib/client-paths.mjs — project-level path helper for hook scripts
 *   templates/hooks/lib/config-dir.mjs — standalone-hooks payload copy of
 *                                  scripts/lib/config-dir.mjs
 */

import { join, normalize, parse, sep } from 'path';
import { homedir } from 'os';

/** Host CLI identities OMC distinguishes. */
export type OmcClient = 'claude' | 'codebuddy' | 'zcode';

/** Env keys whose presence identifies a CodeBuddy hook/session process (P9). */
const CODEBUDDY_SESSION_ENV_KEYS = [
  'CODEBUDDY_PLUGIN_ROOT',
  'CODEBUDDY_PLUGIN_DIRS',
  'CODEBUDDY_PLUGIN_DATA',
] as const;

/** Env keys whose presence identifies a ZCode session (spec §5.2, 2026-09-18 探针). */
const ZCODE_SESSION_ENV_KEYS = [
  'ZCODE_APP_VERSION',
  'ZCODE_PLUGIN_ROOT',
  'ZCODE_PLUGIN_DATA',
] as const;

function hasAnySessionEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  return keys.some((key) => trimmedValue(env, key) !== '');
}

/**
 * Trimmed value of `env[key]`, or '' when unset / whitespace-only.
 * @internal
 */
function trimmedValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Detect the host CLI for the given environment (defaults to process.env).
 *
 * See the module doc for the priority order. `CODEBUDDY_PROJECT_DIR`,
 * `CODEBUDDY_SERVICE_PROXY_URL` and other weak CodeBuddy signals never
 * decide the client on their own.
 */
export function detectClient(env: NodeJS.ProcessEnv = process.env): OmcClient {
  const override = trimmedValue(env, 'OMC_CLIENT');
  if (override === 'codebuddy') return 'codebuddy';
  if (override === 'claude') return 'claude';
  if (override === 'zcode') return 'zcode';
  if (hasAnySessionEnv(env, CODEBUDDY_SESSION_ENV_KEYS)) return 'codebuddy';
  if (hasAnySessionEnv(env, ZCODE_SESSION_ENV_KEYS)) return 'zcode';
  return 'claude';
}

/** True when the given environment resolves to a CodeBuddy session. */
export function isCodebuddySession(env: NodeJS.ProcessEnv = process.env): boolean {
  return detectClient(env) === 'codebuddy';
}

/** True when the given environment resolves to a ZCode session. */
export function isZcodeSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return detectClient(env) === 'zcode';
}

/**
 * Strip a single trailing path separator (preserve filesystem root).
 * @internal Shared with scripts/lib/config-dir.{mjs,cjs,sh} — keep in sync.
 */
function stripTrailingSep(p: string): string {
  if (!p.endsWith(sep)) {
    return p;
  }
  return p === parse(p).root ? p : p.slice(0, -1);
}

/**
 * Resolve the config directory this session should use.
 *
 * CodeBuddy sessions resolve to `~/.codebuddy` and ZCode sessions to
 * `~/.zcode` (layers 1-3 above, overriding an ambient CLAUDE_CONFIG_DIR).
 * Everything else keeps the historical `getClaudeConfigDir` semantics:
 * `CLAUDE_CONFIG_DIR` (absolute or ~-prefixed) with fallback to `~/.claude`.
 * Trailing separators are stripped; filesystem roots are preserved.
 */
export function resolveClientConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = homedir();

  if (detectClient(env) === 'codebuddy') {
    return stripTrailingSep(normalize(join(home, '.codebuddy')));
  }

  if (detectClient(env) === 'zcode') {
    return stripTrailingSep(normalize(join(home, '.zcode')));
  }

  const configured = trimmedValue(env, 'CLAUDE_CONFIG_DIR');

  if (!configured) {
    return stripTrailingSep(normalize(join(home, '.claude')));
  }

  if (configured === '~') {
    return stripTrailingSep(normalize(home));
  }

  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return stripTrailingSep(normalize(join(home, configured.slice(2))));
  }

  return stripTrailingSep(normalize(configured));
}
