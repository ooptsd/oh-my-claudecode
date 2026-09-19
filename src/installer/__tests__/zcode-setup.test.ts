import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';

import { setupZcode } from '../zcode.js';

function makeFakePackage(root: string): void {
  mkdirSync(join(root, 'templates/hooks/lib'), { recursive: true });
  writeFileSync(join(root, 'templates/hooks/session-start.mjs'), 'export default 1;\n');
  writeFileSync(join(root, 'templates/hooks/lib/config-dir.mjs'), 'export const x = 1;\n');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/CLAUDE.md'), '<!-- OMC:START -->\n<!-- OMC:VERSION:9.9.9 -->\n# oh-my-claudecode instructions\n<!-- OMC:END -->\n');
  mkdirSync(join(root, 'bridge'), { recursive: true });
  writeFileSync(join(root, 'bridge/mcp-server.cjs'), '// bridge\n');
  for (const dir of ['skills/demo', 'commands', 'agents']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: d\n---\nbody\n');
  writeFileSync(join(root, 'commands/ask.md'), '---\ndescription: ask\n---\nbody\n');
  writeFileSync(join(root, 'agents/architect.md'), '---\nname: architect\ndescription: d\nmodel: opus\ndisallowedTools: Write, Edit\n---\nbody\n');
}

describe('setupZcode', () => {
  it('deploys the full user-level tree and is idempotent', () => {
    const home = mkdtempSync(join(tmpdir(), 'omc-zcode-home-'));
    const pkg = mkdtempSync(join(tmpdir(), 'omc-zcode-pkg-'));
    makeFakePackage(pkg);
    const zcodeDir = join(home, '.zcode');
    const logs: string[] = [];
    const options = { scope: 'user' as const, zcodeDir, agentsMcpJsonPath: join(home, '.agents/mcp.json'), packageDir: pkg, log: (m: string) => logs.push(m) };

    const first = setupZcode(options);
    expect(first.success).toBe(true);
    expect(existsSync(join(zcodeDir, '.omc-config.json'))).toBe(true);
    expect(existsSync(join(zcodeDir, '.omc-version.json'))).toBe(true);
    expect(existsSync(join(zcodeDir, 'hooks/session-start.mjs'))).toBe(true);
    expect(existsSync(join(zcodeDir, 'skills/demo/SKILL.md'))).toBe(true);
    expect(existsSync(join(zcodeDir, 'commands/ask.md'))).toBe(true);
    const agent = readFileSync(join(zcodeDir, 'agents/architect.md'), 'utf-8');
    expect(agent).not.toContain('model:');
    expect(agent).toContain('  - Write');
    const config = JSON.parse(readFileSync(join(zcodeDir, 'cli/config.json'), 'utf-8'));
    expect(config.hooks.enabled).toBe(true);
    expect(Object.keys(config.hooks.events)).toHaveLength(6);
    expect(JSON.parse(readFileSync(join(home, '.agents/mcp.json'), 'utf-8')).mcpServers.omc).toBeTruthy();
    expect(readFileSync(join(zcodeDir, 'AGENTS.md'), 'utf-8')).toContain('<!-- OMC:START -->');

    const second = setupZcode(options);
    expect(second.success).toBe(true);
    const configAgain = JSON.parse(readFileSync(join(zcodeDir, 'cli/config.json'), 'utf-8'));
    expect(configAgain.hooks.events['SessionStart']).toHaveLength(1); // 幂等不叠加
  });

  it('removes oh-my-claudecode from enabledPlugins and preserves foreign hooks', () => {
    const home = mkdtempSync(join(tmpdir(), 'omc-zcode-home-'));
    const pkg = mkdtempSync(join(tmpdir(), 'omc-zcode-pkg-'));
    makeFakePackage(pkg);
    const zcodeDir = join(home, '.zcode');
    const cliConfigPath = join(zcodeDir, 'cli/config.json');
    mkdirSync(join(zcodeDir, 'cli'), { recursive: true });
    const foreignEntry = { matcher: 'Write|Edit', hooks: [{ type: 'process', command: 'node', args: ['/other/check.mjs'] }] };
    writeFileSync(cliConfigPath, JSON.stringify({
      hooks: { enabled: true, events: { PreToolUse: [foreignEntry] } },
      plugins: { enabledPlugins: { 'oh-my-claudecode@omc': true } },
    }));

    const result = setupZcode({ scope: 'user' as const, zcodeDir, agentsMcpJsonPath: join(home, '.agents/mcp.json'), packageDir: pkg, log: () => {} });
    expect(result.success).toBe(true);
    expect(result.pluginsRemoved).toEqual(['oh-my-claudecode@omc']);
    const config = JSON.parse(readFileSync(cliConfigPath, 'utf-8'));
    expect(config.plugins.enabledPlugins).toEqual({});
    expect(config.hooks.events['PreToolUse']).toEqual(expect.arrayContaining([foreignEntry])); // 外部条目仍在（JSON 往返后用深度相等）
  });

  it('aborts when hooks.enabled is explicitly false', () => {
    const home = mkdtempSync(join(tmpdir(), 'omc-zcode-home-'));
    const pkg = mkdtempSync(join(tmpdir(), 'omc-zcode-pkg-'));
    makeFakePackage(pkg);
    const zcodeDir = join(home, '.zcode');
    const cliConfigPath = join(zcodeDir, 'cli/config.json');
    mkdirSync(join(zcodeDir, 'cli'), { recursive: true });
    const original = JSON.stringify({ hooks: { enabled: false } }, null, 2);
    writeFileSync(cliConfigPath, original);

    const result = setupZcode({ scope: 'user' as const, zcodeDir, agentsMcpJsonPath: join(home, '.agents/mcp.json'), packageDir: pkg, log: () => {} });
    expect(result.success).toBe(false);
    expect(result.errors.join()).toContain('explicitly false');
    expect(readFileSync(cliConfigPath, 'utf-8')).toBe(original); // config 未被改写
  });

  it('continues past a corrupt ~/.agents/mcp.json, recording the error and deploying the rest', () => {
    const home = mkdtempSync(join(tmpdir(), 'omc-zcode-home-'));
    const pkg = mkdtempSync(join(tmpdir(), 'omc-zcode-pkg-'));
    makeFakePackage(pkg);
    const zcodeDir = join(home, '.zcode');
    const mcpJsonPath = join(home, '.agents/mcp.json');
    mkdirSync(join(home, '.agents'), { recursive: true });
    writeFileSync(mcpJsonPath, '{not json');

    const result = setupZcode({ scope: 'user' as const, zcodeDir, agentsMcpJsonPath: mcpJsonPath, packageDir: pkg, log: () => {} });
    expect(result.success).toBe(false); // CLI 端自然 exit 1
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join()).toContain(mcpJsonPath);
    // 其余产物照常落盘
    expect(existsSync(join(zcodeDir, 'skills/demo/SKILL.md'))).toBe(true);
    expect(existsSync(join(zcodeDir, 'commands/ask.md'))).toBe(true);
    expect(existsSync(join(zcodeDir, 'agents/architect.md'))).toBe(true);
    expect(readFileSync(join(zcodeDir, 'AGENTS.md'), 'utf-8')).toContain('<!-- OMC:START -->');
    expect(existsSync(join(zcodeDir, 'cli/config.json'))).toBe(true); // hooks 接线不受影响
  });

  it('survives a corrupt config.json when hooksWanted is false (same root cause)', () => {
    const home = mkdtempSync(join(tmpdir(), 'omc-zcode-home-'));
    const pkg = mkdtempSync(join(tmpdir(), 'omc-zcode-pkg-'));
    makeFakePackage(pkg);
    const zcodeDir = join(home, '.zcode');
    const cliConfigPath = join(zcodeDir, 'cli/config.json');
    mkdirSync(join(zcodeDir, 'cli'), { recursive: true });
    writeFileSync(cliConfigPath, '{broken');

    const result = setupZcode({ scope: 'user' as const, zcodeDir, agentsMcpJsonPath: join(home, '.agents/mcp.json'), packageDir: pkg, hooksWanted: false, log: () => {} });
    expect(result.success).toBe(false);
    expect(result.errors.join()).toContain(cliConfigPath);
    expect(readFileSync(join(zcodeDir, 'AGENTS.md'), 'utf-8')).toContain('<!-- OMC:START -->');
    expect(existsSync(join(home, '.agents/mcp.json'))).toBe(true);
  });

  it('skips hook deployment and wiring when hooksWanted is false', () => {
    const home = mkdtempSync(join(tmpdir(), 'omc-zcode-home-'));
    const pkg = mkdtempSync(join(tmpdir(), 'omc-zcode-pkg-'));
    makeFakePackage(pkg);
    const zcodeDir = join(home, '.zcode');

    const result = setupZcode({ scope: 'user' as const, zcodeDir, agentsMcpJsonPath: join(home, '.agents/mcp.json'), packageDir: pkg, hooksWanted: false, log: () => {} });
    expect(result.success).toBe(true);
    expect(existsSync(join(zcodeDir, 'cli/config.json'))).toBe(false); // 不接线
    expect(existsSync(join(zcodeDir, 'hooks'))).toBe(false); // 不部署 hook 脚本
    expect(result.deployed.hooks).toBe(false);
    expect(readFileSync(join(zcodeDir, 'AGENTS.md'), 'utf-8')).toContain('<!-- OMC:START -->'); // 事务照常
    expect(existsSync(join(zcodeDir, 'skills/demo/SKILL.md'))).toBe(true);
    expect(existsSync(join(zcodeDir, 'commands/ask.md'))).toBe(true);
    expect(existsSync(join(zcodeDir, 'agents/architect.md'))).toBe(true);
    expect(existsSync(join(home, '.agents/mcp.json'))).toBe(true); // 第 8 步 MCP 合并照常（不受 hooksWanted 影响）
  });
});

