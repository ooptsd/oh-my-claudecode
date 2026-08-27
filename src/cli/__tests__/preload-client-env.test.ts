/**
 * Client env preload tests (T4a).
 *
 * resolvePreloadPlan is pure (argv + env in, plan out). The import-time side
 * effect is exercised by mutating process.argv/env and dynamically importing
 * the module after vi.resetModules().
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';

const originalHome = process.env.HOME;
const originalArgv = process.argv.slice();
const originalEnvKeys = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_MCP_CONFIG_PATH',
  'OMC_CLIENT',
  'OMC_PRELOAD_DISABLED',
  'NODE_ENV',
  'CODEBUDDY_PLUGIN_ROOT',
  'CODEBUDDY_PLUGIN_DIRS',
  'CODEBUDDY_PLUGIN_DATA',
].map((key) => [key, process.env[key]] as const);

let fakeHome: string;

function scrubEnv(): void {
  for (const [key] of originalEnvKeys) delete process.env[key];
}

async function loadPreload() {
  vi.resetModules();
  return import('../preload-client-env.js');
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'omc-preload-home-'));
  scrubEnv();
  process.env.HOME = fakeHome;
});

afterEach(() => {
  scrubEnv();
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  for (const [key, value] of originalEnvKeys) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  process.argv = originalArgv.slice();
  rmSync(fakeHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const CODEBUDDY_DIR = () => normalize(join(fakeHome, '.codebuddy'));
const CODEBUDDY_MCP = () => normalize(join(fakeHome, '.codebuddy', '.mcp.json'));

describe('resolvePreloadPlan', () => {
  it('presets the codebuddy env for "--client codebuddy" (space form)', async () => {
    const { resolvePreloadPlan } = await loadPreload();
    const plan = resolvePreloadPlan(['setup', '--client', 'codebuddy'], {});
    expect(plan.client).toBe('codebuddy');
    expect(plan.env).toEqual({
      CLAUDE_CONFIG_DIR: CODEBUDDY_DIR(),
      CLAUDE_MCP_CONFIG_PATH: CODEBUDDY_MCP(),
      OMC_CLIENT: 'codebuddy',
    });
  });

  it('presets the codebuddy env for "--client=codebuddy" (equals form)', async () => {
    const { resolvePreloadPlan } = await loadPreload();
    const plan = resolvePreloadPlan(['setup', '--client=codebuddy'], {});
    expect(plan.client).toBe('codebuddy');
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe(CODEBUDDY_DIR());
    expect(plan.env.CLAUDE_MCP_CONFIG_PATH).toBe(CODEBUDDY_MCP());
  });

  it('"--client claude" only sets OMC_CLIENT (suppresses auto-detection)', async () => {
    const { resolvePreloadPlan } = await loadPreload();
    const plan = resolvePreloadPlan(['setup', '--client', 'claude'], { CODEBUDDY_PLUGIN_ROOT: '/p' });
    expect(plan.client).toBe('claude');
    expect(plan.env).toEqual({ OMC_CLIENT: 'claude' });
  });

  it('ignores invalid --client values (commander rejects them later)', async () => {
    const { resolvePreloadPlan } = await loadPreload();
    const plan = resolvePreloadPlan(['setup', '--client', 'zcode'], { NODE_ENV: 'test' });
    expect(plan.client).toBeNull();
    expect(plan.env).toEqual({});
  });

  it('no flag + CodeBuddy session signature auto-detects the preset', async () => {
    const { resolvePreloadPlan } = await loadPreload();
    const plan = resolvePreloadPlan(['setup'], { CODEBUDDY_PLUGIN_ROOT: '/plugins/omc' });
    expect(plan.client).toBe('codebuddy');
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe(CODEBUDDY_DIR());
  });

  it('no flag + claude environment is a complete no-op (zero env writes)', async () => {
    const { resolvePreloadPlan } = await loadPreload();
    const plan = resolvePreloadPlan(['setup'], { CLAUDE_CONFIG_DIR: '/custom/claude' });
    expect(plan.client).toBeNull();
    expect(plan.env).toEqual({});
    expect(plan.warnings).toEqual([]);
  });

  it('NODE_ENV=test skips auto-detection but keeps explicit flags working', async () => {
    const { resolvePreloadPlan } = await loadPreload();
    const skipped = resolvePreloadPlan(['setup'], { NODE_ENV: 'test', CODEBUDDY_PLUGIN_ROOT: '/p' });
    expect(skipped).toMatchObject({ client: null, env: {}, autoDetectionSkipped: true });

    const flagged = resolvePreloadPlan(['setup', '--client', 'codebuddy'], { NODE_ENV: 'test' });
    expect(flagged.client).toBe('codebuddy');
    expect(flagged.env.CLAUDE_CONFIG_DIR).toBe(CODEBUDDY_DIR());
  });

  it('OMC_PRELOAD_DISABLED=1 skips auto-detection only', async () => {
    const { resolvePreloadPlan } = await loadPreload();
    const skipped = resolvePreloadPlan(['setup'], { OMC_PRELOAD_DISABLED: '1', CODEBUDDY_PLUGIN_DATA: '/d' });
    expect(skipped).toMatchObject({ client: null, env: {}, autoDetectionSkipped: true });

    const flagged = resolvePreloadPlan(['setup', '--client=codebuddy'], { OMC_PRELOAD_DISABLED: '1' });
    expect(flagged.client).toBe('codebuddy');
  });

  it('warns once when overriding explicitly set, differing env values', async () => {
    const { resolvePreloadPlan } = await loadPreload();
    const plan = resolvePreloadPlan(
      ['setup', '--client', 'codebuddy'],
      { CLAUDE_CONFIG_DIR: '/custom/claude', CLAUDE_MCP_CONFIG_PATH: '/custom/mcp.json' },
    );
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('CLAUDE_CONFIG_DIR="/custom/claude"');
    expect(plan.warnings[0]).toContain('CLAUDE_MCP_CONFIG_PATH="/custom/mcp.json"');
  });

  it('does not warn when existing values already match the preset', async () => {
    const { resolvePreloadPlan } = await loadPreload();
    const plan = resolvePreloadPlan(
      ['setup', '--client', 'codebuddy'],
      { CLAUDE_CONFIG_DIR: CODEBUDDY_DIR(), CLAUDE_MCP_CONFIG_PATH: CODEBUDDY_MCP() },
    );
    expect(plan.warnings).toEqual([]);
  });

  it('auto-detected codebuddy sessions warn under the same rules', async () => {
    const { resolvePreloadPlan } = await loadPreload();
    const plan = resolvePreloadPlan(
      ['setup'],
      { CODEBUDDY_PLUGIN_DIRS: '/a:/b', CLAUDE_CONFIG_DIR: '/custom/claude' },
    );
    expect(plan.client).toBe('codebuddy');
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('CLAUDE_CONFIG_DIR="/custom/claude"');
  });
});

describe('applyPreloadPlan', () => {
  it('mutates env and emits one stderr write for warnings', async () => {
    const { resolvePreloadPlan, applyPreloadPlan } = await loadPreload();
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: '/custom/claude' };
    const plan = resolvePreloadPlan(['setup', '--client', 'codebuddy'], env);
    const writes: string[] = [];
    applyPreloadPlan(plan, env, (message) => writes.push(message));
    expect(env.CLAUDE_CONFIG_DIR).toBe(CODEBUDDY_DIR());
    expect(env.OMC_CLIENT).toBe('codebuddy');
    expect(writes).toHaveLength(1);
  });
});

describe('import-time side effect', () => {
  it('presets process env from raw argv before importers are evaluated', async () => {
    process.argv = ['/node', 'omc', 'setup', '--client', 'codebuddy'];
    await loadPreload();
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(CODEBUDDY_DIR());
    expect(process.env.CLAUDE_MCP_CONFIG_PATH).toBe(CODEBUDDY_MCP());
    expect(process.env.OMC_CLIENT).toBe('codebuddy');
  });

  it('auto-detects a codebuddy session at import time when not under test guard', async () => {
    delete process.env.NODE_ENV;
    delete process.env.OMC_PRELOAD_DISABLED;
    process.argv = ['/node', 'omc', 'setup'];
    process.env.CODEBUDDY_PLUGIN_ROOT = '/plugins/omc';
    await loadPreload();
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(CODEBUDDY_DIR());
    expect(process.env.OMC_CLIENT).toBe('codebuddy');
  });

  it('writes nothing at import time in a claude environment', async () => {
    delete process.env.NODE_ENV;
    process.argv = ['/node', 'omc', 'setup'];
    await loadPreload();
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(process.env.CLAUDE_MCP_CONFIG_PATH).toBeUndefined();
    expect(process.env.OMC_CLIENT).toBeUndefined();
  });
});
