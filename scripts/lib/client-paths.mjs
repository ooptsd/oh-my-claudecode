// Client-aware project-level path resolution for hook scripts.
//
// CodeBuddy only reads `.codebuddy/settings.json` project settings (gap-report
// P11) and must not cross-read `.claude/` project state, so the load-bearing
// project-level reads (settings gate, omc.jsonc, todos.json, rules dirs) pick
// the directory name per session. Claude/ZCode sessions keep `.claude/`
// byte-for-byte.
//
// Detection mirrors src/utils/client.ts (keep semantics in sync — enforced by
// src/__tests__/client-config-dir-mirrors.test.ts). Self-contained on
// purpose: this helper ships with the plugin's scripts/ payload and is not
// part of the standalone hooks/lib singleton payload.

function trimmedEnvValue(env, key) {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

function hasCodebuddySessionEnv(env) {
  return (
    trimmedEnvValue(env, 'CODEBUDDY_PLUGIN_ROOT') !== '' ||
    trimmedEnvValue(env, 'CODEBUDDY_PLUGIN_DIRS') !== '' ||
    trimmedEnvValue(env, 'CODEBUDDY_PLUGIN_DATA') !== ''
  );
}

export function detectClient(env = process.env) {
  const override = trimmedEnvValue(env, 'OMC_CLIENT');
  if (override === 'codebuddy') return 'codebuddy';
  if (override === 'claude') return 'claude';
  return hasCodebuddySessionEnv(env) ? 'codebuddy' : 'claude';
}

export function isCodebuddySession(env = process.env) {
  return detectClient(env) === 'codebuddy';
}

/**
 * Project-level client settings directory name for the current session:
 * '.codebuddy' in CodeBuddy sessions, '.claude' otherwise (Claude/ZCode).
 */
export function projectClientDirName(env = process.env) {
  return isCodebuddySession(env) ? '.codebuddy' : '.claude';
}
