/**
 * Project-level load-bearing paths are client-aware: in a CodeBuddy session
 * the hooks read `.codebuddy/` project state (settings gate, omc.jsonc,
 * todos.json, rules dirs) and never cross-read `.claude/`; Claude/ZCode
 * sessions keep the historical `.claude/` behaviour byte-for-byte
 * (gap-report P11: CodeBuddy reads only .codebuddy/settings.json).
 *
 * Covers:
 *   - scripts/lib/client-paths.mjs (projectClientDirName)
 *   - scripts/keyword-detector.mjs (omc.jsonc disabled-keywords read)
 *   - src/hooks/rules-injector (project rule subdirs + user rules dir)
 *   - source contracts for scripts/persistent-mode.mjs project-level reads
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import { findRuleFiles } from '../hooks/rules-injector/finder.js';

const REPO_ROOT = process.cwd();
const KEYWORD_DETECTOR = join(REPO_ROOT, 'scripts', 'keyword-detector.mjs');

const CLIENT_ENV_KEYS = [
  'OMC_CLIENT',
  'CODEBUDDY_PLUGIN_ROOT',
  'CODEBUDDY_PLUGIN_DIRS',
  'CODEBUDDY_PLUGIN_DATA',
  'CODEBUDDY_PROJECT_DIR',
  'CODEBUDDY_SERVICE_PROXY_URL',
  'CLAUDE_CONFIG_DIR',
  'ZCODE_APP_VERSION',
  'ZCODE_PLUGIN_ROOT',
  'ZCODE_PLUGIN_DATA',
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of CLIENT_ENV_KEYS) {
  ORIGINAL_ENV[key] = process.env[key];
}

afterEach(() => {
  for (const key of CLIENT_ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIGINAL_ENV[key];
    }
  }
});

/** Controlled hook env: no ambient CodeBuddy/OMC_CLIENT/CLAUDE_CONFIG_DIR leakage. */
function hookEnv(fakeHome: string, overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: fakeHome,
    NODE_ENV: 'test',
    OMC_SKIP_HOOKS: '',
  };
  for (const key of CLIENT_ENV_KEYS) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

describe('projectClientDirName', () => {
  it('returns .claude by default and .codebuddy in CodeBuddy sessions', async () => {
    const { projectClientDirName } = await import(
      pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'client-paths.mjs')).href
    );

    expect(projectClientDirName({})).toBe('.claude');
    expect(projectClientDirName({ CLAUDE_CONFIG_DIR: '/opt/cc' })).toBe('.claude');
    expect(projectClientDirName({ CODEBUDDY_PLUGIN_ROOT: '/p' })).toBe('.codebuddy');
    expect(projectClientDirName({ CODEBUDDY_PLUGIN_DIRS: '/a' })).toBe('.codebuddy');
    expect(projectClientDirName({ CODEBUDDY_PLUGIN_DATA: '/d' })).toBe('.codebuddy');
    expect(projectClientDirName({ CODEBUDDY_PROJECT_DIR: '/proj' })).toBe('.claude');
    expect(projectClientDirName({ OMC_CLIENT: 'claude', CODEBUDDY_PLUGIN_ROOT: '/p' })).toBe('.claude');
    expect(projectClientDirName({ OMC_CLIENT: 'codebuddy' })).toBe('.codebuddy');
  });
});

