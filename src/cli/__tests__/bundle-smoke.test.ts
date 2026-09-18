/**
 * Bundle smoke — three-form subprocess regression for the OMC install CLI.
 *
 * This file consolidates the subprocess-level wire-up checks for the three
 * install paths introduced or hardened by the zcode-workspace-support plan
 * (Tasks 3–6). The motivation is to keep a single, easily-skimmable suite
 * that exercises the real `bin/oh-my-claudecode.js` → `bridge/cli.cjs`
 * pipeline end-to-end (not just `buildProgram()` in-process):
 *
 *   Form 1 — default `omc install` (claude user-level path)
 *            Asserts exit 0 and that NO zcode workspace artifacts leak into
 *            $HOME or cwd. This pins the "byte-identical path" baseline: a
 *            future change that accidentally routes a default install into
 *            zcode/workspace paths would break this form.
 *
 *   Form 2 — `omc install --client zcode --workspace`
 *            Asserts exit 0 and that BOTH <cwd>/.zcode/AGENTS.md and
 *            <cwd>/.omc-version.json exist (workspace-level install lands
 *            .omc/ at the workspace top, not inside .zcode/ — spec W6).
 *
 *   Form 3 — `omc install --client claude --workspace` (E1)
 *            Asserts exit 1 and that stderr contains the documented
 *            conflict message: `--workspace currently only supports --client
 *            zcode`. Companion to `install-workspace-conflict.test.ts`,
 *            which covers both claude and codebuddy clients in isolation.
 *
 * All three forms share the `_helpers.ts` subprocess wrapper so spawn logic
 * lives in one place.
 *
 * Entry point: `bin/oh-my-claudecode.js` → `bridge/cli.cjs` (esbuild CJS
 * bundle, eager-build product). The bridge must be in sync with
 * `src/cli/index.ts` — CI runs `npm run build` before `npm test`; locally
 * run `npm run build:cli` first if you changed the install command.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOmcInstall } from './_helpers.js';

describe('bundle smoke — three-form install CLI wire-up', () => {
  it('Form 1: default `omc install` (claude path) exits 0 and leaves no zcode workspace artifacts', () => {
    const home = mkdtempSync(join(tmpdir(), 'omc-bundle-smoke-default-home-'));
    const workDir = mkdtempSync(join(tmpdir(), 'omc-bundle-smoke-default-cwd-'));
    try {
      const result = runOmcInstall([], { HOME: home, cwd: workDir });

      expect(result.exitCode).toBe(0);

      // Claude user-level path must not leak into zcode workspace slots.
      // The byte-identical baseline: any future refactor that routes a
      // default install into `.zcode/` or writes `.omc-version.json` here
      // will fail this guard.
      expect(existsSync(join(home, '.zcode', 'AGENTS.md'))).toBe(false);
      expect(existsSync(join(home, '.omc-version.json'))).toBe(false);
      expect(existsSync(join(workDir, '.zcode', 'AGENTS.md'))).toBe(false);
      expect(existsSync(join(workDir, '.omc-version.json'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('Form 2: `omc install --client zcode --workspace` exits 0 and writes workspace artifacts', () => {
    const home = mkdtempSync(join(tmpdir(), 'omc-bundle-smoke-ws-home-'));
    const workDir = mkdtempSync(join(tmpdir(), 'omc-bundle-smoke-ws-cwd-'));
    try {
      const result = runOmcInstall(['--client', 'zcode', '--workspace'], {
        HOME: home,
        cwd: workDir,
      });

      expect(result.exitCode).toBe(0);

      // Workspace-level zcode install (T4 spec): <cwd>/.zcode/AGENTS.md AND
      // <cwd>/.omc-version.json (the latter sits at workspace top, OUTSIDE
      // .zcode/, per spec W6). Both must exist; if either is missing the
      // setupZcode workspace branch did not run.
      expect(existsSync(join(workDir, '.zcode', 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(workDir, '.omc-version.json'))).toBe(true);

      // And must NOT pollute $HOME — workspace installs write to cwd, not
      // the user-level ~/.zcode.
      expect(existsSync(join(home, '.zcode', 'AGENTS.md'))).toBe(false);
      expect(existsSync(join(home, '.omc-version.json'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('Form 3: `omc install --client claude --workspace` (E1) exits 1 with the conflict message', () => {
    const home = mkdtempSync(join(tmpdir(), 'omc-bundle-smoke-e1-home-'));
    const workDir = mkdtempSync(join(tmpdir(), 'omc-bundle-smoke-e1-cwd-'));
    try {
      const result = runOmcInstall(['--client', 'claude', '--workspace'], {
        HOME: home,
        cwd: workDir,
      });

      // E1 must surface BEFORE any installer work runs — no ~/.claude or
      // <cwd>/.zcode side effects, and a clean non-zero exit.
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--workspace currently only supports --client zcode');
      expect(result.stderr).toContain('--client claude');

      // Defensive: confirm the E1 short-circuit really short-circuited.
      expect(existsSync(join(home, '.claude', 'AGENTS.md'))).toBe(false);
      expect(existsSync(join(workDir, '.zcode', 'AGENTS.md'))).toBe(false);
      expect(existsSync(join(workDir, '.omc-version.json'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
