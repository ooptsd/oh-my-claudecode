# ZCode 工作空间级别安装设计（oh-my-claudecode）

- 日期：2026-09-18
- 状态：已经用户逐节确认，待实施
- 分支：`feat/zcode-workspace-support`（基于合入 `feat/zcode-support` 后的 `feat/codebuddy-support`）
- 继承：`2026-09-18-zcode-support-design.md`（用户级 zcode install，HEAD `651d110b8`）
- 参照：`/Users/lizhouyang/beacon-ontology`（GSD workspace 实例，仅参考，不修改）、本仓库 CodeBuddy 适配先例、本仓库上一轮 zcode-support 实证矩阵

## 1. 背景与动机

上一轮已落地 `omc setup --client zcode`（用户级，`~/.zcode/`），但 ZCode 实际还支持**工作空间级别**配置：`<cwd>/.zcode/`（与 GSD、CodeBuddy 等多客户端工具一致）。实证基础：

- `/Users/lizhouyang/beacon-ontology/.zcode/config.json` 存在 `{"plugins":{"enabledPlugins":{...}}}` 形态——ZCode 会读 `<cwd>/.zcode/config.json` 作为 workspace 级别插件配置。
- GSD 在该 workspace 安装了 `skills/`、`agents/`、`commands/`、`plans/`、`gsd-install-state.json` 等全套产物。
- ZCode 官方文档未明文支持 workspace 级别，但实际可读（与本轮会话中用户定稿一致："官方文档没有说支持工作空间（项目）级的配置，但实际是支持的"）。

OMC 当前缺工作空间级别 install，导致：
- 用户在项目里跑 OMC，ZCode 实际加载的仍是 `~/.zcode` 全局产物，无法实现项目级 OMC 定制（如项目专用 agents/skills）。
- 与 GSD 工具共存的项目无法让 OMC 与 GSD 的 workspace-level skills/agents 并存。

## 2. 目标与非目标

### 目标

1. `omc install --client zcode --workspace` 新增工作空间级别 install 路径，写入 `<cwd>/.zcode/`（默认）或 `--workspace=PATH` 指定路径。
2. `omc install --client zcode`（无 `--workspace`）走用户级别，等价于上一轮的 `omc setup --client zcode`。
3. `omc setup --client zcode` 保留为 thin alias（透传到 `omc install --client zcode`），不破坏既有调用方。
4. `setupZcode` 接受 `scope: 'user' | 'workspace'` 参数，10 步流程同构，仅路径与若干状态文件位置不同。
5. 工作空间级别与用户级别互不覆盖、独立存在；ZCode 自身的合并机制决定优先级。

### 非目标（明确不做）

- 自动探测 `<cwd>/.zcode` 是否存在并自动进入 workspace 模式（必须显式 `--workspace`）。
- `omc install --client claude --workspace` / `--client codebuddy --workspace`（workspace 模式仅 zcode 支持；E1 报错）。
- 工作空间级别 `--uninstall` 子命令（v1 不含，留待 v2）。
- 工作空间级别 MCP 路径注入（`CLAUDE_MCP_CONFIG_PATH`）——与用户级一致不注入。
- preload 阶段的 workspace 适配（preload 仍仅作用于用户级运行时，workspace install 是离线动作）。
- 把 `setup` 命令标记 deprecated（保留为 thin alias 即可，与 codebuddy/claude 调用方解耦）。
- 自动同步 user-level 与 workspace-level（v1 仅手动；二者并存由 ZCode 合并）。

## 3. 决策记录

