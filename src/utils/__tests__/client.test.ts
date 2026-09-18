import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import {
  detectClient,
  isCodebuddySession,
  isZcodeSession,
  resolveClientConfigDir,
} from '../client.js';

const originalHome = process.env.HOME;

describe('test-env hygiene (vitest setup scrubs host ZCODE_* leakage)', () => {
  it('detectClient() on the ambient process env stays client-neutral', () => {
    expect(detectClient()).toBe('claude');
    expect(isZcodeSession()).toBe(false);
  });
});

describe('detectClient priority matrix', () => {
  it('defaults to claude when nothing is set', () => {
    expect(detectClient({})).toBe('claude');
  });

  it.each([
    'CODEBUDDY_PLUGIN_ROOT',
    'CODEBUDDY_PLUGIN_DIRS',
    'CODEBUDDY_PLUGIN_DATA',
  ])('detects codebuddy from the %s session signature alone', (key) => {
    expect(detectClient({ [key]: '/some/value' })).toBe('codebuddy');
  });

  it('detects codebuddy when any signature key is set alongside weak signals', () => {
    expect(
      detectClient({ CODEBUDDY_PROJECT_DIR: '/proj', CODEBUDDY_PLUGIN_DATA: '/data' }),
    ).toBe('codebuddy');
  });

  it('ignores whitespace-only signature values', () => {
    expect(
      detectClient({
        CODEBUDDY_PLUGIN_ROOT: '   ',
        CODEBUDDY_PLUGIN_DIRS: ' ',
        CODEBUDDY_PLUGIN_DATA: '\t',
      }),
    ).toBe('claude');
  });

  it.each([
    'CODEBUDDY_PROJECT_DIR',
    'CODEBUDDY_SERVICE_PROXY_URL',
    'CODEBUDDY_INTERNET_ENVIRONMENT',
  ])('treats the weak signal %s alone as claude', (key) => {
    expect(detectClient({ [key]: '/some/value' })).toBe('claude');
  });

  it('honours OMC_CLIENT=codebuddy with no other signals', () => {
    expect(detectClient({ OMC_CLIENT: 'codebuddy' })).toBe('codebuddy');
  });

  it('honours OMC_CLIENT=claude even when CodeBuddy signature keys are set', () => {
    expect(
      detectClient({ OMC_CLIENT: 'claude', CODEBUDDY_PLUGIN_ROOT: '/p', CODEBUDDY_PLUGIN_DATA: '/d' }),
    ).toBe('claude');
  });

  it('trims OMC_CLIENT values', () => {
    expect(detectClient({ OMC_CLIENT: '  codebuddy ' })).toBe('codebuddy');
    expect(detectClient({ OMC_CLIENT: 'claude\t' })).toBe('claude');
  });

  it('falls through to auto-detection on unknown OMC_CLIENT values', () => {
    expect(detectClient({ OMC_CLIENT: 'bogus' })).toBe('claude');
    expect(detectClient({ OMC_CLIENT: 'bogus', CODEBUDDY_PLUGIN_ROOT: '/p' })).toBe('codebuddy');
  });

  it('isCodebuddySession mirrors detectClient', () => {
    expect(isCodebuddySession({ CODEBUDDY_PLUGIN_ROOT: '/p' })).toBe(true);
    expect(isCodebuddySession({ OMC_CLIENT: 'claude', CODEBUDDY_PLUGIN_ROOT: '/p' })).toBe(false);
    expect(isCodebuddySession({})).toBe(false);
  });
});

describe('resolveClientConfigDir', () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'omc-client-home-'));
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it('resolves ~/.claude by default', () => {
    expect(resolveClientConfigDir({})).toBe(normalize(join(fakeHome, '.claude')));
  });

  it('resolves ~/.codebuddy from the CodeBuddy session signature', () => {
    expect(resolveClientConfigDir({ CODEBUDDY_PLUGIN_ROOT: '/plugins/omc' })).toBe(
      normalize(join(fakeHome, '.codebuddy')),
    );
  });

  it('session signature outranks an ambient CLAUDE_CONFIG_DIR export', () => {
    expect(
      resolveClientConfigDir({ CODEBUDDY_PLUGIN_DIRS: '/a:/b', CLAUDE_CONFIG_DIR: '/tmp/omc-cc' }),
    ).toBe(normalize(join(fakeHome, '.codebuddy')));
  });

  it('OMC_CLIENT=codebuddy forces ~/.codebuddy over CLAUDE_CONFIG_DIR', () => {
    expect(
      resolveClientConfigDir({ OMC_CLIENT: 'codebuddy', CLAUDE_CONFIG_DIR: '/tmp/omc-cc' }),
    ).toBe(normalize(join(fakeHome, '.codebuddy')));
  });

  it('OMC_CLIENT=claude keeps CLAUDE_CONFIG_DIR semantics', () => {
    expect(
      resolveClientConfigDir({
        OMC_CLIENT: 'claude',
        CODEBUDDY_PLUGIN_ROOT: '/p',
        CLAUDE_CONFIG_DIR: '/tmp/omc-cc',
      }),
    ).toBe(normalize('/tmp/omc-cc'));
  });

  it('honours ambient CLAUDE_CONFIG_DIR when no CodeBuddy signal exists', () => {
    expect(resolveClientConfigDir({ CLAUDE_CONFIG_DIR: '/tmp/omc-cc' })).toBe(
      normalize('/tmp/omc-cc'),
    );
  });

  it('keeps the tilde-expansion contract for CLAUDE_CONFIG_DIR', () => {
    expect(resolveClientConfigDir({ CLAUDE_CONFIG_DIR: '~/.claude-alt' })).toBe(
      normalize(join(fakeHome, '.claude-alt')),
    );
    expect(resolveClientConfigDir({ CLAUDE_CONFIG_DIR: '~' })).toBe(normalize(fakeHome));
  });

  it('strips a trailing separator from custom paths', () => {
    expect(resolveClientConfigDir({ CLAUDE_CONFIG_DIR: '/tmp/omc-cc/' })).toBe(
      normalize('/tmp/omc-cc'),
    );
  });
});

