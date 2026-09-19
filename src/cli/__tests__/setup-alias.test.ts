/**
 * `omc setup` → `omc install` thin alias (Task 6).
 *
 * The setup command is now an argv passthrough to install: setup's options
 * (--client, --workspace, --force, --quiet, --skip-hooks, --force-hooks,
 * --no-plugin, --plugin-dir-mode) are translated to install argv, then
 * install's existing dispatch (T3 user-level zcode / T4 workspace zcode /
 * installOmc for claude|codebuddy) handles the actual work.
 *
 * These tests drive the real CLI binary end-to-end so the argv passthrough
 * is exercised through the bridge build, not just the commander program.
 *
 * Both sides (setup alias + install) must leave the same user-level artifacts
 * in $HOME (case 1) and the same workspace artifacts in cwd (case 2).
 */

import { describe, it, expect } from 'vitest';
import { runOmcSetup, runOmcInstall } from './_helpers.js';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('omc setup thin alias to omc install', () => {
  it('omc setup --client zcode (no --workspace) produces same artifacts as omc install --client zcode', () => {
    const home1 = mkdtempSync(join(tmpdir(), 'omc-alias-setup-'));
    const home2 = mkdtempSync(join(tmpdir(), 'omc-alias-install-'));
    try {
      const a = runOmcSetup(['--client', 'zcode'], { HOME: home1 });
      const b = runOmcInstall(['--client', 'zcode'], { HOME: home2 });
      expect(a.exitCode).toBe(0);
      expect(b.exitCode).toBe(0);
      // 两边都有 ~/.zcode/AGENTS.md
      expect(existsSync(join(home1, '.zcode', 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(home2, '.zcode', 'AGENTS.md'))).toBe(true);
    } finally {
      rmSync(home1, { recursive: true, force: true });
      rmSync(home2, { recursive: true, force: true });
    }
  });

  it('omc setup --client zcode --workspace behaves like omc install --client zcode --workspace', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'omc-alias-ws-'));
    const home1 = mkdtempSync(join(tmpdir(), 'omc-alias-ws-setup-'));
    const home2 = mkdtempSync(join(tmpdir(), 'omc-alias-ws-install-'));
    try {
      const a = runOmcSetup(['--client', 'zcode', '--workspace'], {
        HOME: home1,
        cwd: workDir,
      });
      const b = runOmcInstall(['--client', 'zcode', '--workspace'], {
        HOME: home2,
        cwd: workDir,
      });
      expect(a.exitCode).toBe(0);
      expect(b.exitCode).toBe(0);
      expect(existsSync(join(workDir, '.zcode', 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(workDir, '.omc-version.json'))).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(home1, { recursive: true, force: true });
      rmSync(home2, { recursive: true, force: true });
    }
  });
});
