# ZCode 适配设计（oh-my-claudecode）

- 日期：2026-09-18
- 状态：已经用户逐节确认，待实施
- 分支：`feat/zcode-support`（基于 `feat/codebuddy-support`）
- 参照：ZCode 官方文档（plugin / subagents / hooks / mcp-services）、`open-gsd/gsd-core` 的 declarative zcode capability、本仓库 CodeBuddy 适配先例（T2–T7）

## 1. 背景与动机

OMC fork（ooptsd/oh-my-claudecode）已支持 `claude | codebuddy` 两个客户端。ZCode（Z.ai 桌面端）会话中 OMC 目前处于"能跑但归错位"状态，本机实证：

- **状态归属错误**：ZCode 只注入 `ZCODE_*` 环境变量，`detectClient` 无 zcode 分支，运行时全部 fallback 到 `~/.claude`（本机 `.omc-config.json` 停留在 npm 时代 v5.0.0）。
- **用户级指令漂移**：ZCode 读 `~/.zcode/AGENTS.md`，installer 从不服务它；本机该文件 OMC 块为 5.0.0，插件为 5.4.0。
- **Hooks 事件缺口**：OMC hooks.json 注册 11 个事件，ZCode 仅支持 7 个（SessionStart、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PostToolUseFailure、Stop）。
- **Agent frontmatter 不兼容**：`model: opus` 在 GLM 模型空间无效；`disallowedTools: Write, Edit` 逗号串在 ZCode 下未生效——architect 的 READ-ONLY 约束实际失效。

分发面不是问题：ZCode 插件系统兼容 `.claude-plugin/plugin.json`，marketplace 已打通。问题全部在运行时归属与安装/配置面。

## 2. 目标与非目标

### 目标

1. `detectClient` 新增 zcode 分支，OMC 运行时状态归属 `~/.zcode`，与 `~/.claude` 彻底隔离。
2. `omc setup --client zcode`：纯独立安装路线（不走插件市场），全量落地用户级产物。
3. `~/.zcode/AGENTS.md` OMC 块版本化同步。
4. 用户级 hooks 只接线 ZCode 支持的 7 事件（事件降级）。
5. Agent frontmatter 转换，恢复 `disallowedTools` 约束效力。

### 非目标（明确不做）

- GLM 模型空间映射（agent `model` 字段删除 → 跟随主会话；映射受 provider 配置限制，只能做语义建议）。
- HUD / statusLine 降级方案（ZCode 无 statusLine，HUD 在 zcode 会话自然休眠）。
- auto-update 的 zcode 适配（升级路径 = 重跑 setup）。
- 卸载子命令。
- 项目级 hooks（ZCode 当前版本整体忽略 `config_project_hooks_ignored`）。
- 实际向上游提交 PR（仅保证代码组织可上游化）。

## 3. 实证基础（2026-09-18 探针与官方文档）

