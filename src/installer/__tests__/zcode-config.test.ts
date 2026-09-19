import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { buildZcodeHooksConfig, mergeHooksEvents, mergeOmcMcpServer, readJsonFile, removeOmcFromEnabledPlugins, warnIfNativeMcpShadowing, ZcodeSetupError } from '../zcode-config.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('buildZcodeHooksConfig', () => {
  it('emits exactly the 6 supported events with process-form argv commands', () => {
    const cfg = buildZcodeHooksConfig('/home/.zcode/hooks');
    expect(Object.keys(cfg.events).sort()).toEqual(
      ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'],
    );
    const ups = cfg.events['UserPromptSubmit'][0].hooks[0];
    expect(ups).toEqual({ type: 'process', command: 'node', args: ['/home/.zcode/hooks/keyword-detector.mjs'] });
    expect(cfg.events['Stop']).toHaveLength(2);
    expect(cfg.enabled).toBe(true);
  });
  it('references exactly 7 scripts that all exist under templates/hooks/ (drift guard)', () => {
    const cfg = buildZcodeHooksConfig('/home/.zcode/hooks');
    const scripts = new Set<string>();
    for (const entries of Object.values(cfg.events)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) scripts.add(basename(hook.args[0]));
      }
    }
    expect(scripts.size).toBe(7);
    for (const script of scripts) {
      expect(existsSync(join(packageRoot, 'templates', 'hooks', script))).toBe(true);
    }
  });
});

describe('mergeHooksEvents', () => {
  const dir = '/home/.zcode/hooks';
  it('appends to empty events and preserves foreign entries on re-run', () => {
    const foreign = { matcher: 'Write|Edit', hooks: [{ type: 'process', command: 'node', args: ['/other/check.mjs'] }] };
    const once = mergeHooksEvents({ events: { PreToolUse: [foreign] } }, dir);
    expect(once.events['PreToolUse']).toContain(foreign);
    const omcEntry = once.events['PreToolUse'].find((e) => JSON.stringify(e).includes(dir));
    const twice = mergeHooksEvents(once, dir);
    const omcEntries = twice.events['PreToolUse'].filter((e) => JSON.stringify(e).includes(dir));
    expect(omcEntries).toHaveLength(1); // 原位替换，不叠加
    expect(twice.events['PreToolUse']).toContain(foreign);
  });
  it('throws ZcodeSetupError when hooks.enabled is explicitly false', () => {
    expect(() => mergeHooksEvents({ enabled: false, events: {} }, dir)).toThrow(ZcodeSetupError);
  });
});

describe('removeOmcFromEnabledPlugins', () => {
  it('removes oh-my-claudecode@* and preserves everything else', () => {
    const { config, removed } = removeOmcFromEnabledPlugins({
      plugins: { enabledPlugins: { 'oh-my-claudecode@omc': true, 'other@x': true }, options: {} },
      mcp: {},
    });
    expect(removed).toEqual(['oh-my-claudecode@omc']);
    expect(config.plugins.enabledPlugins).toEqual({ 'other@x': true });
    expect(config.mcp).toEqual({});
  });
  it('no-op when plugins absent', () => {
    const { removed } = removeOmcFromEnabledPlugins({});
    expect(removed).toEqual([]);
  });
});

describe('json io + mcp merge', () => {
  it('readJsonFile returns null for absent, throws for corrupt', () => {
    expect(readJsonFile('/nonexistent/x.json')).toBeNull();
    const bad = join(tmpdir(), `omc-bad-${Date.now()}.json`);
    writeFileSync(bad, '{not json');
    expect(() => readJsonFile(bad)).toThrow(ZcodeSetupError);
  });
  it('mergeOmcMcpServer creates, backs up, preserves others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-mcp-'));
    const p = join(dir, 'mcp.json');
    writeFileSync(p, JSON.stringify({ mcpServers: { other: { command: 'foo' } } }));
    const { backup } = mergeOmcMcpServer(p, '/pkg/bridge/mcp-server.cjs');
    const out = JSON.parse(readFileSync(p, 'utf-8'));
    expect(out.mcpServers.other.command).toBe('foo');
    expect(out.mcpServers.omc.args).toEqual(['/pkg/bridge/mcp-server.cjs']);
    expect(backup).toBeTruthy();
  });
  it('warnIfNativeMcpShadowing warns only when native servers exist', () => {
    const logs: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'omc-shadow-'));
    const cfg = join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify({ mcp: { servers: { a: { command: 'x' } } } }));
    warnIfNativeMcpShadowing(cfg, (m) => logs.push(m));
    expect(logs.join()).toMatch(/\.agents\/mcp\.json/);
  });
});
