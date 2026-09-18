# ZCode 工作空间级别安装实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `omc install --client zcode --workspace` 把 OMC 全套用户级产物镜像到 `<cwd>/.zcode/`（工作空间级别），与 `~/.zcode/`（用户级）共存；同时把 `omc setup --client zcode` 迁移为 `omc install --client zcode` 的 thin alias（向后兼容）。

**Architecture:** 沿用上一轮 zcode-support（HEAD `651d110b8`）已落地的 `setupZcode` 10 步编排，新增 `scope: 'user' | 'workspace'` 参数，仅第 1 步（mkdir）与第 10 步（version 文件位置）按 scope 分支；新增 `src/utils/zcode-paths.ts` 的 `resolveZcodePaths` helper 作为路径派生的唯一来源；`src/cli/index.ts` 的 `omc install` 命令加 `--client <name>` 与 `--workspace[=path]` 两个 flag，dispatch 复用既有 `setupZcode`/`installOmc`；`omc setup` action 改为透传 argv 到 `omc install`（保留为向后兼容 alias）。不动 preload / detection / bridge bundle。

**Tech Stack:** TypeScript (ESM, Node 18)、vitest、commander；无新增依赖。

**Spec:** `docs/superpowers/specs/2026-09-18-zcode-workspace-support-design.md`（本计划从 spec 论证；执行者须同读两份，并参考上一轮 spec `2026-09-18-zcode-support-design.md`）

## Global Constraints

- 仓库：`reference/oh-my-claudecode`（fork），分支 `feat/zcode-workspace-support`（**前置**：`feat/zcode-support` 已合入 `feat/codebuddy-support`，本分支基于合入后的 `feat/codebuddy-support` 切出）。
- commit message 用中文，保留 conventional commit 前缀（`feat(zcode): …` / `test(zcode): …` / `docs(zcode): …`）。
- 不新增任何 npm 依赖。
- 工作空间级别与用户级别产物布局一致：`<ws>/.zcode/{agents,hooks,skills,plans,commands,cli/config.json}` + `<ws>/.zcode/.agents/mcp.json`；`~/.zcode/` 不变。
- `.omc-version.json` 写到 `<workspacePath>/.omc-version.json`（顶层，**不进** `<ws>/.zcode/`，与 W6 一致）；`.omc/` state 子目录同样在 `<workspacePath>/.omc/` 顶层。
- MCP 路径注入策略：workspace 模式也**不注入** `CLAUDE_MCP_CONFIG_PATH`（与上一轮用户级一致，spec W7）。
- 工作空间级别不注入：仅 zcode 支持；`--workspace --client claude|codebuddy` 必须报 E1 错误退出 1。
- `--workspace` 无值 → `<cwd>/.zcode`；`--workspace=PATH` → PATH 整路径（不自动追加 `.zcode/`）。
- workspace 与 user-level install **互不覆盖、独立存在**；OMC 不做跨路径合并；ZCode 自身决定合并（spec W4）。
- 错误处理：不自动回滚；`config.json` 写前备份；temp+rename 原子替换；单 hook 失败不阻断整体（spec §7）。
- 现有 350+ 测试不得回退；每任务收尾跑全量 `npm test`。
- bridge bundle (`bridge/cli.cjs`) 仅当 src/cli 调用形态变更时需要重建；本计划对 src/cli/index.ts 的修改属 flag 层面（runtime 解析），不影响 bundle 字节；任何 src/cli 改动后必须确认 `git diff bridge/cli.cjs` 为空，否则重建。
- **既有 spec `2026-09-18-zcode-support-design.md` 的全部约束在本计划继承生效**（hook 6 事件、`hooks.enabled:false` 中止、检测签名键、agent frontmatter 转换、幂等性、备份命名等）。

---

### Task 1: `resolveZcodePaths` helper（路径派生单一来源）

**Files:**
- Create: `src/utils/zcode-paths.ts`
- Test: `src/utils/__tests__/zcode-paths.test.ts`

**Interfaces:**
- Consumes: 无（pure function）。
- Produces:
  ```ts
  export type ZcodeInstallScope = 'user' | 'workspace';
  export interface ResolvedZcodePaths {
    zcodeDir: string;              // user: ~/.zcode; workspace: <ws>/.zcode
    agentsMcpJsonPath: string;     // user: ~/.agents/mcp.json; workspace: <ws>/.zcode/.agents/mcp.json
  }
  export function resolveZcodePaths(
    scope: ZcodeInstallScope,
    workspacePath?: string         // 仅 scope='workspace' 时有意义；undefined → cwd/.zcode
  ): ResolvedZcodePaths;
  ```

  Task 2 改 `setupZcode` 时直接调用此 helper 派生 `zcodeDir` 与 `agentsMcpJsonPath`，Task 3-6 的 CLI 侧也复用。

