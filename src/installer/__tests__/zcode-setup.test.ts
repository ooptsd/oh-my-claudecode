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
    const options = { zcodeDir, agentsMcpJsonPath: join(home, '.agents/mcp.json'), packageDir: pkg, log: (m: string) => logs.push(m) };

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

    const result = setupZcode({ zcodeDir, agentsMcpJsonPath: join(home, '.agents/mcp.json'), packageDir: pkg, log: () => {} });
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

    const result = setupZcode({ zcodeDir, agentsMcpJsonPath: join(home, '.agents/mcp.json'), packageDir: pkg, log: () => {} });
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

    const result = setupZcode({ zcodeDir, agentsMcpJsonPath: mcpJsonPath, packageDir: pkg, log: () => {} });
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

    const result = setupZcode({ zcodeDir, agentsMcpJsonPath: join(home, '.agents/mcp.json'), packageDir: pkg, hooksWanted: false, log: () => {} });
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

    const result = setupZcode({ zcodeDir, agentsMcpJsonPath: join(home, '.agents/mcp.json'), packageDir: pkg, hooksWanted: false, log: () => {} });
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
