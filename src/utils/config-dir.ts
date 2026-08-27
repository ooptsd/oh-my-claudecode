/**
 * Claude Code Configuration Directory Resolution
 *
 * Resolves the active Claude Code configuration directory, honouring
 * CLAUDE_CONFIG_DIR (absolute path, or ~-prefixed) with fallback to
 * ~/.claude. Trailing separators are stripped; filesystem roots are
 * preserved.
 *
 * In a detected CodeBuddy session (see src/utils/client.ts) this resolves to
 * ~/.codebuddy instead, so CodeBuddy hook state never lands in ~/.claude.
 *
 * Multi-surface mirrors (keep in sync):
 *   scripts/lib/config-dir.mjs   — ESM hook/HUD runtime
 *   scripts/lib/config-dir.cjs   — CJS bridge runtime
 *   scripts/lib/config-dir.sh    — POSIX shell runtime
 */

import { join } from 'path';
import { isCodebuddySession, resolveClientConfigDir } from './client.js';

let warnedCodebuddyConfigDirOverride = false;

/**
 * Resolve the Claude Code configuration directory.
 *
 * Delegates to resolveClientConfigDir() (client-aware). When the CodeBuddy
 * session signature outranks an ambient CLAUDE_CONFIG_DIR export, a
 * one-shot-per-process stderr warning explains the override; an explicit
 * OMC_CLIENT=codebuddy is user intent and stays silent.
 */
export function getClaudeConfigDir(): string {
  if (
    isCodebuddySession() &&
    process.env.OMC_CLIENT?.trim() !== 'codebuddy' &&
    process.env.CLAUDE_CONFIG_DIR?.trim()
  ) {
    if (!warnedCodebuddyConfigDirOverride) {
      warnedCodebuddyConfigDirOverride = true;
      process.stderr.write(
        '[omc] CodeBuddy session detected; ignoring CLAUDE_CONFIG_DIR and using ~/.codebuddy (set OMC_CLIENT=claude to override)\n',
      );
    }
  }
  return resolveClientConfigDir();
}

/**
 * Resolve the OMC global configuration/cache directory under the active Claude
 * config dir. This keeps hook/updater/HUD caches aligned with CLAUDE_CONFIG_DIR
 * instead of mixing in ~/.omc.
 */
export function getOmcConfigDir(): string {
  return join(getClaudeConfigDir(), '.omc');
}

/** Resolve the canonical update-check cache file path. */
export function getUpdateCheckCachePath(): string {
  return join(getOmcConfigDir(), 'update-check.json');
}
