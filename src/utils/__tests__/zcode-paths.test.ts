/**
 * resolveZcodePaths helper (src/utils/zcode-paths.ts).
 *
 * Single source of truth for deriving zcodeDir / agentsMcpJsonPath from
 * (scope, workspacePath?). Consumed by setupZcode (T2) and CLI dispatch (T3-T6).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { resolveZcodePaths } from '../zcode-paths.js';

describe('resolveZcodePaths', () => {
  it('user scope with no arg → ~/.zcode + ~/.agents/mcp.json', () => {
    const p = resolveZcodePaths('user');
    expect(p.zcodeDir).toBe(join(homedir(), '.zcode'));
    expect(p.agentsMcpJsonPath).toBe(join(homedir(), '.agents', 'mcp.json'));
  });
  it('user scope with arg still resolves to ~/.zcode (arg ignored)', () => {
    const p = resolveZcodePaths('user', '/some/path');
    expect(p.zcodeDir).toBe(join(homedir(), '.zcode'));
  });
  it('workspace scope with no arg → <cwd>/.zcode + <cwd>/.zcode/.agents/mcp.json', () => {
    const p = resolveZcodePaths('workspace');
    expect(p.zcodeDir).toBe(join(process.cwd(), '.zcode'));
    expect(p.agentsMcpJsonPath).toBe(join(process.cwd(), '.zcode', '.agents', 'mcp.json'));
  });
  it('workspace scope with absolute path → path as zcodeDir (no auto-append)', () => {
    const p = resolveZcodePaths('workspace', '/abs/path');
    expect(p.zcodeDir).toBe('/abs/path');
    expect(p.agentsMcpJsonPath).toBe('/abs/path/.agents/mcp.json');
  });
  it('workspace scope with relative path → relative path preserved (no normalization in v1)', () => {
    const p = resolveZcodePaths('workspace', './myproj');
    expect(p.zcodeDir).toBe('./myproj');
    expect(p.agentsMcpJsonPath).toBe('./myproj/.agents/mcp.json');
  });
});