describe('keyword-detector.mjs project omc.jsonc is client-scoped', () => {
  function runKeywordDetector(cwd: string, fakeHome: string, env: Record<string, string>) {
    const raw = execFileSync(process.execPath, [KEYWORD_DETECTOR], {
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        cwd,
        session_id: 'session-client-paths',
        prompt: 'deepsearch the codebase for client dispatch',
      }),
      encoding: 'utf-8',
      env: hookEnv(fakeHome, env),
      timeout: 20000,
    }).trim();

    return JSON.parse(raw) as {
      continue: boolean;
      hookSpecificOutput?: { additionalContext?: string };
    };
  }

  function writeProjectOmcJsonc(projectRoot: string, clientDir: '.claude' | '.codebuddy') {
    const configPath = join(projectRoot, clientDir, 'omc.jsonc');
    mkdirSync(join(projectRoot, clientDir), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ keywordDetector: { disabled: ['deepsearch'] } }, null, 2),
    );
  }

  let projectRoot: string;
  let fakeHome: string;

  function setup() {
    const base = mkdtempSync(join(tmpdir(), 'omc-client-project-'));
    projectRoot = join(base, 'project');
    fakeHome = join(base, 'home');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    return base;
  }

  it('claude session honours .claude/omc.jsonc and ignores .codebuddy/', () => {
    const base = setup();
    try {
      writeProjectOmcJsonc(projectRoot, '.claude');
      const claudeOnly = runKeywordDetector(projectRoot, fakeHome, {});
      expect(claudeOnly.hookSpecificOutput?.additionalContext ?? '').not.toContain('<search-mode>');

      rmSync(join(projectRoot, '.claude'), { recursive: true, force: true });
      writeProjectOmcJsonc(projectRoot, '.codebuddy');
      const codebuddyIgnored = runKeywordDetector(projectRoot, fakeHome, {});
      expect(codebuddyIgnored.hookSpecificOutput?.additionalContext ?? '').toContain('<search-mode>');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('codebuddy session honours .codebuddy/omc.jsonc and ignores .claude/', () => {
    const base = setup();
    try {
      writeProjectOmcJsonc(projectRoot, '.codebuddy');
      const codebuddyOnly = runKeywordDetector(projectRoot, fakeHome, {
        CODEBUDDY_PLUGIN_ROOT: join(base, 'plugins', 'omc'),
      });
      expect(codebuddyOnly.hookSpecificOutput?.additionalContext ?? '').not.toContain('<search-mode>');

      rmSync(join(projectRoot, '.codebuddy'), { recursive: true, force: true });
      writeProjectOmcJsonc(projectRoot, '.claude');
      const claudeIgnored = runKeywordDetector(projectRoot, fakeHome, {
        CODEBUDDY_PLUGIN_ROOT: join(base, 'plugins', 'omc'),
      });
      expect(claudeIgnored.hookSpecificOutput?.additionalContext ?? '').toContain('<search-mode>');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('rules-injector project rule subdirs are client-scoped', () => {
  let base: string;
  let projectRoot: string;
  let fakeHome: string;

  function setup() {
    base = mkdtempSync(join(tmpdir(), 'omc-client-rules-'));
    projectRoot = join(base, 'project');
    fakeHome = join(base, 'home');
    for (const dir of [
      join(projectRoot, '.claude', 'rules'),
      join(projectRoot, '.codebuddy', 'rules'),
      join(fakeHome, '.claude', 'rules'),
      join(fakeHome, '.codebuddy', 'rules'),
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(projectRoot, '.claude', 'rules', 'claude-rule.md'), '# claude project rule');
    writeFileSync(join(projectRoot, '.codebuddy', 'rules', 'codebuddy-rule.md'), '# codebuddy project rule');
    writeFileSync(join(fakeHome, '.claude', 'rules', 'claude-user-rule.md'), '# claude user rule');
    writeFileSync(join(fakeHome, '.codebuddy', 'rules', 'codebuddy-user-rule.md'), '# codebuddy user rule');
    return base;
  }

  it('claude session discovers .claude rules only', () => {
    const tempBase = setup();
    try {
      delete process.env.CODEBUDDY_PLUGIN_ROOT;
      delete process.env.OMC_CLIENT;
      // This suite can run inside a ZCode host (ambient ZCODE_* env); a bare
      // "claude session" must scrub the ZCode signature keys too.
      delete process.env.ZCODE_APP_VERSION;
      delete process.env.ZCODE_PLUGIN_ROOT;
      delete process.env.ZCODE_PLUGIN_DATA;
      const originalHome = process.env.HOME;
      process.env.HOME = fakeHome;

      try {
        const candidates = findRuleFiles(projectRoot, join(projectRoot, 'src', 'a.ts'));
        const paths = candidates.map((c) => c.path);
        expect(paths).toContain(join(projectRoot, '.claude', 'rules', 'claude-rule.md'));
        expect(paths).not.toContain(join(projectRoot, '.codebuddy', 'rules', 'codebuddy-rule.md'));
        expect(paths).toContain(join(fakeHome, '.claude', 'rules', 'claude-user-rule.md'));
        expect(paths).not.toContain(join(fakeHome, '.codebuddy', 'rules', 'codebuddy-user-rule.md'));
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
      }
    } finally {
      rmSync(tempBase, { recursive: true, force: true });
    }
  });

  it('codebuddy session discovers .codebuddy rules only', () => {
    const tempBase = setup();
    try {
      process.env.CODEBUDDY_PLUGIN_ROOT = '/plugins/omc';
      delete process.env.OMC_CLIENT;
      const originalHome = process.env.HOME;
      process.env.HOME = fakeHome;

      try {
        const candidates = findRuleFiles(projectRoot, join(projectRoot, 'src', 'a.ts'));
        const paths = candidates.map((c) => c.path);
        expect(paths).toContain(join(projectRoot, '.codebuddy', 'rules', 'codebuddy-rule.md'));
        expect(paths).not.toContain(join(projectRoot, '.claude', 'rules', 'claude-rule.md'));
        expect(paths).toContain(join(fakeHome, '.codebuddy', 'rules', 'codebuddy-user-rule.md'));
        expect(paths).not.toContain(join(fakeHome, '.claude', 'rules', 'claude-user-rule.md'));
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
      }
    } finally {
      rmSync(tempBase, { recursive: true, force: true });
    }
  });
});

describe('persistent-mode.mjs project-level reads route through the client helper', () => {
  it('resolves omc.jsonc and todos.json via projectClientDirName', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts', 'persistent-mode.mjs'), 'utf-8');

    expect(source).toContain('join(__dirname, "lib", "client-paths.mjs")');
    expect(source).toContain('join(process.cwd(), projectClientDirName(), "omc.jsonc")');
    expect(source).toContain('join(projectDir, projectClientDirName(), "todos.json")');
    expect(source).not.toContain('join(process.cwd(), ".claude", "omc.jsonc")');
    expect(source).not.toContain('join(projectDir, ".claude", "todos.json")');
  });

  it('keyword-detector.mjs resolves settings gate and omc.jsonc via projectClientDirName', () => {
    const source = readFileSync(KEYWORD_DETECTOR, 'utf-8');

    expect(source).toContain("join(projectRoot, projectClientDir, 'settings.local.json')");
    expect(source).toContain("join(directory || process.cwd(), projectClientDirName(), 'omc.jsonc')");
    expect(source).not.toContain("join(projectRoot, '.claude', 'settings.local.json')");
    expect(source).not.toContain("join(directory || process.cwd(), '.claude', 'omc.jsonc')");
  });
});