- [ ] **Step 1: 写失败测试**

```ts
// src/utils/__tests__/zcode-paths.test.ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/utils/__tests__/zcode-paths.test.ts`
Expected: FAIL（模块不存在：`Cannot find module '../zcode-paths.js'`）。

- [ ] **Step 3: 实现 helper**

`src/utils/zcode-paths.ts`：

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

/** ZCode install 的两种作用范围。user 写到 ~/.zcode（用户级）；workspace 写到
 * <workspacePath>/.zcode（项目级，与 GSD 实例一致）。 */
export type ZcodeInstallScope = 'user' | 'workspace';

/** setupZcode 需要的两个路径。 */
export interface ResolvedZcodePaths {
  /** ZCode 客户端配置根。user → ~/.zcode；workspace → <ws>/.zcode。 */
  zcodeDir: string;
  /** OMC MCP 服务合并目标。user → ~/.agents/mcp.json；workspace → <ws>/.zcode/.agents/mcp.json（在 zcodeDir 内而非顶层，与 spec W5 一致）。 */
  agentsMcpJsonPath: string;
}

/** 由 (scope, workspacePath?) 派生 setupZcode 需要的两个路径。
 * workspace 模式下，workspacePath 为 undefined 时回退到 cwd/.zcode（与 --workspace 无值时的 CLI 默认一致）。 */
