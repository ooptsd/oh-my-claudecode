/**
 * Four-mirror consistency for client-aware config-dir resolution.
 *
 * The same detection priority is hand-written in four surfaces:
 *   - TypeScript: src/utils/client.ts (resolveClientConfigDir)
 *   - ESM hook runtime: scripts/lib/config-dir.mjs (getClaudeConfigDir)
 *   - CJS bridge runtime: scripts/lib/config-dir.cjs (getClaudeConfigDir)
 *   - POSIX shell runtime: scripts/lib/config-dir.sh (resolve_claude_config_dir)
 *
 * This suite feeds every mirror the same env inputs and asserts identical
 * outputs, across the repo layout and the two installed layouts OMC ships
 * (copied file and symlinked file), so a CodeBuddy hook process resolves the
 * same config dir no matter which surface it runs through.
 */

import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { detectClient, resolveClientConfigDir } from '../utils/client.js';

const requireCjs = createRequire(import.meta.url);

const REPO_ROOT = process.cwd();
const CONFIG_DIR_MJS = join(REPO_ROOT, 'scripts', 'lib', 'config-dir.mjs');
const CONFIG_DIR_CJS = join(REPO_ROOT, 'scripts', 'lib', 'config-dir.cjs');
const CONFIG_DIR_SH = join(REPO_ROOT, 'scripts', 'lib', 'config-dir.sh');
const CLIENT_PATHS_MJS = join(REPO_ROOT, 'scripts', 'lib', 'client-paths.mjs');

type MatrixCase = {
  name: string;
  env: Record<string, string>;
  /** Expected dir; '~'-prefixed entries expand against the injected HOME. */
  expected: string;
};

const ENV_MATRIX: MatrixCase[] = [
  { name: 'default is ~/.claude', env: {}, expected: '~/.claude' },
  {
    name: 'ambient CLAUDE_CONFIG_DIR absolute path',
    env: { CLAUDE_CONFIG_DIR: '/opt/omc-cc' },
    expected: '/opt/omc-cc',
  },
  {
    name: 'CLAUDE_CONFIG_DIR tilde-prefixed',
    env: { CLAUDE_CONFIG_DIR: '~/.claude-alt' },
    expected: '~/.claude-alt',
  },
  {
    name: 'CodeBuddy signature CODEBUDDY_PLUGIN_ROOT',
    env: { CODEBUDDY_PLUGIN_ROOT: '/plugins/omc' },
    expected: '~/.codebuddy',
  },
  {
    name: 'CodeBuddy signature CODEBUDDY_PLUGIN_DIRS',
    env: { CODEBUDDY_PLUGIN_DIRS: '/a:/b' },
    expected: '~/.codebuddy',
  },
  {
    name: 'CodeBuddy signature CODEBUDDY_PLUGIN_DATA',
    env: { CODEBUDDY_PLUGIN_DATA: '/data/omc' },
    expected: '~/.codebuddy',
  },
  {
    name: 'session signature outranks ambient CLAUDE_CONFIG_DIR',
    env: { CODEBUDDY_PLUGIN_ROOT: '/p', CLAUDE_CONFIG_DIR: '/opt/omc-cc' },
    expected: '~/.codebuddy',
  },
  {
    name: 'OMC_CLIENT=codebuddy forces ~/.codebuddy over CLAUDE_CONFIG_DIR',
    env: { OMC_CLIENT: 'codebuddy', CLAUDE_CONFIG_DIR: '/opt/omc-cc' },
    expected: '~/.codebuddy',
  },
  {
    name: 'OMC_CLIENT=claude suppresses the signature and keeps CLAUDE_CONFIG_DIR',
    env: { OMC_CLIENT: 'claude', CODEBUDDY_PLUGIN_ROOT: '/p', CLAUDE_CONFIG_DIR: '/opt/omc-cc' },
    expected: '/opt/omc-cc',
  },
  {
    name: 'weak CodeBuddy signals alone stay claude',
    env: { CODEBUDDY_PROJECT_DIR: '/proj', CODEBUDDY_SERVICE_PROXY_URL: 'http://proxy' },
    expected: '~/.claude',
  },
  {
    name: 'CLAUDE_CONFIG_DIR filesystem root is preserved',
    env: { CLAUDE_CONFIG_DIR: '/' },
    expected: '/',
  },
  {
    name: 'CLAUDE_CONFIG_DIR double trailing separators are stripped',
    env: { CLAUDE_CONFIG_DIR: '/opt/omc-cc//' },
    expected: '/opt/omc-cc',
  },
];

function expandExpected(expected: string, fakeHome: string): string {
  if (expected === '~') {
    return normalize(fakeHome);
  }
  return expected.startsWith('~/') ? normalize(join(fakeHome, expected.slice(2))) : normalize(expected);
}