| # | 决策 | 选择 | 关键理由 |
|---|---|---|---|
| W1 | 安装路线 | 全套镜像用户级（skills/agents/commands/AGENTS.md/settings.json/config.json/mcp.json/hooks） | GSD 实例证明 ZCode workspace 可承载全量产物；OMC 不挑拣子集 |
| W2 | 路径默认 | `--workspace` 无值 → `cwd/.zcode`；`--workspace=PATH` → PATH 整路径（不自动追加 `.zcode`） | 与 GSD 实例路径一致；整路径语义避免歧义 |
| W3 | 命令入口 | `omc install --client zcode --workspace`（主）；`omc setup --client zcode --workspace`（透传 alias） | 统一入口到 `omc install`（既有 Claude Code 入口已在此），与默认命令对齐 |
| W4 | precedence | 工作空间级与用户级互不覆盖、独立存在；ZCode 自身决定合并 | OMC 不做跨路径合并（实现复杂度无收益）；与 GSD 行为一致 |
| W5 | MCP 载体 | workspace 模式下写 `<cwd>/.zcode/.agents/mcp.json`（在 zcodeDir 下而非 workspacePath 顶层） | 全部 workspace 产物集中在 `.zcode/` 内，便于项目级清理与迁移 |
| W6 | `.omc-version.json` | workspace 模式写到 `<workspacePath>/.omc-version.json`（顶层，不进 `.zcode/`） | 与现有 `.omc/` 业务语义一致（OMC 自身状态不进 zcode） |
| W7 | MCP 路径注入 | workspace 模式也不注入 `CLAUDE_MCP_CONFIG_PATH`（与用户级一致） | 与上一轮 zcode-support 用户定稿一致；测试 toBeUndefined() 钉死 |
| W8 | 实现路径 | Path A：参数化 `setupZcode` + 统一入口 | `setupZcode` 已接受 `zcodeDir` 参数，基础设施就绪；不动 installOmc / 既有 claude/codebuddy 路径 |
| W9 | 错误回滚 | 失败时不自动回滚；保留部分状态便于诊断 | 自动回滚中间态不可见；与用户级策略对齐 |

## 4. 架构

### 4.1 组件关系

```
┌────────────────────────────────────────────────────────────────┐
│                  CLI Layer (src/cli/index.ts)                  │
│  ┌──────────────────────────┐  ┌──────────────────────────┐    │
│  │ omc install              │  │ omc setup (thin alias)   │    │
│  │ --client <name>          │  │ forwards to install      │    │
│  │ --workspace[=path]       │  │ (preserves entry point)  │    │
│  └──────────────────────────┘  └──────────────────────────┘    │
└────────────────────────┬───────────────────────────────────────┘
                         │ dispatch
                         ▼
   ┌─────────────────────┴──────────────────────┐
   │                                            │
client='claude'/'codebuddy'            client='zcode'
   │                                            │
   ▼                                            ▼
┌──────────────────┐         ┌──────────────────────────────┐
│ installOmc(...)  │         │ setupZcode({                 │
│ (legacy, unchanged)        │   scope: 'user'|'workspace', │
│                  │         │   zcodeDir: computed,        │
│                  │         │   agentsMcpJsonPath: computed│
│                  │         │   packageDir,                │
│                  │         │   hooksWanted,               │
│                  │         │   log                        │
│                  │         │ })                           │
└──────────────────┘         └──────────────────────────────┘
                                       │
                                       ▼ scope 分支
                          ┌────────────┴───────────────┐
                          │                            │
                  scope='user'                scope='workspace'
                          │                            │
                          ▼                            ▼
                  ~/.zcode/...               <workspacePath>/.zcode/...
                  ~/.agents/mcp.json         <workspacePath>/.zcode/.agents/mcp.json
```

### 4.2 改动点（不动 preload / detection / bridge）

| 文件 | 变更 | 性质 |
|---|---|---|
| `src/cli/index.ts` | `omc install` 加 `--client <name>` + `--workspace[=path]` flag；client dispatch 复用既有 setupZcode / installOmc；`omc setup` action 改为透传 argv 到 install | 修改 |
| `src/installer/zcode.ts` | `setupZcode` 接受 `scope: 'user' \| 'workspace'`；10 步流程同构，仅路径与状态文件位置分支 | 修改 |
| `src/utils/zcode-paths.ts`（新文件） | `resolveZcodePaths(scope, workspacePath?)` helper，返回 `{ zcodeDir, agentsMcpJsonPath }` | 新增 |
| `src/utils/client.ts` | 不动 | — |
| `src/cli/preload-client-env.ts` | 不动 | — |
| `bridge/cli.cjs` | 不变（无 src/cli 调用形态变更，CLI flag 仅在 runtime） | — |

不动 preload 与 detection 的理由：workspace install 是离线写文件动作，不启动 ZCode 进程，不影响运行时 env 注入；运行时 ZCode 进程读取 `<cwd>/.zcode/` 还是 `~/.zcode/` 由 ZCode 自身行为决定。

### 4.3 命令面统一

**`omc install` 新签名（替换既有 line 894 install command）：**
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
.option('-c, --client <client>', 'Target host CLI')
  .choices(['claude', 'codebuddy', 'zcode'])
