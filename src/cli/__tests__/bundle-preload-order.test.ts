/**
 * Bundle order guard for the client env preload (coarse-grained).
 *
 * src/cli/preload-client-env.ts must remain the first effective import of
 * src/cli/index.ts: the installer freezes CLAUDE_CONFIG_DIR into module-level
 * constants at init time, so the preload side effect has to run before any
 * installer module body (see the preload module doc).
 *
 * In the esbuild CJS bundle (bridge/cli.cjs) the runtime order of require-time
 * code is the file order of top-level (column 0) statements; module bodies
 * wrapped in __esm({...}) stay lazy until something calls their init function.
 * The guard therefore asserts, coarsely:
 *   1. the preload side-effect statement is present and top-level, and
 *   2. every top-level `init_installer();` call site appears LATER in the
 *      file than the preload statement (so the installer constants freeze
 *      after the preload ran), and
 *   3. the preload statement precedes the CLI `program2.parse()` tail.
 *
 * Purpose: catch import-reordering regressions (e.g. moving the preload
 * import below the installer import) that would silently break CodeBuddy
 * session steering. Skipped when the bundle has not been built.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BUNDLE = join(process.cwd(), 'bridge', 'cli.cjs');

describe('bridge/cli.cjs keeps the preload side effect ahead of installer init', () => {
  it.skipIf(!existsSync(BUNDLE))('preload statement precedes top-level init_installer() call sites', () => {
    const bundle = readFileSync(BUNDLE, 'utf-8');

    // Line offsets so "column 0" (top-level) can be detected per statement.
    let offset = 0;
    const topLevelLines: Array<{ offset: number; text: string }> = [];
    for (const line of bundle.split('\n')) {
      if (/^\S/.test(line)) topLevelLines.push({ offset, text: line });
      offset += line.length + 1;
    }

    const preloadLines = topLevelLines.filter(line => line.text.startsWith('applyPreloadPlan(resolvePreloadPlan('));
    expect(preloadLines.length, 'preload side-effect statement must be inlined top-level exactly once').toBe(1);
    const preloadOffset = preloadLines[0].offset;

    const installerInitOffsets = topLevelLines
      .filter(line => line.text === 'init_installer();')
      .map(line => line.offset);
    // Every require-time installer initialization must run after the preload.
    for (const initOffset of installerInitOffsets) {
      expect(initOffset, 'top-level init_installer() must not precede the preload statement').toBeGreaterThan(preloadOffset);
    }

    const parseOffset = bundle.lastIndexOf('program2.parse()');
    expect(parseOffset, 'CLI parse tail must exist').toBeGreaterThan(0);
    expect(preloadOffset).toBeLessThan(parseOffset);
  });
});
