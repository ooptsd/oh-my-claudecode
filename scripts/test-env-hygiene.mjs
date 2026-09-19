// Vitest global setup: scrub host-session leakage of the ZCode client-detection
// signature keys so a test run is host-independent (T1 修复, 2026-09-18 裁定).
//
// A vitest process launched inside a ZCode host inherits ZCODE_* variables;
// without this scrub every unqualified getClaudeConfigDir()/detectClient()
// call site resolves to ~/.zcode and ~51 test files fail for host reasons.
//
// Scope is deliberately narrow: only the three detection allowlist keys are
// removed. OMC_CLIENT / CODEBUDDY_* / CLAUDE_CONFIG_DIR stay untouched —
// tests that need them set them explicitly, and scrubbing them could mask
// real leakage. Keep this list in sync with ZCODE_SESSION_ENV_KEYS in
// src/utils/client.ts.

const ZCODE_DETECTION_ENV_KEYS = [
  'ZCODE_APP_VERSION',
  'ZCODE_PLUGIN_ROOT',
  'ZCODE_PLUGIN_DATA',
];

for (const key of ZCODE_DETECTION_ENV_KEYS) {
  delete process.env[key];
}