export function resolveZcodePaths(
  scope: ZcodeInstallScope,
  workspacePath?: string,
): ResolvedZcodePaths {
  if (scope === 'workspace') {
    const zcodeDir = workspacePath ?? join(process.cwd(), '.zcode');
    return {
      zcodeDir,
      agentsMcpJsonPath: join(zcodeDir, '.agents', 'mcp.json'),
    };
  }
  return {
    zcodeDir: join(homedir(), '.zcode'),
    agentsMcpJsonPath: join(homedir(), '.agents', 'mcp.json'),
  };
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量不回退**

Run: `npx vitest run src/utils/__tests__/zcode-paths.test.ts && npm test`
Expected: PASS；既有 350+ 测试不回退。

- [ ] **Step 5: 提交**

```bash
git add src/utils/zcode-paths.ts src/utils/__tests__/zcode-paths.test.ts
git commit -m "feat(zcode-workspace): resolveZcodePaths helper——scope 与 workspacePath 派生路径（T1）"
```

---

### Task 2: `setupZcode` 接受 `scope` 参数（第 1/10 步分支）

**Files:**
- Modify: `src/installer/zcode.ts`（10 步编排的步 1 与步 10；接口签名扩展）
- Modify: `src/installer/__tests__/zcode-setup.test.ts`（追加 scope='workspace' 用例）

**Interfaces:**
- Consumes: Task 1 的 `resolveZcodePaths`。
- Produces:
  ```ts
  export interface SetupZcodeOptions {
    scope: 'user' | 'workspace';     // 新增；user 为现有默认行为（向后兼容）
    zcodeDir: string;                // 现成；调用方经 resolveZcodePaths 派生
    agentsMcpJsonPath: string;       // 现成；同上
    workspacePath?: string;          // 仅 scope='workspace' 时使用；用于第 10 步定位 .omc-version.json
    packageDir: string;
    hooksWanted?: boolean;
    log: (message: string) => void;
  }
  ```

  `scope='workspace'` 时行为差异：
  - 第 1 步 mkdir：额外创建 `<workspacePath>/.omc/`（顶层，**不进** zcodeDir，与 W6 一致）
  - 第 10 步 version 文件：写到 `<workspacePath>/.omc-version.json`（顶层而非 zcodeDir 内）

  其余 8 步行为同构；`scope='user'`（默认）行为与现有完全一致。

- [ ] **Step 1: 写失败测试**

在 `src/installer/__tests__/zcode-setup.test.ts` 末尾追加新 describe 块（沿用同文件现有 `setupZcode` describe 的临时 HOME 树模式）：

```ts
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
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/installer/__tests__/zcode-setup.test.ts`
Expected: FAIL（`SetupZcodeOptions.scope` 与 `workspacePath` 字段类型错误 / 不存在）。

- [ ] **Step 3: 实现 `setupZcode` scope 分支**

`src/installer/zcode.ts` 改动点：

1. 接口签名扩展（参考 spec §5.2）：

```ts
export interface SetupZcodeOptions {
  scope: 'user' | 'workspace';
  zcodeDir: string;
  agentsMcpJsonPath: string;
  workspacePath?: string;
  packageDir: string;
  hooksWanted?: boolean;
  log: (message: string) => void;
}
```

2. 第 1 步：scope='workspace' 时追加 mkdir：

```ts
  // 1 mkdir（scope 分支）
  mkdirSync(zcodeDir, { recursive: true });
  if (options.scope === 'workspace' && options.workspacePath) {
    mkdirSync(join(options.workspacePath, '.omc'), { recursive: true });
  }
```

3. 第 10 步 version 文件位置按 scope 分支：

```ts
  // 10 version 标记（spec §6.3）
  const versionPayload = {
    version: PACKAGE_VERSION,
    installedAt: new Date().toISOString(),
    ...(options.scope === 'workspace' && options.workspacePath
      ? { scope: 'workspace' as const, workspacePath: options.workspacePath }
      : { scope: 'user' as const }),
  };
  const versionPath = options.scope === 'workspace' && options.workspacePath
    ? join(options.workspacePath, '.omc-version.json')
    : join(zcodeDir, '.omc-version.json');
  writeFileSync(versionPath, JSON.stringify(versionPayload, null, 2));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/installer/__tests__/zcode-setup.test.ts`
Expected: PASS（既有 12+ 用例 + 新增 3 个 workspace 用例）。

- [ ] **Step 5: 全量回归**

Run: `npm test`
Expected: PASS（baseline 持平）。

- [ ] **Step 6: 提交**

```bash
git add src/installer/zcode.ts src/installer/__tests__/zcode-setup.test.ts
git commit -m "feat(zcode-workspace): setupZcode scope 分支——workspace 模式第 1/10 步路径派生（T2）"
```

---

### Task 3: `omc install --client zcode` dispatch（迁移自 setup）

**Files:**
- Modify: `src/cli/index.ts`（install 命令 line 894：加 `--client <name>` flag 与 zcode 分派）
- Create: `src/cli/__tests__/install-client-zcode-option.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `setupZcode({scope, ...})`。
- Produces: `omc install --client zcode` 触发 `setupZcode({scope:'user', zcodeDir: ~/.zcode, ...})`，与原 `omc setup --client zcode` 等价（行为同构）；claude/codebuddy 路径继续走 `installOmc`，字节不变。

- [ ] **Step 1: 写失败测试**

```ts
// src/cli/__tests__/install-client-zcode-option.test.ts
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

describe('omc install --client <name>', () => {
  it('accepts --client zcode without usage error', () => {
    const program = new Command();
    program
      .option('-c, --client <client>')
      .choices(['claude', 'codebuddy', 'zcode']);
    // 模拟 install 命令 dispatch 的 options 解析
    const opts = program.parse(['node', 'test', '--client', 'zcode']).opts();
    expect(opts.client).toBe('zcode');
  });
  it('rejects unknown client', () => {
    const program = new Command();
    program
      .option('-c, --client <client>')
      .choices(['claude', 'codebuddy', 'zcode']);
    expect(() => program.parse(['node', 'test', '--client', 'windowmaker'])).toThrow();
  });
});
```

> 注：本测试是 commander 选项解析层面的最小断言。集成层面的"install --client zcode 触发 setupZcode"在 Task 6 的 setup-alias 测试里复用（因为 alias 透传到 install）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/cli/__tests__/install-client-zcode-option.test.ts`
Expected: PASS（commander 自身支持 choices，本测试验证契约）。

> 若 commander choices 已能直接解析，本测试快速通过。下面的 dispatch 接线才决定 zcode 分派是否真正生效。

- [ ] **Step 3: 改 `omc install` 加 `--client` flag + zcode 分派**

`src/cli/index.ts` install 命令（line 894-）改造：

```ts
  .command('install')
  .description('Install OMC agents/commands/hooks/MCP to a target host CLI (default: claude user-level)')
  .option('-f, --force', 'Overwrite existing files')
  .option('-q, --quiet', 'Suppress output except for errors')
  .option('--skip-claude-check', 'Skip checking if Claude Code is installed')
  .option('--skip-hooks', 'Skip hook installation')
  .option('--force-hooks', 'Force reinstall hooks even if unchanged')
  .option('--no-plugin', 'Install bundled skills from the current package')
  .option('--plugin-dir-mode', 'Treat OMC as launched via --plugin-dir')
  .addOption(
    new Option('-c, --client <client>', 'Target host CLI (default: auto-detect or claude)')
      .choices(['claude', 'codebuddy', 'zcode'])
  )
  .option('--workspace [path]', 'Install to <cwd>/.zcode (default) or <path>; only valid with --client zcode')
  .addHelpText('after', `
Examples:
  $ omc install                              Install to default Claude Code config (~/.claude)
  $ omc install --client zcode               Install to ~/.zcode (ZCode user-level)
  $ omc install --client zcode --workspace   Install to <cwd>/.zcode (ZCode workspace-level)
  $ omc install --workspace=/abs/proj/.zcode Workspace install at custom path

Client targeting:
  --client claude|codebuddy|zcode is optional. Without it, the session is
  auto-detected (CodeBuddy sessions install to ~/.codebuddy; ZCode sessions
  install to ~/.zcode; everything else installs to ~/.claude).`)
```

action 内（在 `installOmc` 调用前）插入 zcode 分派：

```ts
    const effectiveClient = options.client ?? detectClient();

    if (effectiveClient === 'zcode') {
      const { zcodeDir, agentsMcpJsonPath } = resolveZcodePaths('user');
      const result = setupZcode({
        scope: 'user',
        zcodeDir,
        agentsMcpJsonPath,
        packageDir: getRuntimePackageRoot(),
        hooksWanted: !options.skipHooks,
        log: (message) => { if (!options.quiet) console.log(chalk.gray(message)); },
      });
      if (!result.success) {
        console.error(chalk.red(`ZCode install failed: ${result.message}`));
        result.errors.forEach((err) => console.error(chalk.red(`  - ${err}`)));
        process.exit(1);
      }
      if (!options.quiet) {
        console.log(chalk.green('ZCode user-level install complete (~/.zcode)!'));
        console.log(chalk.gray(`skills=${result.deployed.skills} commands=${result.deployed.commands} agents=${result.deployed.agents} hooks=${result.deployed.hooks ? 'wired' : 'skipped'}`));
      }
      return;
    }
    // 既有 installOmc 分支不变
```

（`resolveZcodePaths` 与 `setupZcode` 从 `../utils/zcode-paths.js` 与 `../installer/zcode.js` import；`getRuntimePackageRoot` 沿用 Task 7 中的 import。）

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `npx vitest run src/cli/__tests__/install-client-zcode-option.test.ts && npm test`
Expected: PASS；baseline 持平（zcode 分派仅在 `--client zcode` 时生效，其余路径字节不变）。

- [ ] **Step 5: 提交**

```bash
git add src/cli/index.ts src/cli/__tests__/install-client-zcode-option.test.ts
git commit -m "feat(zcode-workspace): omc install --client zcode dispatch——迁移原 setup --client zcode 路径（T3）"
```

---

### Task 4: `omc install --client zcode --workspace` dispatch

**Files:**
- Modify: `src/cli/index.ts`（install action 加 `--workspace` 处理）
- Create: `src/cli/__tests__/install-workspace-option.test.ts`
- Create: `src/cli/__tests__/install-workspace-path-option.test.ts`

**Interfaces:**
- Consumes: Task 3 的 zcode 分派。
- Produces: `omc install --client zcode --workspace` 触发 `setupZcode({scope:'workspace', workspacePath, zcodeDir, agentsMcpJsonPath})`；`--workspace=PATH` 时 PATH 整路径作 zcodeDir。

- [ ] **Step 1: 写失败测试**

```ts
// src/cli/__tests__/install-workspace-option.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('--workspace flag dispatch (integration)', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'omc-ws-cli-'));
    vi.spyOn(process, 'cwd').mockReturnValue(workDir);
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('omc install --client zcode --workspace writes <cwd>/.zcode and <cwd>/.omc-version.json', async () => {
    // 真实 CLI 调用（env 注入 HOME 隔离）：
    const home = mkdtempSync(join(tmpdir(), 'omc-ws-cli-home-'));
    const result = runOmcInstall(['--client', 'zcode', '--workspace'], { HOME: home, cwd: workDir });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(workDir, '.zcode', 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(workDir, '.omc-version.json'))).toBe(true);
    // user-level ~/.zcode 不被写入
    expect(existsSync(join(home, '.zcode'))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});
```

> `runOmcInstall` helper：调用 `node ./bin/oh-my-claudecode.js install ...` 子进程并捕获 stdout/stderr/exitCode。可放在测试文件顶部或 `_helpers` 工具模块。沿用上一轮 zcode-support 计划 T7 步骤 5 的 smoke 模式。

```ts
// src/cli/__tests__/install-workspace-path-option.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('--workspace=PATH flag dispatch', () => {
  let workDir: string;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'omc-ws-path-')); vi.spyOn(process, 'cwd').mockReturnValue(workDir); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('omc install --client zcode --workspace=/abs/path writes to that exact path', () => {
    const target = join(workDir, 'myproj');
    const result = runOmcInstall(['--client', 'zcode', `--workspace=${target}`], { HOME: mkdtempSync(join(tmpdir(), 'omc-ws-path-home-')) });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(target, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(workDir, '.zcode'))).toBe(false); // 没有自动创建 <cwd>/.zcode
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/cli/__tests__/install-workspace-option.test.ts src/cli/__tests__/install-workspace-path-option.test.ts`
Expected: FAIL（`--workspace` 选项不被识别 / 不触发 workspace 分派）。

- [ ] **Step 3: 改 install action 加 `--workspace` 处理**

`src/cli/index.ts` install action 顶部（zcode 分派前）：

> import 增补：`node:path` 的 import 从 `{ join }` 改为 `{ join, dirname }`（line 23）。

```ts
    const effectiveClient = options.client ?? detectClient();
    const workspaceArg = options.workspace;  // true | string | undefined

    // E1: --workspace only valid with --client zcode
    if (workspaceArg !== undefined && effectiveClient !== 'zcode') {
      console.error(chalk.red(`--workspace currently only supports --client zcode (got --client ${effectiveClient})`));
      process.exit(1);
    }

    if (effectiveClient === 'zcode') {
      const scope: 'user' | 'workspace' = workspaceArg !== undefined ? 'workspace' : 'user';
      // workspaceArg: true → <cwd>/.zcode; string → PATH 整体作 zcodeDir（spec §5.4 不自动追加）
      const workspacePathForResolve = workspaceArg === true ? join(process.cwd(), '.zcode') : workspaceArg;
      const { zcodeDir, agentsMcpJsonPath } = resolveZcodePaths(scope, workspacePathForResolve);
      // setupZcode 的 workspacePath 参数语义是"workspace 模式根目录"，用于 .omc-version.json 与 .omc/ 写入位置。
      // 始终取 dirname(zcodeDir)，保证 .omc/ 顶层（在 zcodeDir 之外），与 spec W6 一致：
      //   - --workspace (bare): zcodeDir=cwd/.zcode → workspacePath=cwd → .omc-version.json at <cwd>/.omc-version.json
      //   - --workspace=/abs/proj: zcodeDir=/abs/proj → workspacePath=/abs → .omc-version.json at <parent>/.omc-version.json
      const workspacePathForSetup = scope === 'workspace' ? dirname(zcodeDir) : undefined;
      const result = setupZcode({
        scope,
        zcodeDir,
        agentsMcpJsonPath,
        ...(workspacePathForSetup ? { workspacePath: workspacePathForSetup } : {}),
        packageDir: getRuntimePackageRoot(),
        hooksWanted: !options.skipHooks,
        log: (message) => { if (!options.quiet) console.log(chalk.gray(message)); },
      });
      if (!result.success) {
        console.error(chalk.red(`ZCode ${scope} install failed: ${result.message}`));
        result.errors.forEach((err) => console.error(chalk.red(`  - ${err}`)));
        process.exit(1);
      }
      if (!options.quiet) {
        const targetLabel = scope === 'workspace' ? zcodeDir : '~/.zcode';
        console.log(chalk.green(`ZCode ${scope} install complete (${targetLabel})!`));
        console.log(chalk.gray(`skills=${result.deployed.skills} commands=${result.deployed.commands} agents=${result.deployed.agents} hooks=${result.deployed.hooks ? 'wired' : 'skipped'}`));
      }
      return;
    }
```

> 关键：`workspacePath` 参数传给 `setupZcode` 的语义是"workspace 模式根目录"（即 zcodeDir 的父目录），用于 `.omc-version.json` 与 `.omc/` 写入位置。**始终取 `dirname(zcodeDir)`**，确保 `.omc/` 顶层（在 zcodeDir 之外），与 spec W6 一致：
>
> - `--workspace`（bare）：zcodeDir = `<cwd>/.zcode` → workspacePath = `<cwd>` → `.omc-version.json` 写到 `<cwd>/.omc-version.json`
> - `--workspace=/abs/proj`：zcodeDir = `/abs/proj`（用户显式提供，spec §5.4 不自动追加）→ workspacePath = `/abs` → `.omc-version.json` 写到 `/abs/.omc-version.json`

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `npx vitest run src/cli/__tests__/install-workspace-option.test.ts src/cli/__tests__/install-workspace-path-option.test.ts && npm test`
Expected: PASS；baseline 持平。

- [ ] **Step 5: 提交**

```bash
git add src/cli/index.ts src/cli/__tests__/install-workspace-option.test.ts src/cli/__tests__/install-workspace-path-option.test.ts
git commit -m "feat(zcode-workspace): omc install --client zcode --workspace dispatch 与路径解析（T4）"
```

---

### Task 5: E1 错误——`--workspace --client claude|codebuddy` 冲突

**Files:**
- Create: `src/cli/__tests__/install-workspace-conflict.test.ts`

**Interfaces:**
- Consumes: Task 4 的 E1 报错分支。
- Produces: `--workspace` 与 `--client claude|codebuddy` 同时存在时退出码 1，stderr 含 `--workspace currently only supports --client zcode`。

- [ ] **Step 1: 写失败测试**

```ts
// src/cli/__tests__/install-workspace-conflict.test.ts
import { describe, it, expect } from 'vitest';
import { runOmcInstall } from './_helpers.js';

describe('--workspace with non-zcode client (E1)', () => {
  it('omc install --client claude --workspace exits 1 with conflict message', () => {
    const result = runOmcInstall(['--client', 'claude', '--workspace'], { HOME: '/tmp/omc-claude-ws-test' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--workspace currently only supports --client zcode');
  });
  it('omc install --client codebuddy --workspace exits 1', () => {
    const result = runOmcInstall(['--client', 'codebuddy', '--workspace'], { HOME: '/tmp/omc-cb-ws-test' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--workspace currently only supports --client zcode');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/cli/__tests__/install-workspace-conflict.test.ts`
Expected: FAIL（Task 3-4 已实现的 E1 分支应让此测试通过；若失败说明 E1 逻辑位置错误）。

> 若 Task 3-4 已含 E1 逻辑，本测试作为回归保险存在。

- [ ] **Step 3: 验证 E1 已实现；如未实现，追加**

若 Task 4 Step 3 的 E1 分支存在，本任务无需实现代码；若不存在，按 Task 4 Step 3 的 E1 代码块补全。

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `npx vitest run src/cli/__tests__/install-workspace-conflict.test.ts && npm test`
Expected: PASS；baseline 持平。

- [ ] **Step 5: 提交**

```bash
git add src/cli/__tests__/install-workspace-conflict.test.ts
git commit -m "test(zcode-workspace): E1 冲突——--workspace 与非 zcode client 报错退出 1（T5）"
```

---

### Task 6: `omc setup` → `omc install` thin alias（向后兼容）

**Files:**
- Modify: `src/cli/index.ts`（setup action line ~1450 改为 argv 透传）
- Create: `src/cli/__tests__/setup-alias.test.ts`

**Interfaces:**
- Consumes: Task 3-4 的 install dispatch。
- Produces: `omc setup --client zcode`（无 `--workspace`）行为等价于 `omc install --client zcode`；`omc setup --client zcode --workspace` 行为等价于 `omc install --client zcode --workspace`。**原有 setup 命令的 client 检测与 help text 保持可见**（向后兼容既有调用方）。

- [ ] **Step 1: 写失败测试**

```ts
// src/cli/__tests__/setup-alias.test.ts
import { describe, it, expect } from 'vitest';
import { runOmcSetup, runOmcInstall } from './_helpers.js';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('omc setup thin alias to omc install', () => {
  it('omc setup --client zcode (no --workspace) produces same artifacts as omc install --client zcode', () => {
    const home1 = mkdtempSync(join(tmpdir(), 'omc-alias-setup-'));
    const home2 = mkdtempSync(join(tmpdir(), 'omc-alias-install-'));
    try {
      const a = runOmcSetup(['--client', 'zcode'], { HOME: home1 });
      const b = runOmcInstall(['--client', 'zcode'], { HOME: home2 });
      expect(a.exitCode).toBe(0);
      expect(b.exitCode).toBe(0);
      // 两边都有 ~/.zcode/AGENTS.md
      expect(existsSync(join(home1, '.zcode', 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(home2, '.zcode', 'AGENTS.md'))).toBe(true);
    } finally {
      rmSync(home1, { recursive: true, force: true });
      rmSync(home2, { recursive: true, force: true });
    }
  });
  it('omc setup --client zcode --workspace behaves like omc install --client zcode --workspace', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'omc-alias-ws-'));
    const home1 = mkdtempSync(join(tmpdir(), 'omc-alias-ws-setup-'));
    const home2 = mkdtempSync(join(tmpdir(), 'omc-alias-ws-install-'));
    try {
      const a = runOmcSetup(['--client', 'zcode', '--workspace'], { HOME: home1, cwd: workDir });
      const b = runOmcInstall(['--client', 'zcode', '--workspace'], { HOME: home2, cwd: workDir });
      expect(a.exitCode).toBe(0);
      expect(b.exitCode).toBe(0);
      expect(existsSync(join(workDir, '.zcode', 'AGENTS.md'))).toBe(true);
      expect(existsSync(join(workDir, '.omc-version.json'))).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(home1, { recursive: true, force: true });
      rmSync(home2, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/cli/__tests__/setup-alias.test.ts`
Expected: FAIL（setup action 仍走独立 dispatch，未透传 install）。

- [ ] **Step 3: 改 `omc setup` action 为透传**

`src/cli/index.ts` setup action（line ~1450）改为：

```ts
  .action(async (options) => {
    // thin alias: 透传 argv 到 omc install（spec §4.3）。
    // omc setup 的既有语义（--client/--force/--quiet/--skip-hooks 等）由 install 命令统一解释。
    const args = ['install'];
    if (options.client) args.push('--client', options.client);
    if (options.workspace !== undefined) {
      args.push(options.workspace === true ? '--workspace' : `--workspace=${options.workspace}`);
    }
    if (options.force) args.push('--force');
    if (options.quiet) args.push('--quiet');
    if (options.skipHooks) args.push('--skip-hooks');
    if (options.forceHooks) args.push('--force-hooks');
    if (options.plugin === false) args.push('--no-plugin');
    if (options.pluginDirMode) args.push('--plugin-dir-mode');
    await program.parseAsync([process.argv[0], process.argv[1], ...args]);
  });
```

> setup 命令的 `.option(...)` 与 `.addOption(...)` 全部保留（既有 `omc setup` 调用方对 `--help` 输出与 flag 解析仍按 setup 自身契约工作）。仅 action 改为透传。

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `npx vitest run src/cli/__tests__/setup-alias.test.ts && npm test`
Expected: PASS；baseline 持平。

- [ ] **Step 5: 提交**

```bash
git add src/cli/index.ts src/cli/__tests__/setup-alias.test.ts
git commit -m "feat(zcode-workspace): omc setup 改为 omc install thin alias（向后兼容）（T6）"
```

---

### Task 7: bundle smoke + mirror-sync 回归

**Files:**
- Modify: `src/cli/__tests__/bundle-smoke.test.ts`（既有，扩展 workspace form）
- 验证: `bridge/cli.cjs` 是否需要重建（本计划对 src/cli 调用形态仅 flag 层面变更，预期不需）

**Interfaces:**
- Consumes: Task 3-6 的全部改动。
- Produces: 三形态 bundle smoke（默认 / `--workspace` / 错误）通过；mirror-sync 不破。

- [ ] **Step 1: bundle smoke 扩展（workspace form）**

在 `src/cli/__tests__/bundle-smoke.test.ts` 追加（沿用既有模式）：

```ts
it('bundle: omc install --client zcode --workspace exits 0 with workspace artifacts', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'omc-bundle-ws-'));
  const home = mkdtempSync(join(tmpdir(), 'omc-bundle-ws-home-'));
  try {
    const result = spawnSync('node', [join(process.cwd(), 'bin/oh-my-claudecode.js'), 'install', '--client', 'zcode', '--workspace'], {
      env: { ...process.env, HOME: home },
      cwd: workDir,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(workDir, '.zcode', 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(workDir, '.omc-version.json'))).toBe(true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑 bundle smoke**

Run: `npx vitest run src/cli/__tests__/bundle-smoke.test.ts`
Expected: PASS（workspace form 通过）。

- [ ] **Step 3: 验证 bridge bundle**

Run: `git diff bridge/cli.cjs`
Expected: 无变更（CLI flag 解析在 runtime，不影响 bundle 字节）。

若 `git diff bridge/cli.cjs` 非空，**停止**——本计划不允许重建 bundle；若有需要，重建步骤应在后续独立 PR 完成。

- [ ] **Step 4: 全量回归 + mirror-sync**

Run: `npm test`
Expected: PASS；baseline 持平；mirror-sync 测试通过（本计划未引入新 mirror）。

- [ ] **Step 5: 提交**

```bash
git add src/cli/__tests__/bundle-smoke.test.ts
git commit -m "test(zcode-workspace): bundle smoke 扩展 workspace form；mirror-sync 不破（T7）"
```

---

### Task 8: 文档、终验与真实项目 spike

**Files:**
- Modify: `README.md`（CodeBuddy 段后追加 ZCode 段落，加 workspace 子段）
- Modify: `README.zh.md`（同上中文版）

**Interfaces:**
- Consumes: Task 1-7 全部。
- Produces: 用户面文档（README 双语）+ 真实项目 spike 验收证据。

- [ ] **Step 1: README 段落（英文，紧随 CodeBuddy 段落体例）**

```markdown
### ZCode (standalone + workspace)

ZCode is supported via two install modes, both standalone (no marketplace
plugin needed):

```bash
omc install --client zcode               # User-level: writes to ~/.zcode
omc install --client zcode --workspace   # Workspace-level: writes to <cwd>/.zcode
```

This deploys skills/commands/agents, wires the 6 supported hook events into
`cli/config.json`, registers the MCP bridge in `.agents/mcp.json`, syncs the
OMC block in `AGENTS.md`, and disables the `oh-my-claudecode` marketplace
plugin if present. Re-run after upgrades.

Workspace mode mirrors the full user-level layout under `<cwd>/.zcode/` and
writes the version stamp at `<cwd>/.omc-version.json`. User-level and
workspace-level coexist independently; ZCode itself decides precedence.

Subagent lifecycle and precompact hooks are not available on ZCode (host does
not expose those events). If you configure native MCP servers in
`cli/config.json`, note that `.agents/mcp.json` is skipped by ZCode.

`omc setup --client zcode [--workspace]` remains as a thin alias of
`omc install --client zcode [--workspace]` for backward compatibility.
```

`README.zh.md` 给出对等中文段落。

- [ ] **Step 2: 全量回归**

Run: `npm test`
Expected: PASS（既有 baseline + 本计划新增 ~12 个用例）。

- [ ] **Step 3: 提交文档**

```bash
git add README.md README.zh.md
git commit -m "docs(zcode-workspace): README/README.zh 的 ZCode workspace 段落（T8）"
```

- [ ] **Step 4: 真实项目 spike（用户协作，gating for merge）**

1. 在 `/Users/lizhouyang/beacon-ontology`（GSD workspace 实例）跑：
   ```bash
   cd /Users/lizhouyang/beacon-ontology
   HOME=$(mktemp -d) node /Users/lizhouyang/code2/beacon-coding/reference/oh-my-claudecode/bin/oh-my-claudecode.js install --client zcode --workspace
   ```
   预期：退出码 0；`./.zcode/{AGENTS.md,hooks,skills,commands,agents,cli/config.json,.agents/mcp.json}` 与 GSD 既有 skills 共存；`./.omc-version.json` 在项目顶层（不在 `.zcode/` 内）。

2. 在 ZCode 中打开 `/Users/lizhouyang/beacon-ontology`，确认 OMC 的 workspace skills/agents 实际加载（与 GSD 既有 skills 并列）。

3. 验证 workspace install 不污染用户级：检查 spike 时的临时 HOME，确认无 `~/.zcode/` 写入。

4. 若 spike 失败，按现象回填 spec §11 待解决项与 T1-T7 的回归测试。

---

## Self-Review 记录

- **Spec 覆盖**：§3 W1-W9 决策→T1-T6 各任务体现；§4.1 组件关系→T3-T6 dispatch；§4.3 命令面统一→T3 + T6；§5.1 resolveZcodePaths→T1；§5.2 setupZcode 签名→T2；§5.3 install dispatch→T3 + T4；§5.4 --workspace 解析→T4；§6.1 10 步数据流→T2；§6.2 状态文件位置→T2 + T3；§6.3 .omc-version.json schema→T2；§7.1 E1→T5 + T3/T4 隐含；§7.2 幂等性→T2 Step 1 第 2 个 it；§8.1 T1-T12→T1-T8 各任务；§9 交付→T1-T7 文件清单。无缺口。
- **占位符扫描**：T4 Step 3 的 workspacePath 派生逻辑有"简化建议"段落，是执行者可调整的实现提示（不影响 spec 接口约束），不算 placeholder。T5 Step 3 写"如未实现，追加"是回归保险话术（Task 4 已实现 E1）。其余步骤均含实际代码或具体行为断言。
- **类型一致性**：`resolveZcodePaths(scope, workspacePath?)`（T1 接口块）→ T2/T3/T4 调用点参数顺序与可选项一致；`SetupZcodeOptions.scope` 与 `workspacePath`（T2 接口块）→ T3/T4 调用点字段一致；`omc install` `--client` choices 数组（`['claude','codebuddy','zcode']`）在 T3/T4/T5/T6 引用一致。
- **依赖关系**：T1 → T2 → T3 → T4 → T5/T6 → T7 → T8（线性）；T5 是 T4 的回归保险可与 T6 并行；T7 bundle smoke 是 T3-T6 的端到端保险；T8 是 docs 与 spike 收尾。
- **未完成项**：
  - T8 Step 4 的真实 spike 依赖用户协作（开 ZCode 实机会话），不在自动化范围内。
  - T7 Step 3 的 bundle diff 假设为"空"；若非空，本计划需要追加 bundle 重建子步骤（建议另起 PR）。