.option('--workspace [path]', 'Install to <cwd>/.zcode (default) or <path>; only valid with --client zcode')
```

**`omc setup` thin alias（替换既有 line 1304 setup command）：**
```ts
.action(async (options) => {
  const args = ['install'];
  if (options.client) args.push('--client', options.client);
  if (options.workspace) args.push('--workspace');
  if (options.force) args.push('--force');
  if (options.quiet) args.push('--quiet');
  if (options.skipHooks) args.push('--skip-hooks');
  if (options.forceHooks) args.push('--force-hooks');
  if (options.plugin === false) args.push('--no-plugin');
  if (options.pluginDirMode) args.push('--plugin-dir-mode');
  await program.parseAsync([process.argv[0], process.argv[1], ...args]);
});
```

`omc setup` 保留的隐式行为：未带 `--client` 时透传也不带，`omc install` action 内 `detectClient()` 自动选择（保持既有会话检测语义）。

## 5. 接口设计

### 5.1 `resolveZcodePaths`（新文件 `src/utils/zcode-paths.ts`）

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ZcodeInstallScope = 'user' | 'workspace';

export interface ResolvedZcodePaths {
  zcodeDir: string;
  agentsMcpJsonPath: string;
}

export function resolveZcodePaths(
  scope: ZcodeInstallScope,
  workspacePath?: string
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

### 5.2 `setupZcode` 签名扩展（`src/installer/zcode.ts`）

```ts
export interface SetupZcodeOptions {
  scope: 'user' | 'workspace';   // 新增
  zcodeDir: string;
  agentsMcpJsonPath: string;
  packageDir: string;
  hooksWanted: boolean;
  log: (message: string) => void;
}

export function setupZcode(options: SetupZcodeOptions): SetupZcodeResult;
```

既有 10 步流程的**改动点**：
- 第 1 步（mkdir）：scope='workspace' 时额外创建 `<workspacePath>/.omc/` 子目录（顶层，不进 zcodeDir，与 W6 一致）
- 第 5 步（AGENTS.md 写入）：路径 `<zcodeDir>/AGENTS.md`（不变，仅路径来自 caller）
- 第 8 步（mcp config）：使用 `options.agentsMcpJsonPath`（已由 caller 解析）
- 第 10 步（version 标记）：scope='workspace' 时写到 `<workspacePath>/.omc-version.json`（顶层），scope='user' 时写到 `<zcodeDir>/.omc-version.json`

其余步骤：路径均来自 `options.zcodeDir`，行为同构。

### 5.3 `omc install` client dispatch（`src/cli/index.ts`）

```ts
.action(async (options) => {
  const client = options.client ?? detectClient();
  const workspaceArg = options.workspace;

  // E1: --workspace only valid with --client zcode
  if (workspaceArg !== undefined && client !== 'zcode') {
    console.error(chalk.red('--workspace currently only supports --client zcode'));
    process.exit(1);
  }

  // scope 解析
  const scope: 'user' | 'workspace' = workspaceArg !== undefined ? 'workspace' : 'user';
  const workspacePath = workspaceArg === true
    ? join(process.cwd(), '.zcode')
    : workspaceArg;  // string or undefined

  if (client === 'zcode') {
    const { zcodeDir, agentsMcpJsonPath } = resolveZcodePaths(scope, workspacePath);
    const result = setupZcode({
      scope,
      zcodeDir,
      agentsMcpJsonPath,
      packageDir: getRuntimePackageRoot(),
      hooksWanted: !options.skipHooks,
      log: (m) => { if (!options.quiet) console.log(chalk.gray(m)); },
    });
    if (!result.success) {
      console.error(chalk.red(`ZCode ${scope} install failed: ${result.message}`));
      result.errors.forEach((err) => console.error(chalk.red(`  - ${err}`)));
      process.exit(1);
    }
    if (!options.quiet) {
      const target = scope === 'workspace' ? zcodeDir : '~/.zcode';
      console.log(chalk.green(`ZCode ${scope} install complete (${target})!`));
      console.log(chalk.gray(`skills=${result.deployed.skills} commands=${result.deployed.commands} agents=${result.deployed.agents} hooks=${result.deployed.hooks ? 'wired' : 'skipped'}`));
    }
    return;
  }

  // claude / codebuddy 路径：installOmc（既有，不变）
  // ... existing installOmc logic
});
```

### 5.4 `--workspace` 解析

| 输入 | 解析结果 |
|---|---|
| `--workspace` | `cwd/.zcode` |
| `--workspace=.` | `./.zcode`（cwd 下） |
| `--workspace=./myproj` | `./myproj`（整路径，OMC 视为 zcodeDir） |
| `--workspace=/abs/path` | `/abs/path`（绝对路径） |
| 无 `--workspace` | user-level |

## 6. 数据流与状态

### 6.1 10 步同构（scope='workspace' 示例，`<ws>` 表示 workspacePath）

```
$ omc install --client zcode --workspace
        │
        ▼