| 事实 | 来源 |
|---|---|
| ZCode 会话向子进程注入 `ZCODE_*` 变量（`ZCODE_APP_VERSION` 等）；插件 hook 进程另有 `ZCODE_PLUGIN_ROOT/ZCODE_PLUGIN_DATA/ZCODE_PLUGIN_ID` | 本机 `env` 探针 + hooks 官方文档 |
| 插件清单兼容 `.claude-plugin/plugin.json`；hooks 从标准位置 `hooks/hooks.json` 自动发现 | plugin 官方文档 + 本机插件缓存实证 |
| 用户级 hooks：`~/.zcode/cli/config.json` → `hooks.events`，需 `hooks.enabled: true`；插件与用户 hooks 共存且都执行（user → plugin 顺序）；未知事件名 → 可恢复失败 + 诊断日志，不崩 | hooks 官方文档 |
| `type: "process"`（argv，不经 shell）为推荐形式；`timeoutMs`（毫秒）优先于兼容字段 `timeout`（秒） | hooks 官方文档 |
| 用户级 MCP：`~/.zcode/cli/config.json` → `mcp.servers`（原生）；`~/.agents/mcp.json` → `mcpServers`（业界兼容，兜底）；**同作用域内 `.zcode` 原生有任一服务时 `.agents` 文件整体跳过不合并** | mcp-services 官方文档 |
| 子代理定义：`~/.zcode/agents/<name>.md` 用户级；frontmatter camelCase；`model` 缺省 = 跟随主会话；`tools/disallowedTools` 自定义后仅内置工具生效 | subagents 官方文档 |
| 用户级 skills/commands：`~/.zcode/skills/<name>/SKILL.md`、`~/.zcode/commands/*.md`；命令文件名须匹配 `^[a-z0-9][a-z0-9_:-]{0,63}$`；skill description ≤1024 字符 | plugin 官方文档 + gsd-core capability |
| gsd-core 将 ZCode 建模为 declarative capability：`configHome ~/.zcode`（env `ZCODE_CONFIG_DIR`）、agents 转换器 `convertClaudeAgentToZcodeAgent`、dotfiles 安装面 | open-gsd/gsd-core 仓库 |
| Claude standalone 先例：hook 脚本从 `templates/hooks/` **复制**到 `<configDir>/hooks/`，命令写 `node <configDir>/hooks/<name>.mjs` | 本仓库 `src/installer/hooks.ts` |

## 4. 决策记录

| # | 决策 | 选择 | 关键理由 |
|---|---|---|---|
| D1 | 适配深度 | 对齐 CodeBuddy 模式 | 有先例可循、风险可控；模型映射/HUD/全套 parity 明确排除 |
| D2 | 状态归属 | `~/.zcode` 根目录 | 与 `~/.claude`、`~/.codebuddy` 同构；AGENTS.md 恰在该层，installer 仅需文件名参数化 |
| D3 | 安装路线 | **纯独立安装**（不走插件） | setup 全量落地用户级；从 `plugins.enabledPlugins` 移除 oh-my-claudecode，杜绝插件+用户级双源 |
| D4 | 部署拓扑 | A：镜像 claude standalone | 仓库先例（`buildHookCommand` 模式）；升级 = 重跑 setup，与 claude 侧行为一致 |
| D5 | MCP 载体 | `~/.agents/mcp.json`（用户定稿，覆盖推荐项） | 业界通用文件；两个风险内建缓解（见 §7 第 8 步） |
| D6 | 交付 | fork 新分支，代码组织保守可上游 | 沿 codebuddy 接缝平行扩展，不引入 fork 特有耦合 |

## 5. 架构

### 5.1 目录布局（configDir = `~/.zcode`，与 claude 同构）

```
~/.zcode/
├── AGENTS.md              ← OMC 块（OMC:START/END 标记事务管理）
├── .omc-config.json       ← OMC 状态（仅缺省时创建）
├── .omc-version.json      ← setup 版本戳（升级检测依据）
├── hooks/                 ← templates/hooks/ 部署副本（含 lib/ config-dir mirror）
├── skills/<name>/SKILL.md ← 直拷贝（frontmatter 已兼容）
├── commands/*.md          ← 直拷贝（文件名已合规）
└── agents/<name>.md       ← 转换后部署（§6）

~/.zcode/cli/config.json   ← 合并：hooks.events（7 事件）+ plugins.enabledPlugins 移除
~/.agents/mcp.json         ← 合并：mcpServers.omc
<npm 包目录>/bridge/mcp-server.cjs ← MCP 引用包路径（bridge 为单打包产物，claude 侧同模式）
```

### 5.2 客户端检测（`src/utils/client.ts` + 5 个 mirror）

优先级（高 → 低）：

1. `OMC_CLIENT=zcode|claude|codebuddy` 显式覆盖（枚举扩展）
2. CodeBuddy 会话签名（现有，不动）
3. **ZCode 会话签名（新增）**：`ZCODE_APP_VERSION` / `ZCODE_PLUGIN_ROOT` / `ZCODE_PLUGIN_DATA` 任一非空 → zcode
4. 环境变量 `CLAUDE_CONFIG_DIR`（现有）
5. fallback `~/.claude`（现有）

