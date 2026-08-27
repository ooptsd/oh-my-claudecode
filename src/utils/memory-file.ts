/**
 * Client-aware memory file naming
 *
 * OMC installs its managed memory block into the user-level config dir of the
 * host CLI it is serving. Claude Code (and ZCode) use `CLAUDE.md` with a
 * `CLAUDE-omc.md` companion; CodeBuddy reads `CODEBUDDY.md` (AGENTS.md
 * fallback, never CLAUDE.md), so a CodeBuddy session maps to
 * `CODEBUDDY.md`/`CODEBUDDY-omc.md` under `~/.codebuddy`.
 *
 * Pure helpers on top of src/utils/client.ts (no installer imports, no fs).
 * Consumers: installer read/write points, doctor conflicts, launch companion
 * detection, and the CLI preload (via src/cli/preload-client-env.ts).
 */

import { isCodebuddySession } from './client.js';

export const CLAUDE_MEMORY_FILE_NAME = 'CLAUDE.md';
export const CLAUDE_MEMORY_COMPANION_FILE_NAME = 'CLAUDE-omc.md';
export const CODEBUDDY_MEMORY_FILE_NAME = 'CODEBUDDY.md';
export const CODEBUDDY_MEMORY_COMPANION_FILE_NAME = 'CODEBUDDY-omc.md';

/** Main memory file name for the session's client (default: CLAUDE.md). */
export function getMemoryFileName(env: NodeJS.ProcessEnv = process.env): string {
  return isCodebuddySession(env) ? CODEBUDDY_MEMORY_FILE_NAME : CLAUDE_MEMORY_FILE_NAME;
}

/** Companion memory file name for the session's client (default: CLAUDE-omc.md). */
export function getMemoryCompanionFileName(env: NodeJS.ProcessEnv = process.env): string {
  return isCodebuddySession(env)
    ? CODEBUDDY_MEMORY_COMPANION_FILE_NAME
    : CLAUDE_MEMORY_COMPANION_FILE_NAME;
}
