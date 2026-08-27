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

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { detectClient, resolveClientConfigDir } from '../utils/client.js';

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