describe('getClaudeConfigDir CodeBuddy override warning', () => {
  let fakeHome: string;
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalOmcClient = process.env.OMC_CLIENT;
  const originalPluginRoot = process.env.CODEBUDDY_PLUGIN_ROOT;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'omc-client-warn-home-'));
    process.env.HOME = fakeHome;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.OMC_CLIENT;
    delete process.env.CODEBUDDY_PLUGIN_ROOT;
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    if (originalOmcClient === undefined) {
      delete process.env.OMC_CLIENT;
    } else {
      process.env.OMC_CLIENT = originalOmcClient;
    }
    if (originalPluginRoot === undefined) {
      delete process.env.CODEBUDDY_PLUGIN_ROOT;
    } else {
      process.env.CODEBUDDY_PLUGIN_ROOT = originalPluginRoot;
    }
    vi.restoreAllMocks();
  });

  it('resolves ~/.codebuddy through the TS helper', async () => {
    process.env.CODEBUDDY_PLUGIN_ROOT = '/plugins/omc';
    const { getClaudeConfigDir } = await import('../config-dir.js');
    expect(getClaudeConfigDir()).toBe(normalize(join(fakeHome, '.codebuddy')));
  });

  it('warns once when the session signature outranks CLAUDE_CONFIG_DIR', async () => {
    process.env.CODEBUDDY_PLUGIN_ROOT = '/plugins/omc';
    process.env.CLAUDE_CONFIG_DIR = '/tmp/omc-cc';
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { getClaudeConfigDir } = await import('../config-dir.js');
    expect(getClaudeConfigDir()).toBe(normalize(join(fakeHome, '.codebuddy')));
    expect(getClaudeConfigDir()).toBe(normalize(join(fakeHome, '.codebuddy')));

    const warningCalls = stderrWrite.mock.calls.filter((args) =>
      String(args[0]).includes('CodeBuddy session detected'),
    );
    expect(warningCalls).toHaveLength(1);
  });

  it('stays silent for an explicit OMC_CLIENT=codebuddy', async () => {
    process.env.OMC_CLIENT = 'codebuddy';
    process.env.CLAUDE_CONFIG_DIR = '/tmp/omc-cc';
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { getClaudeConfigDir } = await import('../config-dir.js');
    expect(getClaudeConfigDir()).toBe(normalize(join(fakeHome, '.codebuddy')));

    const warningCalls = stderrWrite.mock.calls.filter((args) =>
      String(args[0]).includes('CodeBuddy session detected'),
    );
    expect(warningCalls).toHaveLength(0);
  });
});

describe('zcode client detection', () => {
  it('detects ZCODE_APP_VERSION session signature', () => {
    expect(detectClient({ ZCODE_APP_VERSION: '3.12.3' })).toBe('zcode');
  });
  it('detects ZCODE_PLUGIN_ROOT / ZCODE_PLUGIN_DATA as strong keys', () => {
    expect(detectClient({ ZCODE_PLUGIN_ROOT: '/x' })).toBe('zcode');
    expect(detectClient({ ZCODE_PLUGIN_DATA: '/d' })).toBe('zcode');
  });
  it('honours explicit OMC_CLIENT=zcode and zcode outranks ambient CLAUDE_CONFIG_DIR', () => {
    expect(detectClient({ OMC_CLIENT: 'zcode' })).toBe('zcode');
    expect(resolveClientConfigDir({ ZCODE_APP_VERSION: '1', CLAUDE_CONFIG_DIR: '/elsewhere' }))
      .toBe(join(homedir(), '.zcode'));
  });
  it('OMC_CLIENT=claude suppresses the zcode signature', () => {
    expect(resolveClientConfigDir({ OMC_CLIENT: 'claude', ZCODE_APP_VERSION: '1' }))
      .toBe(join(homedir(), '.claude'));
  });
  it('empty-string signature keys never decide', () => {
    expect(detectClient({ ZCODE_APP_VERSION: '  ' })).toBe('claude');
  });
  it('isZcodeSession mirrors detectClient', () => {
    expect(isZcodeSession({ ZCODE_APP_VERSION: '1' })).toBe(true);
    expect(isZcodeSession({})).toBe(false);
  });
});
