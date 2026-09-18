/**
 * E1 regression — subprocess smoke: `--workspace --client claude|codebuddy`
 * 冲突 (Task 5).
 *
 * 单元层 (`install-workspace-option.test.ts`) 用 `vi.spyOn(process, 'exit')`
 * 拦截 E1 分支；本文件走真实 CLI 子进程：spawn `node bin/oh-my-claudecode.js`、
 * 断言 exit code + stderr。覆盖点是 E1 的实际 wire-up，避免未来重构把
 * `process.exit(1)` 改成 `process.exitCode`/`throw` 之类时悄悄失去非零退出。
 *
 * 入口：`bin/oh-my-claudecode.js` → `bridge/cli.cjs`（eager-build 产物）。
 *
 * 注意：本测试依赖 src/cli/index.ts 当前内容同步到 bridge/cli.cjs。
 * CI 工作流先跑 `npm run build` 再 `npm test`，因此 CI 自带刷新。
 * 本地跑本测试前如未跑过 build，需先执行 `npm run build:cli`
 * （或全量 `npm run build`）让 bridge 含最新 E1 分支字符串。
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// __tests__/ under src/cli/, repo root is ../../../ from this file.
const repoRoot = resolve(here, '..', '..', '..');
const binPath = join(repoRoot, 'bin', 'oh-my-claudecode.js');
const repoNodeModules = join(repoRoot, 'node_modules');

function runOmcInstall(
  args: string[],
  env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  if (!existsSync(binPath)) {
    throw new Error(`CLI binary missing: ${binPath} — run \`npm run build:cli\` first.`);
  }
  const result = spawnSync('node', [binPath, 'install', ...args], {
    env: {
      // 清掉宿主会话变量，避免 auto-detect 把 effectiveClient 变成 zcode，
      // 否则 E1 分支不会触发。我们测的是显式 `--client claude|codebuddy`。
      HOME: env.HOME ?? '/tmp',
      PATH: process.env.PATH ?? '',
      // 让 vitest 的 node_modules 优先于仓库自身，避免 require 解析到别处。
      NODE_PATH: repoNodeModules,
      // 完全隔离：不让父进程的 OMC_CLIENT / ZCODE_* / CODEBUDDY_* 透传到子进程。
      OMC_CLIENT: '',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('--workspace with non-zcode client (E1) — subprocess smoke', () => {
  it('omc install --client claude --workspace exits 1 with conflict message', () => {
    const result = runOmcInstall(['--client', 'claude', '--workspace'], {
      HOME: '/tmp/omc-claude-ws-test',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--workspace currently only supports --client zcode');
    // 同时回显实际冲突的 client，便于排错。
    expect(result.stderr).toContain('--client claude');
  });

  it('omc install --client codebuddy --workspace exits 1 with conflict message', () => {
    const result = runOmcInstall(['--client', 'codebuddy', '--workspace'], {
      HOME: '/tmp/omc-cb-ws-test',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--workspace currently only supports --client zcode');
    expect(result.stderr).toContain('--client codebuddy');
  });
});