describe('setupZcode workspace scope', () => {
  it('deploys full tree under <ws>/.zcode and stamps version at <ws>/.omc-version.json', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'omc-zcode-ws-'));
    const pkg = mkdtempSync(join(tmpdir(), 'omc-zcode-ws-pkg-'));
    makeFakePackage(pkg);
    const zcodeDir = join(workspaceRoot, '.zcode');
    const logs: string[] = [];

    const result = setupZcode({
      scope: 'workspace',
      zcodeDir,
      agentsMcpJsonPath: join(zcodeDir, '.agents', 'mcp.json'),
      workspacePath: workspaceRoot,
      packageDir: pkg,
      log: (m) => logs.push(m),
    });

    expect(result.success).toBe(true);
    // 产品在 zcodeDir 下
    expect(existsSync(join(zcodeDir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(zcodeDir, 'hooks/session-start.mjs'))).toBe(true);
    expect(existsSync(join(zcodeDir, 'skills/demo/SKILL.md'))).toBe(true);
    expect(existsSync(join(zcodeDir, 'commands/ask.md'))).toBe(true);
    // version 在 workspaceRoot 顶层，不在 zcodeDir 内
    expect(existsSync(join(workspaceRoot, '.omc-version.json'))).toBe(true);
    expect(existsSync(join(zcodeDir, '.omc-version.json'))).toBe(false);
    const versionInfo = JSON.parse(readFileSync(join(workspaceRoot, '.omc-version.json'), 'utf-8'));
    expect(versionInfo.scope).toBe('workspace');
    expect(versionInfo.workspacePath).toBe(workspaceRoot);
    // .omc/ state 子目录在 workspaceRoot 顶层
    expect(existsSync(join(workspaceRoot, '.omc'))).toBe(true);
    expect(existsSync(join(zcodeDir, '.omc'))).toBe(false);
    // MCP 在 zcodeDir/.agents/ 下
    const mcp = JSON.parse(readFileSync(join(zcodeDir, '.agents', 'mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.omc).toBeTruthy();
  });

  it('workspace scope is idempotent on re-run', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'omc-zcode-ws-idem-'));
    const pkg = mkdtempSync(join(tmpdir(), 'omc-zcode-ws-idem-pkg-'));
    makeFakePackage(pkg);
    const zcodeDir = join(workspaceRoot, '.zcode');
    const options = {
      scope: 'workspace' as const,
      zcodeDir,
      agentsMcpJsonPath: join(zcodeDir, '.agents', 'mcp.json'),
      workspacePath: workspaceRoot,
      packageDir: pkg,
      log: () => {},
    };

    const first = setupZcode(options);
    const second = setupZcode(options);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const config = JSON.parse(readFileSync(join(zcodeDir, 'cli/config.json'), 'utf-8'));
    expect(config.hooks.events['SessionStart']).toHaveLength(1);
  });

  it('user scope (default) behavior unchanged (regression)', () => {
    // 沿用现有第一个 it 的 HOME 树 + scope='user'，断言 .omc-version.json 在 ~/.zcode 内、~/.omc/ 不存在
    const home = mkdtempSync(join(tmpdir(), 'omc-zcode-home-'));
    const pkg = mkdtempSync(join(tmpdir(), 'omc-zcode-pkg-'));
    makeFakePackage(pkg);
    const zcodeDir = join(home, '.zcode');
    const options = {
      scope: 'user' as const,
      zcodeDir,
      agentsMcpJsonPath: join(home, '.agents/mcp.json'),
      packageDir: pkg,
      log: () => {},
    };

    const result = setupZcode(options);
    expect(result.success).toBe(true);
    // version 仍在 zcodeDir 内（用户级行为）
    expect(existsSync(join(zcodeDir, '.omc-version.json'))).toBe(true);
    expect(existsSync(join(home, '.omc-version.json'))).toBe(false);
    const versionInfo = JSON.parse(readFileSync(join(zcodeDir, '.omc-version.json'), 'utf-8'));
    expect(versionInfo.scope).toBe('user');
    // workspaceRoot 不存在 → 顶层不应创建 .omc/、不应有 .omc-version.json
    expect(existsSync(join(home, '.omc'))).toBe(false);
    // 其余产品照常在 zcodeDir 下
    expect(existsSync(join(zcodeDir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(zcodeDir, 'hooks/session-start.mjs'))).toBe(true);
    expect(existsSync(join(zcodeDir, 'skills/demo/SKILL.md'))).toBe(true);
    expect(existsSync(join(zcodeDir, 'commands/ask.md'))).toBe(true);
    expect(existsSync(join(home, '.agents/mcp.json'))).toBe(true);
  });
});