语义对齐 CodeBuddy 先例：

- ZCode 签名**优先于**环境中已导出的 `CLAUDE_CONFIG_DIR`（状态隔离 P2），非 `OMC_CLIENT` 显式指定时发一次性 stderr 警告。
- ZCode 与 CodeBuddy 签名键集合互斥，检测顺序无行为依赖。
- `getClaudeConfigDir()` 对 zcode 返回 `~/.zcode`（strip 尾分隔符，同现有实现）。

Mirror 同步面（6 处，扩展既有 mirror-sync 测试强制一致）：`src/utils/client.ts`、`scripts/lib/config-dir.mjs`、`scripts/lib/config-dir.cjs`、`scripts/lib/config-dir.sh`、`scripts/lib/client-paths.mjs`、`templates/hooks/lib/config-dir.mjs`。

### 5.3 preload 扩展（`src/cli/preload-client-env.ts`）

- `PreloadClient` union 扩展 `'zcode'`。
- `--client zcode`（flag 或会话检测）→ 预设 `CLAUDE_CONFIG_DIR=~/.zcode`、`OMC_CLIENT=zcode`，覆盖告警逻辑复用。
- **不设** `CLAUDE_MCP_CONFIG_PATH`：claude/codebuddy 的 `.mcp.json` 文件约定在 ZCode 不存在，MCP 由 setup 直写 `~/.agents/mcp.json`。

## 6. Agent frontmatter 转换规则（`src/installer/zcode-agents.ts`）

| 字段 | 处理 | 理由 |
|---|---|---|
| `name` / `description` | 原样保留 | ZCode 必填；description 驱动自动调度 |
| `model` | **删除** | 模型映射不在范围；缺省 = 跟随主会话；留 `opus` 有诊断/误路由风险。description 中 "(Opus)" 属正文性质保留 |
| `disallowedTools` | 逗号串 → YAML 数组 | 修复 READ-ONLY 约束在 ZCode 失效 |
| `tools` | 有则数组化；无则不写 | 缺省 = 继承全部 |
| 未知键（`level` 等） | 丢弃 | ZCode 静默忽略；干净产物利于上游审查 |
| 正文 | 逐字不动 | — |

产出 19 个 agent 到 `~/.zcode/agents/`。

## 7. `omc setup --client zcode` 安装流（幂等，重跑即升级）

1. **前置校验**：包目录存在、node 可执行。
2. **状态引导**：`~/.zcode/.omc-config.json`（仅缺省创建）+ `.omc-version.json`（记 setupVersion/configuredAt）。
3. **部署 hook 脚本**：`templates/hooks/*.mjs` + `lib/` → `~/.zcode/hooks/`（覆盖式刷新）。
4. **写用户级 hooks** 进 `~/.zcode/cli/config.json`：
   - 只接线 7 个支持事件；hook 集来自 `installer/hooks.ts` 的 claude standalone 注册表，过滤 `SubagentStart/SubagentStop/PreCompact/SessionEnd`；
   - `type: "process"` argv 形式（`node ~/.zcode/hooks/<x>.mjs`），超时换算 `timeoutMs`；
   - 合并语义：保留用户既有条目；OMC 旧条目（args 指向 `~/.zcode/hooks` 可识别）原位替换；写前备份；temp+rename 原子替换；
   - `hooks.enabled` 显式 `false` → 中止提示（用户意图不翻转）；缺省缺失 → 置 `true`。
