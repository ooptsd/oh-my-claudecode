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
 *   1. `OMC_CLIENT=claude|codebuddy` — explicit override. Any other value is
 *      ignored and detection falls through, so a typo never blinds the
 *      auto-detection below.
 *   2. CodeBuddy session signature: any of `CODEBUDDY_PLUGIN_ROOT`,
 *      `CODEBUDDY_PLUGIN_DIRS`, `CODEBUDDY_PLUGIN_DATA` set to a non-empty
 *      value (hook-process evidence, gap-report P9). Weak signals such as
 *      `CODEBUDDY_PROJECT_DIR` or `CODEBUDDY_SERVICE_PROXY_URL` exist in
 *      non-plugin contexts too and are deliberately NOT sufficient on their
 *      own.
 *   3. (claude) ambient `CLAUDE_CONFIG_DIR` is honoured verbatim.
 *   4. (claude) default `~/.claude`.
 *
 * Layer 2 intentionally outranks an ambient `CLAUDE_CONFIG_DIR` export: a
 * shell-level export must never redirect CodeBuddy session state into
 * `~/.claude` (state isolation, plan principle P2). Callers that want to
 * surface that override may emit a stderr warning at the call site — the
 * warning lives with the callers so this module remains pure.
 *
 * ZCode is not modelled separately: it keeps the existing claude-style
 * resolution path (`CLAUDE_CONFIG_DIR` or `~/.claude`).
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
/** Host CLI identities OMC distinguishes. ZCode intentionally maps to 'claude'. */
export type OmcClient = 'claude' | 'codebuddy';
/**
 * Detect the host CLI for the given environment (defaults to process.env).
 *
 * See the module doc for the priority order. `CODEBUDDY_PROJECT_DIR`,
 * `CODEBUDDY_SERVICE_PROXY_URL` and other weak CodeBuddy signals never
 * decide the client on their own.
 */
export declare function detectClient(env?: NodeJS.ProcessEnv): OmcClient;
/** True when the given environment resolves to a CodeBuddy session. */
export declare function isCodebuddySession(env?: NodeJS.ProcessEnv): boolean;
/**
 * Resolve the config directory this session should use.
 *
 * CodeBuddy sessions resolve to `~/.codebuddy` (layers 1-2 above, overriding
 * an ambient CLAUDE_CONFIG_DIR). Everything else keeps the historical
 * `getClaudeConfigDir` semantics: `CLAUDE_CONFIG_DIR` (absolute or
 * ~-prefixed) with fallback to `~/.claude`. Trailing separators are
 * stripped; filesystem roots are preserved.
 */
export declare function resolveClientConfigDir(env?: NodeJS.ProcessEnv): string;
//# sourceMappingURL=client.d.ts.map