/** Controlled child env: inherited PATH only, injected HOME, matrix vars. */
function childEnv(fakeHome: string, matrixEnv: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: fakeHome,
    ...matrixEnv,
  };
}

function runMjsHelper(helperPath: string, fakeHome: string, matrixEnv: Record<string, string>): string {
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { getClaudeConfigDir } from ${JSON.stringify(pathToFileURL(helperPath).href)}; process.stdout.write(getClaudeConfigDir());`,
    ],
    { encoding: 'utf-8', env: childEnv(fakeHome, matrixEnv) },
  );
}

function runCjsHelper(fakeHome: string, matrixEnv: Record<string, string>): string {
  return execFileSync(
    process.execPath,
    [
      '-e',
      `const { getClaudeConfigDir } = require(${JSON.stringify(CONFIG_DIR_CJS)}); process.stdout.write(getClaudeConfigDir());`,
    ],
    { encoding: 'utf-8', env: childEnv(fakeHome, matrixEnv) },
  );
}

function runShHelper(fakeHome: string, matrixEnv: Record<string, string>): string {
  const output = execFileSync('bash', ['-c', `. ${JSON.stringify(CONFIG_DIR_SH)}; resolve_claude_config_dir`], {
    encoding: 'utf-8',
    env: childEnv(fakeHome, matrixEnv),
  });
  return normalize(output.trim());
}

describe('client config-dir mirrors agree on identical inputs', () => {
  let fakeHome: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'omc-mirrors-home-'));
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

  it.each(ENV_MATRIX)('$name', (matrixCase) => {
    const expected = expandExpected(matrixCase.expected, fakeHome);

    expect(resolveClientConfigDir(matrixCase.env)).toBe(expected);
    expect(runMjsHelper(CONFIG_DIR_MJS, fakeHome, matrixCase.env)).toBe(expected);
    expect(runCjsHelper(fakeHome, matrixCase.env)).toBe(expected);
    expect(runShHelper(fakeHome, matrixCase.env)).toBe(expected);
  });

  it('byte-equivalence: scripts/lib/config-dir.mjs equals the standalone templates copy', () => {
    expect(readFileSync(CONFIG_DIR_MJS, 'utf-8')).toBe(
      readFileSync(join(REPO_ROOT, 'templates', 'hooks', 'lib', 'config-dir.mjs'), 'utf-8'),
    );
  });
});

describe('dirty trailing-separator values resolve byte-identically across mirrors', () => {
  let fakeHome: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'omc-mirrors-dirty-home-'));
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

  /** Raw sh output: strip only the trailing newline, no normalize/trim. */
  function runShHelperRaw(fakeHomeDir: string, matrixEnv: Record<string, string>): string {
    const output = execFileSync('bash', ['-c', `. ${JSON.stringify(CONFIG_DIR_SH)}; resolve_claude_config_dir`], {
      encoding: 'utf-8',
      env: childEnv(fakeHomeDir, matrixEnv),
    });
    return output.replace(/\n$/, '');
  }

  it.each([
    { name: 'filesystem root', value: '/' },
    { name: 'double slash root', value: '//' },
    { name: 'triple slash root', value: '///' },
    { name: 'dirty double trailing separator', value: '/opt/omc-dirty//' },
    { name: 'dirty triple trailing separator', value: '/opt/omc-dirty///' },
    { name: 'tilde form with trailing separator', value: '~/alt//' },
  ])('$name', (dirty) => {
    const env = { CLAUDE_CONFIG_DIR: dirty.value };
    const expected = resolveClientConfigDir(env);
    // Normalization-free comparisons: a mirror that leaves a stray separator
    // (or collapses the root to an empty string) must fail here even when
    // path.normalize would have masked it.
    expect(runMjsHelper(CONFIG_DIR_MJS, fakeHome, env)).toBe(expected);
    expect(runCjsHelper(fakeHome, env)).toBe(expected);
    expect(runShHelperRaw(fakeHome, env)).toBe(expected);
    // Sanity: the TS answer itself keeps the root a root.
    if (dirty.value === '/' || dirty.value === '//' || dirty.value === '///') {
      expect(expected).toBe('/');
    }
  });
});

describe('known capability boundary of the sh mirror (documented limits)', () => {
  let fakeHome: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'omc-mirrors-boundary-home-'));
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

  function runShHelperRaw(fakeHomeDir: string, matrixEnv: Record<string, string>): string {
    const output = execFileSync('bash', ['-c', `. ${JSON.stringify(CONFIG_DIR_SH)}; resolve_claude_config_dir`], {
      encoding: 'utf-8',
      env: childEnv(fakeHomeDir, matrixEnv),
    });
    return output.replace(/\n$/, '');
  }

  it('quoted values keep their quotes in every mirror (nobody unquotes)', () => {
    const env = { CLAUDE_CONFIG_DIR: '"/opt/omc-quoted"' };
    const expected = resolveClientConfigDir(env);
    expect(expected).toBe('"/opt/omc-quoted"');
    expect(runMjsHelper(CONFIG_DIR_MJS, fakeHome, env)).toBe(expected);
    expect(runCjsHelper(fakeHome, env)).toBe(expected);
    expect(runShHelperRaw(fakeHome, env)).toBe(expected);
  });

  it('TS/mjs/cjs trim whitespace; the sh mirror documents no-trim as its boundary', () => {
    const env = { CLAUDE_CONFIG_DIR: '  /opt/omc-ws  ' };
    const expected = resolveClientConfigDir(env);
    expect(expected).toBe('/opt/omc-ws');
    expect(runMjsHelper(CONFIG_DIR_MJS, fakeHome, env)).toBe(expected);
    expect(runCjsHelper(fakeHome, env)).toBe(expected);
    // config-dir.sh header: "plain existence checks only — values must be
    // clean (no leading/trailing whitespace)". Pin that boundary so any
    // future drift (in either direction) is a conscious change.
    expect(runShHelperRaw(fakeHome, env)).toBe('  /opt/omc-ws  ');
  });

  it('TS/mjs/cjs trim OMC_CLIENT; the sh mirror requires exact lowercase (documented boundary)', () => {
    const env = { OMC_CLIENT: ' codebuddy ' };
    const codebuddyDir = normalize(join(fakeHome, '.codebuddy'));
    const claudeDir = normalize(join(fakeHome, '.claude'));
    expect(resolveClientConfigDir(env)).toBe(codebuddyDir);
    expect(runMjsHelper(CONFIG_DIR_MJS, fakeHome, env)).toBe(codebuddyDir);
    expect(runCjsHelper(fakeHome, env)).toBe(codebuddyDir);
    // config-dir.sh header: "OMC_CLIENT must be exact lowercase" — the
    // whitespace-wrapped value is not recognized there, so the session stays
    // claude. Boundary pinned as-is.
    expect(runShHelperRaw(fakeHome, env)).toBe(claudeDir);
  });

  it('OMC_CLIENT case variants are ignored by every mirror (consistent)', () => {
    for (const variant of ['CodeBuddy', 'CODEBUDDY', 'Claude']) {
      const env = { OMC_CLIENT: variant };
      const expected = resolveClientConfigDir(env);
      expect(expected).toBe(normalize(join(fakeHome, '.claude')));
      expect(runMjsHelper(CONFIG_DIR_MJS, fakeHome, env)).toBe(expected);
      expect(runCjsHelper(fakeHome, env)).toBe(expected);
      expect(runShHelperRaw(fakeHome, env)).toBe(expected);
    }
  });
});

describe('client config-dir mirrors survive installed layouts', () => {
  let installRoot: string;
  let fakeHome: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    installRoot = mkdtempSync(join(tmpdir(), 'omc-mirrors-install-'));
    fakeHome = mkdtempSync(join(tmpdir(), 'omc-mirrors-install-home-'));
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  const installCases = [
    {
      layout: 'copy',
      // Copy install: marketplace/plugin caches materialize real files.
      prepare: (dest: string) => copyFileSync(CONFIG_DIR_MJS, dest),
    },
    {
      layout: 'symlink',
      // Symlink install: plugin-dir style layouts can point at the source file.
      prepare: (dest: string) => symlinkSync(CONFIG_DIR_MJS, dest),
    },
  ];

  const resolveCases = [
    {
      name: 'claude session',
      env: {} as Record<string, string>,
      expected: '~/.claude',
    },
    {
      name: 'codebuddy session',
      env: { CODEBUDDY_PLUGIN_ROOT: '/plugins/omc' } as Record<string, string>,
      expected: '~/.codebuddy',
    },
  ];

  for (const install of installCases) {
    for (const resolveCase of resolveCases) {
      it(`${install.layout} install resolves ${resolveCase.name} like the TS helper`, () => {
        const hooksLibDir = join(installRoot, 'hooks', 'lib');
        mkdirSync(hooksLibDir, { recursive: true });
        const installedHelper = join(hooksLibDir, 'config-dir.mjs');
        install.prepare(installedHelper);

        const expected = expandExpected(resolveCase.expected, fakeHome);
        expect(resolveClientConfigDir(resolveCase.env)).toBe(expected);
        expect(runMjsHelper(installedHelper, fakeHome, resolveCase.env)).toBe(expected);
      });
    }
  }
});

describe('scripts/lib/client-paths.mjs detection mirrors src/utils/client.ts', () => {
  it.each(ENV_MATRIX)('$name', async (matrixCase) => {
    const { detectClient: detectClientMjs } = await import(pathToFileURL(CLIENT_PATHS_MJS).href);
    expect(detectClientMjs(matrixCase.env)).toBe(detectClient(matrixCase.env));
  });
});

describe('mirror warning behaviour (caller side)', () => {
  it('ESM mirror warns once when the signature outranks CLAUDE_CONFIG_DIR', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'omc-mirrors-warn-home-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { getClaudeConfigDir } from ${JSON.stringify(pathToFileURL(CONFIG_DIR_MJS).href)};
           process.stdout.write(getClaudeConfigDir() + getClaudeConfigDir());`,
        ],
        {
          encoding: 'utf-8',
          env: childEnv(fakeHome, {
            CODEBUDDY_PLUGIN_ROOT: '/p',
            CLAUDE_CONFIG_DIR: '/opt/omc-cc',
          }),
        },
      );
      const dir = normalize(join(fakeHome, '.codebuddy'));
      expect(result.stdout).toBe(dir + dir);
      expect(result.stderr.match(/CodeBuddy session detected/g)).toHaveLength(1);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('CJS mirror warns once when the signature outranks CLAUDE_CONFIG_DIR', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'omc-mirrors-warn-cjs-home-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          `const { getClaudeConfigDir } = require(${JSON.stringify(CONFIG_DIR_CJS)});
           process.stdout.write(getClaudeConfigDir() + getClaudeConfigDir());`,
        ],
        {
          encoding: 'utf-8',
          env: childEnv(fakeHome, {
            CODEBUDDY_PLUGIN_DIRS: '/a',
            CLAUDE_CONFIG_DIR: '/opt/omc-cc',
          }),
        },
      );
      const dir = normalize(join(fakeHome, '.codebuddy'));
      expect(result.stdout).toBe(dir + dir);
      expect(result.stderr.match(/CodeBuddy session detected/g)).toHaveLength(1);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('mirrors stay silent for explicit OMC_CLIENT=codebuddy', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'omc-mirrors-warn-silent-'));
    try {
      const env = childEnv(fakeHome, { OMC_CLIENT: 'codebuddy', CLAUDE_CONFIG_DIR: '/opt/omc-cc' });
      const mjs = spawnSync(process.execPath, [
        '--input-type=module',
        '-e',
        `import { getClaudeConfigDir } from ${JSON.stringify(pathToFileURL(CONFIG_DIR_MJS).href)}; process.stdout.write(getClaudeConfigDir());`,
      ], { encoding: 'utf-8', env });
      const cjs = spawnSync(process.execPath, [
        '-e',
        `const { getClaudeConfigDir } = require(${JSON.stringify(CONFIG_DIR_CJS)}); process.stdout.write(getClaudeConfigDir());`,
      ], { encoding: 'utf-8', env });

      expect(mjs.stderr).toBe('');
      expect(cjs.stderr).toBe('');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('zcode signature resolution across mirrors', () => {
  const SAVED_ENV: Record<string, string | undefined> = {
    ZCODE_APP_VERSION: process.env.ZCODE_APP_VERSION,
    OMC_CLIENT: process.env.OMC_CLIENT,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(SAVED_ENV)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // .mjs mirror（动态 import 后断言）
  it('mjs mirror: zcode signature resolves ~/.zcode over ambient CLAUDE_CONFIG_DIR', async () => {
    process.env.ZCODE_APP_VERSION = 'test';
    delete process.env.OMC_CLIENT;
    process.env.CLAUDE_CONFIG_DIR = '/elsewhere';
    const { getClaudeConfigDir } = await import(pathToFileURL(CONFIG_DIR_MJS).href);
    expect(getClaudeConfigDir()).toBe(join(homedir(), '.zcode'));
  });

  // .cjs mirror（require 后断言）
  it('cjs mirror: zcode signature resolves ~/.zcode over ambient CLAUDE_CONFIG_DIR', () => {
    process.env.ZCODE_APP_VERSION = 'test';
    delete process.env.OMC_CLIENT;
    process.env.CLAUDE_CONFIG_DIR = '/elsewhere';
    const { getClaudeConfigDir } = requireCjs(CONFIG_DIR_CJS);
    expect(getClaudeConfigDir()).toBe(join(homedir(), '.zcode'));
  });

  // .sh mirror（execSync 执行 resolve_claude_config_dir）
  it('sh mirror: zcode signature resolves ~/.zcode', () => {
    const out = execSync(
      `ZCODE_APP_VERSION=test CLAUDE_CONFIG_DIR=/elsewhere sh -c '. ${CONFIG_DIR_SH}; resolve_claude_config_dir'`,
      { encoding: 'utf8' },
    );
    expect(out.trim()).toBe(join(homedir(), '.zcode'));
  });
});
