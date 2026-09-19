import { homedir } from 'node:os';
import { join, normalize, parse, sep } from 'node:path';

// Client detection mirrors src/utils/client.ts (keep semantics in sync —
// enforced by src/__tests__/client-config-dir-mirrors.test.ts):
//   1. OMC_CLIENT=claude|codebuddy|zcode overrides detection (other values ignored)
//   2. CodeBuddy session signature wins over an ambient CLAUDE_CONFIG_DIR:
//      CODEBUDDY_PLUGIN_ROOT / CODEBUDDY_PLUGIN_DIRS / CODEBUDDY_PLUGIN_DATA
//      set to a non-empty value → ~/.codebuddy
//   3. ZCode session signature: ZCODE_APP_VERSION / ZCODE_PLUGIN_ROOT /
//      ZCODE_PLUGIN_DATA set to a non-empty value → ~/.zcode
//   4. otherwise CLAUDE_CONFIG_DIR (absolute or ~-prefixed) is honoured
//   5. fallback ~/.claude

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

const ZCODE_SESSION_ENV_KEYS = ['ZCODE_APP_VERSION', 'ZCODE_PLUGIN_ROOT', 'ZCODE_PLUGIN_DATA'];

function hasZcodeSessionEnv(env) {
  return ZCODE_SESSION_ENV_KEYS.some((key) => trimmedEnvValue(env, key) !== '');
}

export function detectClient(env = process.env) {
  const override = trimmedEnvValue(env, 'OMC_CLIENT');
  if (override === 'codebuddy') return 'codebuddy';
  if (override === 'claude') return 'claude';
  if (override === 'zcode') return 'zcode';
  if (hasCodebuddySessionEnv(env)) return 'codebuddy';
  if (hasZcodeSessionEnv(env)) return 'zcode';
  return 'claude';
}

function stripTrailingSep(p) {
  if (!p.endsWith(sep)) {
    return p;
  }

  return p === parse(p).root ? p : p.slice(0, -1);
}

let warnedCodebuddyConfigDirOverride = false;
let warnedZcodeConfigDirOverride = false;

export function getClaudeConfigDir() {
  const home = homedir();

  if (detectClient() === 'codebuddy') {
    // The session signature outranks an ambient CLAUDE_CONFIG_DIR export; an
    // explicit OMC_CLIENT=codebuddy is user intent and stays silent.
    if (
      trimmedEnvValue(process.env, 'OMC_CLIENT') !== 'codebuddy' &&
      trimmedEnvValue(process.env, 'CLAUDE_CONFIG_DIR') !== '' &&
      !warnedCodebuddyConfigDirOverride
    ) {
      warnedCodebuddyConfigDirOverride = true;
      process.stderr.write(
        '[omc] CodeBuddy session detected; ignoring CLAUDE_CONFIG_DIR and using ~/.codebuddy (set OMC_CLIENT=claude to override)\n',
      );
    }
    return stripTrailingSep(normalize(join(home, '.codebuddy')));
  }

  if (detectClient() === 'zcode') {
    // Same isolation as CodeBuddy: the ZCode session signature outranks an
    // ambient CLAUDE_CONFIG_DIR export; an explicit OMC_CLIENT=zcode is user
    // intent and stays silent.
    if (
      trimmedEnvValue(process.env, 'OMC_CLIENT') !== 'zcode' &&
      trimmedEnvValue(process.env, 'CLAUDE_CONFIG_DIR') !== '' &&
      !warnedZcodeConfigDirOverride
    ) {
      warnedZcodeConfigDirOverride = true;
      process.stderr.write(
        '[omc] ZCode session detected; ignoring CLAUDE_CONFIG_DIR and using ~/.zcode (set OMC_CLIENT=claude to override)\n',
      );
    }
    return stripTrailingSep(normalize(join(home, '.zcode')));
  }

  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();

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

export function getOmcConfigDir() {
  return join(getClaudeConfigDir(), '.omc');
}

export function getUpdateCheckCachePath() {
  return join(getOmcConfigDir(), 'update-check.json');
}