src/cli/index.ts : install action
        │
        ├─ scope='workspace', workspacePath=cwd/.zcode
        ├─ resolveZcodePaths('workspace', 'cwd/.zcode')
        │     → { zcodeDir: 'cwd/.zcode', agentsMcpJsonPath: 'cwd/.zcode/.agents/mcp.json' }
        │
        ├─ setupZcode({
        │     scope: 'workspace',
        │     zcodeDir: 'cwd/.zcode',
        │     agentsMcpJsonPath: 'cwd/.zcode/.agents/mcp.json',
        │     packageDir, hooksWanted, log
        │  })
        │
        ▼
src/installer/zcode.ts : setupZcode 内部 10 步
  1. mkdir -p cwd/.zcode/{agents,hooks,skills,plans,commands}
     + mkdir -p <workspacePath>/.omc   (top-level, NOT in .zcode/, per W6)
  2. validate preconditions
  3. wire 6 hooks into cwd/.zcode/hooks/ + cwd/.zcode/settings.json
  4. bundle hooks via buildHookScripts
  5. write AGENTS.md → cwd/.zcode/AGENTS.md
  6. sync skills → cwd/.zcode/skills/omc-*
  7. sync agents → cwd/.zcode/agents/*
  8. mergeOmcMcpServer(cwd/.zcode/.agents/mcp.json)
     + warnIfNativeMcpShadowing(cwd/.zcode/config.json)
  9. write settings.json (idempotent merge)
 10. write cwd/.omc-version.json (NOT in .zcode/, per W6)
```

### 6.2 状态文件位置对照

| 文件 | user 级路径 | workspace 级路径 |
|---|---|---|
| `AGENTS.md` | `~/.zcode/AGENTS.md` | `<ws>/.zcode/AGENTS.md` |
| `.omc-version.json` | `~/.zcode/.omc-version.json` | `<ws>/.omc-version.json`（顶层，**不进 .zcode/**） |
| `mcp.json` | `~/.agents/mcp.json` | `<ws>/.zcode/.agents/mcp.json` |
| `settings.json` | `~/.zcode/settings.json` | `<ws>/.zcode/settings.json` |
| `config.json` | `~/.zcode/config.json` | `<ws>/.zcode/config.json` |
| `.omc/` state 子目录 | n/a（用户级无） | `<ws>/.omc/`（顶层，**不进 .zcode/**，与 W6 一致） |

### 6.3 `.omc-version.json` schema 扩展

```json
{
  "version": "<omc-version>",
  "installedAt": "<iso8601>",
  "scope": "user | workspace",
  "workspacePath": "<ws>"        // 仅 scope='workspace' 时存在
}
```

`.omc-version.json` 写入策略：
- user 级：`<ws>` 字段缺省
- workspace 级：必填 `scope='workspace'` 与 `workspacePath=<绝对路径>`
- 用于后续 uninstall / update 定位（v1 不实现 uninstall，但 version 文件作为 ground truth）

## 7. 错误处理

| 类别 | 触发条件 | 处理 |
|---|---|---|
| **E1: 参数冲突** | `--workspace` 与 `--client claude\|codebuddy` 同时存在 | 退出码 1 + stderr：`--workspace currently only supports --client zcode (got --client <name>)` |
| **E2: 路径无效** | `--workspace=PATH` 指向不可写位置 / 已存在但非目录 | 退出码 1 + stderr：列出路径与原因 |
| **E3: 目录创建失败** | mkdir 失败（权限、磁盘已满） | 抛出 `ZcodeSetupError`，保留 10 步中已完成的部分状态（**不自动回滚**，由用户决定） |
| **E4: 已有 OMC workspace install** | 检测到 `<ws>/.omc-version.json` 已存在 | 若 `--force`：覆盖；否则：退出码 1 + 提示用户 `--force` |
| **E5: 现有 config.json 冲突** | `<ws>/.zcode/config.json` 存在但非 JSON / 缺 `enabledPlugins` | 备份原 config.json 到 `<ws>/.zcode/config.json.bak.<timestamp>`，合并 OMC 启用项 |
| **E6: 部分步骤失败** | 10 步中第 N 步失败 | 抛出 `ZcodeSetupError`，记录已完成步骤到 result.steps，保留部分状态 |
| **E7: Hook 安装失败** | 6 个 hook 中任一失败 | 单个 hook 失败不阻断整体；记录到 result.degradedHooks |

错误信息模板：

```
E1: ✗ --workspace currently only supports --client zcode (got --client <name>)
E2: ✗ Workspace path <path> is not a writable directory
E3: ✗ Failed to create <zcodeDir>/<subdir>: <reason>
E4: ✗ OMC is already installed at <ws> (installed <date>, version <ver>).
    Use --force to reinstall.
E5: ⚠ Existing <ws>/.zcode/config.json was non-JSON. Backed up to <ws>/.zcode/config.json.bak.<ts>.
E6: ✗ Setup failed at step <N>: <reason>. Partially completed: <steps-completed>.
E7: ⚠ Hook <name> install failed (<reason>); continuing without it.
```

### 7.1 幂等性

user-level 与 workspace-level install 都是幂等的（多次运行结果一致）：
- 重新运行：检测 `.omc-version.json` → 比对 version → 若相同则 skip；不同则覆盖
- 跳过检测：`--force` 强制全量重装
- hooks 合并：`settings.json` 的 hooks 是数组 merge（去重 by command 路径）
- enabledPlugins merge：保留已有 entries，仅 upsert `oh-my-claudecode@omc`

### 7.2 状态保护

- **不自动回滚**：失败时保留部分状态，方便用户诊断与重试
- **原子性弱保证**：每个文件写入是原子的（write to tmp + rename），但 10 步之间不构成事务
- **备份策略**：仅对 config.json 做 .bak 备份（E5 触发时），其他文件直接覆盖

## 8. 测试策略

### 8.1 测试矩阵

| 类别 | 测试名 | 覆盖目标 |
|---|---|---|
| **T1: 路径解析 unit** | `resolveZcodePaths.test.ts` | 4 种 scope/workspacePath 组合：user+none, user+arg, workspace+none, workspace+arg |
| **T2: setupZcode scope='workspace'** | `zcode-workspace-setup.test.ts` | 10 步同构；产物路径是 `<ws>/.zcode/*` 与 `<ws>/.omc-version.json`（顶层） |
| **T3: CLI install zcode** | `install-client-zcode-option.test.ts` | `omc install --client zcode` 触发 setupZcode（迁移原 setup 测试） |
| **T4: CLI install workspace** | `install-workspace-option.test.ts` | `omc install --client zcode --workspace` 触发 scope='workspace' |
| **T5: CLI install workspace=PATH** | `install-workspace-path-option.test.ts` | `--workspace=绝对路径` 解析为整路径 zcodeDir |
| **T6: CLI install 冲突** | `install-workspace-conflict.test.ts` | `--workspace --client claude` 报错退出 1 |
| **T7: setup alias 回归** | `setup-alias.test.ts` | `omc setup --client zcode` 透传到 install；对老调用方不破坏 |
| **T8: 错误 E1-E7** | 嵌入 T2-T6 的负例 | 错误码、错误信息、退出码 |
| **T9: 幂等性** | `install-zcode-idempotent.test.ts` | 二次运行同结果；带 `--force` 时强制覆盖 |
| **T10: bundle smoke** | `bundle-smoke.test.ts`（既有）扩展 | 3-form：default exit 0 / `--workspace` exit 0 workspace 产物 / 错误情况 exit 1 |
| **T11: mirror-sync** | `test-env-hygiene.mjs`（既有）扩展 | workspace install 不引入新 mirror；既有 6 处 mirror 保持同步 |
| **T12: 端到端 spike** | 手动 | 在 `/Users/lizhouyang/beacon-ontology` 跑 `omc install --client zcode --workspace`，验证 ZCode 实际加载 OMC workspace skills/agents（与 GSD 既有 skills 共存） |

### 8.2 关键断言示例

**T2 (setupZcode scope='workspace')：**
```ts
expect(fs.existsSync(path.join(workspacePath, '.zcode', 'AGENTS.md'))).toBe(true);
expect(fs.existsSync(path.join(workspacePath, '.zcode', 'skills', 'omc-plan'))).toBe(true);
expect(fs.existsSync(path.join(workspacePath, '.omc-version.json'))).toBe(true);
expect(fs.existsSync(path.join(workspacePath, '.zcode', '.omc-version.json'))).toBe(false);
const versionInfo = JSON.parse(fs.readFileSync(path.join(workspacePath, '.omc-version.json'), 'utf8'));
expect(versionInfo.scope).toBe('workspace');
expect(versionInfo.workspacePath).toBe(workspacePath);
```

**T6 (--workspace --client claude 冲突)：**
```ts
const result = runCli(['install', '--client', 'claude', '--workspace']);
expect(result.exitCode).toBe(1);
expect(result.stderr).toContain('--workspace currently only supports --client zcode');
```

**T7 (setup alias 回归)：**
```ts
const result = runCli(['setup', '--client', 'zcode', '--quiet']);
expect(result.exitCode).toBe(0);
// 验证产物路径与 omc install --client zcode 一致（透传语义）
```

### 8.3 接受基线

沿用上一轮验收策略：
- 相对 diff vs clean-tree 失败集
- workspace install 新增测试不引入新的失败文件
- 预计 baseline：37 failed files / 382 failed tests（与上一轮 A/B byte-equal 持平）

## 9. 交付结构

### 9.1 新文件

- `src/utils/zcode-paths.ts`：resolveZcodePaths helper
- `src/utils/__tests__/zcode-paths.test.ts`：T1
- `src/installer/__tests__/zcode-workspace-setup.test.ts`：T2
- `src/cli/__tests__/install-client-zcode-option.test.ts`：T3
- `src/cli/__tests__/install-workspace-option.test.ts`：T4
- `src/cli/__tests__/install-workspace-path-option.test.ts`：T5
- `src/cli/__tests__/install-workspace-conflict.test.ts`：T6
- `src/cli/__tests__/setup-alias.test.ts`：T7
- `src/installer/__tests__/install-zcode-idempotent.test.ts`：T9

### 9.2 改动文件

- `src/cli/index.ts`：`omc install` 加 `--client` / `--workspace` flags + dispatch；`omc setup` 改为透传 alias
- `src/installer/zcode.ts`：setupZcode 接受 `scope` 参数；第 1/10 步分支
- `src/installer/__tests__/zcode-setup.test.ts`：扩展覆盖 `scope='workspace'`（既有 12/12 用例 + 新增）
- `README.md` / `README.zh.md`：新增 "ZCode workspace install" 段落（与 user-level 段落并列）
- `.superpowers/AGENTS.md`（如有项目级）：workspace install 段落

### 9.3 不动文件

- `src/utils/client.ts`：detection 不变
- `src/cli/preload-client-env.ts`：preload 不变
- `bridge/cli.cjs`：CLI flag 变更不影响 bundle（flag 在 runtime 解析）

## 10. 实施序列（高层）

1. `feat/zcode-support` 合入 `feat/codebuddy-support`（`--no-ff`，保留 stacked PR 历史）
2. 新建 `feat/zcode-workspace-support` 分支基于更新后的 `feat/codebuddy-support`
3. 按 8 个任务 TDD 推进（具体任务清单由 writing-plans 阶段产出）
4. T12 真实环境 spike 在 `/Users/lizhouyang/beacon-ontology` 验证 ZCode workspace 共存
5. PR 提交流程：`feat/zcode-workspace-support` → `feat/codebuddy-support`

## 11. 实施期待解决（spike）

- `--workspace=PATH` 接受相对路径时是否规范化为绝对路径（建议：保留用户原样，仅在 `.omc-version.json` 中记录规范化后的绝对路径）
- ZCode 实际从 `<cwd>/.zcode/.agents/mcp.json` 读取 MCP 是否得到官方支持（来自本机 GSD 实例的间接证据；T12 spike 确认）
- 多次重跑（不同 workspacePath）时是否会产生孤立产物（建议：T9 幂等性测试覆盖 `--workspace=A` 后 `--workspace=B` 的清理行为）