5. **部署 skills**：`~/.zcode/skills/` 直拷贝；description >1024 字符告警。
6. **部署 commands**：`~/.zcode/commands/` 直拷贝。
7. **部署 agents**：§6 转换后写入 `~/.zcode/agents/`。
8. **MCP**：合并 `mcpServers.omc`（`node <packageDir>/bridge/mcp-server.cjs`）进 `~/.agents/mcp.json`；已存在则解析合并保留他人条目、写前备份、非法 JSON 中止；若 `~/.zcode/cli/config.json` 原生 `mcp.servers` 非空 → 打印遮蔽警告（`.agents` 兜底文件在该状态下被 ZCode 整体跳过，OMC MCP 可能不生效）。
9. **AGENTS.md 同步**：`~/.zcode/AGENTS.md` OMC 块按标记替换为当前版本（复用 `claude-md-transaction` 事务逻辑，目标文件名参数化为 `AGENTS.md`）。
10. **插件去激活 + 摘要**：`plugins.enabledPlugins` 移除 `oh-my-claudecode@*`；输出安装摘要与"新建 ZCode 会话生效"提示（hooks 配置为每会话快照）。

## 8. Hooks 事件降级

- 4 个 ZCode 缺失事件仅从**独立安装接线**中省略；脚本照常部署（无害），插件路径共享 `hooks.json` 一字不动。
- 功能损失如实声明：子代理生命周期注入、压缩前状态保存在 ZCode 无对应生命周期点，无法弥补。
- 已知问题（留给上游）：插件模式共享 hooks.json 在 ZCode 下对 4 个事件产生"可恢复失败"诊断噪音。

## 9. 错误处理

- `~/.zcode/cli/config.json` / `~/.agents/mcp.json` 非法 JSON → 中止不写，输出备份路径。
- `hooks.enabled` 显式 `false` → 中止提示。
- 部分失败安全：每步幂等；config.json 原子替换；备份命名对齐 claude 侧事务逻辑既有做法。
- 检测/写入全程不产生静默降级：每个跳过/覆盖决策都有 stdout 摘要行。

## 10. 测试策略（vitest，对齐 CodeBuddy T2–T6 粒度）

- **检测层**：zcode 分支在 TS 源 + 5 mirror 逐一断言；扩展 mirror-sync 测试强制 6 处一致；签名优先级（含压过环境 `CLAUDE_CONFIG_DIR`）用例。
- **preload**：zcode flag/检测 → env 预设；不设 `CLAUDE_MCP_CONFIG_PATH`；claude 路径字节不变（NOOP 面回归）。
- **转换器**：样例 agent → 期望 frontmatter（model 删除、数组化、未知键丢弃、正文逐字不变）。
- **hooks/MCP/AGENTS.md 写入**：7 事件映射、用户条目保留、OMC 条目原位替换、`enabled:false` 中止、备份生成、他人服务保留、非法 JSON 中止、遮蔽警告触发。
- **集成**：临时 HOME 全流程 → 产物树断言、幂等重跑、`enabledPlugins` 移除、插件缺失时步骤 10 降级为提示。
- **验收**：`npm test` 全绿（现有 350+ 不回退）。

## 11. 交付结构与上游化

- 新文件：`src/installer/zcode.ts`（setup 流）、`src/installer/zcode-agents.ts`（转换器）+ 各自 `__tests__`。
- 改动点（沿 codebuddy 接缝平行扩展）：`src/utils/client.ts`（union + 分支）、5 个 mirror、`src/cli/preload-client-env.ts`、setup 命令 `--client` choices、mirror-sync 测试、README/README.zh 的 ZCode 支持段落（简短，对齐 CodeBuddy 段落体例）。
- 上游路径说明：zcode 分支依赖的 client-detection 架构与 codebuddy 同源；向上游提交时两者可分别或合并成"multi-client detection"PR。

## 12. 实施期待解决（spike）

- **hook 进程 env 签名实证**：临时 hook dump env，确认独立安装（用户级 hook，非插件 hook）进程实际收到的 `ZCODE_*` 键集合；若 `ZCODE_APP_VERSION` 不可达则扩 allowlist（候选 `ZCODE_ENV`/`ZCODE_PROCESS_LABEL`，弱信号需组合判定）。
- claude standalone hook 注册表与 7 事件的逐项映射表（实施计划中枚举）。
- `hooks/` 部署文件全集清单（templates/hooks 现有文件 vs claude standalone 实际复制集）。
