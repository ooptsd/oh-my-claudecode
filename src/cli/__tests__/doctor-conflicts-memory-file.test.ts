/**
 * doctor conflicts — client-aware memory file read points (T4c peripheral).
 *
 * checkClaudeMdStatus() must look for CODEBUDDY.md/CODEBUDDY-omc.md inside
 * ~/.codebuddy during a CodeBuddy session, and keep reading CLAUDE.md/
 * CLAUDE-omc.md in claude sessions (no false conflicts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { checkClaudeMdStatus } from '../commands/doctor-conflicts.js';
import { OMC_END_MARKER, OMC_START_MARKER } from '../../installer/claude-md-analysis.js';

const originalHome = process.env.HOME;
const originalEnvKeys = ['CLAUDE_CONFIG_DIR', 'OMC_CLIENT', 'CODEBUDDY_PLUGIN_ROOT', 'CODEBUDDY_PLUGIN_DIRS', 'CODEBUDDY_PLUGIN_DATA']
  .map((key) => [key, process.env[key]] as const);

let fakeHome: string;

function scrubEnv(): void {
  for (const [key] of originalEnvKeys) delete process.env[key];
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'omc-doctor-memory-'));
  scrubEnv();
  process.env.HOME = fakeHome;
});

afterEach(() => {
  scrubEnv();
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  for (const [key, value] of originalEnvKeys) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('checkClaudeMdStatus client-aware read points', () => {
  it('reads CODEBUDDY.md under ~/.codebuddy in a CodeBuddy session', () => {
    const configDir = join(fakeHome, '.codebuddy');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'CODEBUDDY.md'),
      `${OMC_START_MARKER}\n# managed\n${OMC_END_MARKER}\n`,
    );

    process.env.CODEBUDDY_PLUGIN_ROOT = '/plugins/omc';
    const status = checkClaudeMdStatus();
    expect(status).not.toBeNull();
    expect(normalize(status!.path)).toBe(normalize(join(configDir, 'CODEBUDDY.md')));
    expect(status!.hasMarkers).toBe(true);
  });

  it('keeps reading CLAUDE.md under ~/.claude in a claude session', () => {
    const configDir = join(fakeHome, '.claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'CLAUDE.md'),
      `${OMC_START_MARKER}\n# managed\n${OMC_END_MARKER}\n`,
    );

    const status = checkClaudeMdStatus();
    expect(status).not.toBeNull();
    expect(normalize(status!.path)).toBe(normalize(join(configDir, 'CLAUDE.md')));
    expect(status!.hasMarkers).toBe(true);
  });

  it('reports null for a fresh claude session with no memory files anywhere', () => {
    expect(checkClaudeMdStatus()).toBeNull();
  });

  it('does not treat a claude-mode CLAUDE.md as a codebuddy memory file', () => {
    const claudeDir = join(fakeHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'CLAUDE.md'),
      `${OMC_START_MARKER}\n# managed\n${OMC_END_MARKER}\n`,
    );

    process.env.OMC_CLIENT = 'codebuddy';
    const status = checkClaudeMdStatus();
    // The codebuddy config dir has no CODEBUDDY.md and no generic companions:
    // doctor must not reach into ~/.claude for it.
    expect(status).toBeNull();
  });
});
