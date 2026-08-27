/**
 * Installer client config-dir guard (T4b) + codebuddy install targeting.
 *
 * The installer freezes CLAUDE_CONFIG_DIR into module constants at import
 * time. These tests reload the installer under controlled env to simulate:
 *   1. CodeBuddy session where the preload DID run (constants aligned) —
 *      install proceeds and writes CODEBUDDY.md under ~/.codebuddy.
 *   2. CodeBuddy session where the preload FAILED (constants frozen to a
 *      claude-style dir) — install() throws fail-loud instead of writing.
 *   3. Claude session — guard passes, CLAUDE.md semantics unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';

const originalHome = process.env.HOME;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalOmcClient = process.env.OMC_CLIENT;
const originalMcpConfigPath = process.env.CLAUDE_MCP_CONFIG_PATH;
const originalCodebuddyKeys = ['CODEBUDDY_PLUGIN_ROOT', 'CODEBUDDY_PLUGIN_DIRS', 'CODEBUDDY_PLUGIN_DATA']
  .map((key) => [key, process.env[key]] as const);

let tempRoot: string;

function scrubEnv(): void {
  delete process.env.OMC_CLIENT;
  delete process.env.CLAUDE_MCP_CONFIG_PATH;
  for (const [key] of originalCodebuddyKeys) delete process.env[key];
}

async function loadInstaller() {
  vi.resetModules();
  return import('../index.js');
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'omc-client-guard-'));
  scrubEnv();
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  scrubEnv();
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  if (originalOmcClient === undefined) delete process.env.OMC_CLIENT; else process.env.OMC_CLIENT = originalOmcClient;
  if (originalMcpConfigPath === undefined) delete process.env.CLAUDE_MCP_CONFIG_PATH; else process.env.CLAUDE_MCP_CONFIG_PATH = originalMcpConfigPath;
  vi.restoreAllMocks();
});

describe('install() client config-dir guard', () => {
  it('throws when a CodeBuddy session meets constants frozen to a claude-style dir (preload failed)', async () => {
    const fakeHome = join(tempRoot, 'home');
    mkdirSync(fakeHome, { recursive: true });
    const fakeClaudeDir = join(tempRoot, 'claude-fallback');
    mkdirSync(fakeClaudeDir, { recursive: true });

    // Import while the process still looks like claude: the installer freezes
    // CLAUDE_CONFIG_DIR to the injected claude-style dir.
    process.env.HOME = fakeHome;
    process.env.CLAUDE_CONFIG_DIR = fakeClaudeDir;
    const { install } = await loadInstaller();

    // Now the session signature flips to CodeBuddy — exactly what happens when
    // the preload side effect did not run before the installer was evaluated.
    process.env.CODEBUDDY_PLUGIN_ROOT = '/plugins/omc';

    expect(() => install({ skipClaudeCheck: true, skipHud: true }))
      .toThrow(/CodeBuddy session detected/);
    expect(() => install({ skipClaudeCheck: true, skipHud: true }))
      .toThrow(/preload did not run/);
    // Fail-loud means fail-before-writes: the claude-style dir stays empty.
    expect(existsSync(join(fakeClaudeDir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(fakeHome, '.codebuddy'))).toBe(false);
  });

  it('proceeds in a CodeBuddy session whose constants are aligned, writing CODEBUDDY.md under ~/.codebuddy', async () => {
    const fakeHome = join(tempRoot, 'home');
    mkdirSync(fakeHome, { recursive: true });

    // Preload-equivalent env present BEFORE the installer import.
    process.env.HOME = fakeHome;
    process.env.OMC_CLIENT = 'codebuddy';
    const { install, CLAUDE_CONFIG_DIR } = await loadInstaller();

    expect(normalize(CLAUDE_CONFIG_DIR)).toBe(normalize(join(fakeHome, '.codebuddy')));

    const result = install({ force: true, skipClaudeCheck: true, skipHud: true });
    expect(result.success).toBe(true);

    const codebuddyMd = join(fakeHome, '.codebuddy', 'CODEBUDDY.md');
    expect(existsSync(codebuddyMd)).toBe(true);
    expect(readFileSync(codebuddyMd, 'utf8')).toContain('<!-- OMC:START -->');
    // Memory file naming: no CLAUDE.md / CLAUDE-omc.md in the codebuddy dir.
    expect(existsSync(join(fakeHome, '.codebuddy', 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(fakeHome, '.codebuddy', 'CLAUDE-omc.md'))).toBe(false);
    // State isolation: nothing touched a claude-style dir.
    expect(existsSync(join(fakeHome, '.claude'))).toBe(false);
  });

  it('keeps claude sessions on CLAUDE.md under the configured config dir', async () => {
    const fakeHome = join(tempRoot, 'home');
    const fakeClaudeDir = join(tempRoot, 'claude-home');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(fakeClaudeDir, { recursive: true });

    process.env.HOME = fakeHome;
    process.env.CLAUDE_CONFIG_DIR = fakeClaudeDir;
    const { install } = await loadInstaller();

    const result = install({ force: true, skipClaudeCheck: true, skipHud: true });
    expect(result.success).toBe(true);
    expect(existsSync(join(fakeClaudeDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(fakeClaudeDir, 'CODEBUDDY.md'))).toBe(false);
    expect(existsSync(join(fakeHome, '.codebuddy'))).toBe(false);
  });
});
