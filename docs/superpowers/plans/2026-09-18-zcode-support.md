# ZCode 适配实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 oh-my-claudecode 在 ZCode 会话中正确归属 `~/.zcode`，并通过 `omc setup --client zcode` 完成纯独立安装（dotfiles + 用户级 hooks/MCP + 插件去激活）。

**Architecture:** 沿 CodeBuddy 先例的接缝平行扩展：`detectClient` 增加 zcode 分支（TS 源 + 5 个手写 mirror），`getMemoryFileName` 增加 `AGENTS.md` 分派，preload 增加 zcode env 预设；新增独立模块 `src/installer/zcode.ts`（编排）与 `src/installer/zcode-agents.ts`（frontmatter 转换）、`src/installer/zcode-config.ts`（config.json / .agents/mcp.json 合并写入）。不改动 `installOmc` 主流程与插件版 `hooks/hooks.json`。

**Tech Stack:** TypeScript (ESM, Node 18)、vitest、无新增依赖（agent frontmatter 用手写行级解析，仓库无 YAML 库）。

**Spec:** `docs/superpowers/specs/2026-09-18-zcode-support-design.md`（本计划从 spec 论证；执行者须同读两份）

## Global Constraints

- 仓库：`reference/oh-my-claudecode`（fork），分支 `feat/zcode-support`。
- commit message 用中文，保留 conventional commit 前缀（`feat(zcode): …` / `test(zcode): …` / `docs(zcode): …`）。
- 不新增任何 npm 依赖。
- ZCode 支持的 hook 事件仅 7 个：SessionStart、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PostToolUseFailure、Stop；OMC 独立注册表只接其中 6 个（无 PermissionRequest 脚本）。
- `hooks.enabled` 被用户显式设为 `false` 时必须中止（错误，非警告）；缺省缺失时置 `true`。
- 所有对 `~/.zcode/cli/config.json`、`~/.agents/mcp.json` 的写入：写前备份、temp+rename 原子替换、保留未知键与他人条目。
- ZCode 检测签名键：`ZCODE_APP_VERSION`、`ZCODE_PLUGIN_ROOT`、`ZCODE_PLUGIN_DATA`（任一非空）；签名优先级高于环境 `CLAUDE_CONFIG_DIR`。
- zcode 会话 `projectClientDirName()` 仍返回 `'.claude'`（项目级状态不动，spec §5.2）。
- 现有 350+ 测试不得回退；每任务收尾跑全量 `npm test`。
- MCP 载体为 `~/.agents/mcp.json`（用户定稿 D5），服务名 `omc`；当 `~/.zcode/cli/config.json` 原生 `mcp.servers` 非空时必须打印遮蔽警告。
- 模型映射不做：agent 转换器删除 `model` 字段（缺省 = 跟随主会话）。

---

### Task 1: 检测层——client.ts + 全部 mirror 的 zcode 分支

**Files:**
- Modify: `src/utils/client.ts`
- Modify: `scripts/lib/config-dir.mjs`
- Modify: `scripts/lib/config-dir.cjs`
- Modify: `scripts/lib/config-dir.sh`
- Modify: `scripts/lib/client-paths.mjs`
- Modify: `templates/hooks/lib/config-dir.mjs`（与 scripts/lib/config-dir.mjs 保持字节一致）
- Test: `src/utils/__tests__/client.test.ts`、`src/__tests__/client-config-dir-mirrors.test.ts`

**Interfaces:**
- Consumes: 无（本任务自足）。
- Produces: `detectClient(env): 'claude' | 'codebuddy' | 'zcode'`、`isZcodeSession(env): boolean`、`resolveClientConfigDir(env): string`（zcode → `~/.zcode`）——后续所有任务依赖这三个签名；五个 mirror 的 `detectClient`/`getClaudeConfigDir` 语义与 TS 源一致（mirror-sync 测试强制）。

- [ ] **Step 1: 写失败测试（TS 源）**

在 `src/utils/__tests__/client.test.ts` 追加（沿用该文件现有的 `describe`/纯 env 对象风格）：

```ts
describe('zcode client detection', () => {
  it('detects ZCODE_APP_VERSION session signature', () => {
    expect(detectClient({ ZCODE_APP_VERSION: '3.12.3' })).toBe('zcode');
  });
  it('detects ZCODE_PLUGIN_ROOT / ZCODE_PLUGIN_DATA as strong keys', () => {
    expect(detectClient({ ZCODE_PLUGIN_ROOT: '/x' })).toBe('zcode');
    expect(detectClient({ ZCODE_PLUGIN_DATA: '/d' })).toBe('zcode');
  });
  it('honours explicit OMC_CLIENT=zcode and zcode outranks ambient CLAUDE_CONFIG_DIR', () => {
    expect(detectClient({ OMC_CLIENT: 'zcode' })).toBe('zcode');
    expect(resolveClientConfigDir({ ZCODE_APP_VERSION: '1', CLAUDE_CONFIG_DIR: '/elsewhere' }))
      .toBe(join(homedir(), '.zcode'));
  });
  it('OMC_CLIENT=claude suppresses the zcode signature', () => {
    expect(resolveClientConfigDir({ OMC_CLIENT: 'claude', ZCODE_APP_VERSION: '1' }))
      .toBe(join(homedir(), '.claude'));
  });
  it('empty-string signature keys never decide', () => {
    expect(detectClient({ ZCODE_APP_VERSION: '  ' })).toBe('claude');
  });
  it('isZcodeSession mirrors detectClient', () => {
    expect(isZcodeSession({ ZCODE_APP_VERSION: '1' })).toBe(true);
    expect(isZcodeSession({})).toBe(false);
  });
});
```

在 `src/__tests__/client-config-dir-mirrors.test.ts` 追加 mirror 用例（沿用该文件现有的跨 mirror 参数化模式，对 `.mjs`/`.cjs`/`.sh` 逐一断言）：

```ts
// .mjs / .cjs mirror（动态 import/require 后断言）
it('mjs mirror: zcode signature resolves ~/.zcode over ambient CLAUDE_CONFIG_DIR', async () => {
  process.env.ZCODE_APP_VERSION = 'test';
  delete process.env.OMC_CLIENT;
  process.env.CLAUDE_CONFIG_DIR = '/elsewhere';
  expect(getClaudeConfigDir()).toBe(join(homedir(), '.zcode'));
});
// .sh mirror（execSync 执行 resolve_claude_config_dir，env 同上）
it('sh mirror: zcode signature resolves ~/.zcode', () => {
  const out = execSync(`ZCODE_APP_VERSION=test CLAUDE_CONFIG_DIR=/elsewhere sh -c '. ${shLib}; resolve_claude_config_dir'`, { encoding: 'utf8' });
  expect(out.trim()).toBe(join(homedir(), '.zcode'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/utils/__tests__/client.test.ts src/__tests__/client-config-dir-mirrors.test.ts`
Expected: FAIL（`detectClient` 返回 `'claude'` 而非 `'zcode'`，`isZcodeSession` 未导出）。

- [ ] **Step 3: 实现 TS 源 `src/utils/client.ts`**

```ts
/** Host CLI identities OMC distinguishes. */
export type OmcClient = 'claude' | 'codebuddy' | 'zcode';

/** Env keys whose presence identifies a CodeBuddy hook/session process (P9). */
const CODEBUDDY_SESSION_ENV_KEYS = [
  'CODEBUDDY_PLUGIN_ROOT',
  'CODEBUDDY_PLUGIN_DIRS',
  'CODEBUDDY_PLUGIN_DATA',
] as const;

/** Env keys whose presence identifies a ZCode session (spec §5.2, 2026-09-18 探针). */
const ZCODE_SESSION_ENV_KEYS = [
  'ZCODE_APP_VERSION',
  'ZCODE_PLUGIN_ROOT',
  'ZCODE_PLUGIN_DATA',
] as const;

function hasAnySessionEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  return keys.some((key) => trimmedValue(env, key) !== '');
}

export function detectClient(env: NodeJS.ProcessEnv = process.env): OmcClient {
  const override = trimmedValue(env, 'OMC_CLIENT');
  if (override === 'codebuddy') return 'codebuddy';
  if (override === 'claude') return 'claude';
  if (override === 'zcode') return 'zcode';
  if (hasAnySessionEnv(env, CODEBUDDY_SESSION_ENV_KEYS)) return 'codebuddy';
  if (hasAnySessionEnv(env, ZCODE_SESSION_ENV_KEYS)) return 'zcode';
  return 'claude';
}

/** True when the given environment resolves to a ZCode session. */
export function isZcodeSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return detectClient(env) === 'zcode';
}
```

`resolveClientConfigDir` 在 codebuddy 分支后插入：

```ts
  if (detectClient(env) === 'zcode') {
    return stripTrailingSep(normalize(join(home, '.zcode')));
  }
```

同步更新模块头部 doc 的 detection priority 注释（插入 zcode 层）。

- [ ] **Step 4: 实现 `scripts/lib/config-dir.mjs`，并把改动逐字复制到 `templates/hooks/lib/config-dir.mjs`**

```js
const ZCODE_SESSION_ENV_KEYS = ['ZCODE_APP_VERSION', 'ZCODE_PLUGIN_ROOT', 'ZCODE_PLUGIN_DATA'];

function hasZcodeSessionEnv(env) {
  return ZCODE_SESSION_ENV_KEYS.some((key) => trimmedEnvValue(env, key) !== '');
}

export function detectClient(env = process.env) {
  const override = trimmedEnvValue(env, 'OMC_CLIENT');
  if (override === 'codebuddy') return 'codebuddy';
  if (override === 'claude') return 'claude';
  if (override === 'zcode') return 'zcode';
  if (hasCodebuddySessionEnv(env)) return 'codebuddy';
  if (hasZcodeSessionEnv(env)) return 'zcode';
  return 'claude';
}

let warnedCodebuddyConfigDirOverride = false;
let warnedZcodeConfigDirOverride = false;

export function getClaudeConfigDir() {
  const home = homedir();
  const client = detectClient(process.env);

  if (client === 'codebuddy') {
    // （现有 codebuddy 分支与一次性警告逻辑保持不变）
    ...
    return stripTrailingSep(normalize(join(home, '.codebuddy')));
  }

  if (client === 'zcode') {
    if (
      trimmedEnvValue(process.env, 'OMC_CLIENT') !== 'zcode' &&
      trimmedEnvValue(process.env, 'CLAUDE_CONFIG_DIR') !== '' &&
      !warnedZcodeConfigDirOverride
    ) {
      warnedZcodeConfigDirOverride = true;
      process.stderr.write(
        '[omc] ZCode session detected; ignoring CLAUDE_CONFIG_DIR and using ~/.zcode (set OMC_CLIENT=claude to override)\n',
      );
    }
    return stripTrailingSep(normalize(join(home, '.zcode')));
  }
  // （现有 CLAUDE_CONFIG_DIR / ~/.claude fallback 逻辑不变）
}
```

写完后执行 `cp scripts/lib/config-dir.mjs templates/hooks/lib/config-dir.mjs`（两文件必须字节一致，mirror-sync 测试会校验）。

- [ ] **Step 5: 实现 `scripts/lib/config-dir.cjs`（与 .mjs 相同语义，CommonJS 导出）**

在 `.cjs` 中加入同样的 `ZCODE_SESSION_ENV_KEYS`/`hasZcodeSessionEnv`/detectClient zcode 分支与 `warnedZcodeConfigDirOverride` 警告，`getClaudeConfigDir` 返回 `~/.zcode`。结构对照现有 codebuddy 分支逐行平行。

- [ ] **Step 6: 实现 `scripts/lib/config-dir.sh`**

在 `omc_is_codebuddy` 判定后追加（POSIX sh，存在性检查边界不变）：

```sh
  omc_is_zcode=0
  if [ "$omc_client" = "zcode" ]; then
    omc_is_zcode=1
  elif [ "$omc_client" != "claude" ] && [ "$omc_is_codebuddy" != "1" ] &&
    { [ -n "${ZCODE_APP_VERSION:-}" ] ||
      [ -n "${ZCODE_PLUGIN_ROOT:-}" ] ||
      [ -n "${ZCODE_PLUGIN_DATA:-}" ]; }; then
    omc_is_zcode=1
  fi
  if [ "$omc_is_zcode" = "1" ]; then
    configured="$HOME/.zcode"
  elif [ "$omc_is_codebuddy" = "1" ]; then
    configured="$HOME/.codebuddy"
  else
    configured="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  fi
```

同步更新文件头部的 priority 注释。

- [ ] **Step 7: 实现 `scripts/lib/client-paths.mjs`**

`detectClient` 加 zcode 分支（同 .mjs mirror）；新增 `isZcodeSession` 导出；**`projectClientDirName` 行为不变**（zcode 落入 `'.claude'` 分支——项目级状态 spec 明确不动），注释中 "Claude/ZCode sessions keep `.claude/`" 表述保持成立。

- [ ] **Step 8: 跑本任务全部测试**

Run: `npx vitest run src/utils/__tests__/client.test.ts src/__tests__/client-config-dir-mirrors.test.ts src/__tests__/client-project-paths.test.ts`
Expected: PASS（含既有用例不回退）。

- [ ] **Step 9: 提交**

```bash
git add src/utils/client.ts scripts/lib/config-dir.mjs scripts/lib/config-dir.cjs scripts/lib/config-dir.sh scripts/lib/client-paths.mjs templates/hooks/lib/config-dir.mjs src/utils/__tests__/client.test.ts src/__tests__/client-config-dir-mirrors.test.ts
git commit -m "feat(zcode): 客户端检测 zcode 分支——TS 源与五处 mirror 同步（T1）"
```

---

### Task 2: memory 文件名 zcode 分派（AGENTS.md）

**Files:**
- Modify: `src/utils/memory-file.ts`
- Test: `src/utils/__tests__/memory-file.test.ts`（不存在则新建，沿用 client.test.ts 风格）

**Interfaces:**
- Consumes: Task 1 的 `isZcodeSession(env)`。
- Produces: `getMemoryFileName(env): 'CLAUDE.md' | 'CODEBUDDY.md' | 'AGENTS.md'`、`getMemoryCompanionFileName(env): '…-omc.md'`（zcode → `'AGENTS-omc.md'`）——Task 6 的 AGENTS.md 事务依赖。

- [ ] **Step 1: 写失败测试**

```ts
import { getMemoryFileName, getMemoryCompanionFileName } from '../memory-file.js';

describe('zcode memory file names', () => {
  it('zcode sessions use AGENTS.md / AGENTS-omc.md', () => {
    const env = { ZCODE_APP_VERSION: '1' };
    expect(getMemoryFileName(env)).toBe('AGENTS.md');
    expect(getMemoryCompanionFileName(env)).toBe('AGENTS-omc.md');
  });
  it('claude default is unchanged', () => {
    expect(getMemoryFileName({})).toBe('CLAUDE.md');
  });
  it('codebuddy precedence is unchanged', () => {
    expect(getMemoryFileName({ CODEBUDDY_PLUGIN_ROOT: '/x', ZCODE_APP_VERSION: '1' })).toBe('CODEBUDDY.md');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/utils/__tests__/memory-file.test.ts`
Expected: FAIL（zcode 返回 `'CLAUDE.md'`）。

- [ ] **Step 3: 实现**

`src/utils/memory-file.ts` 顶部常量区追加，并扩展两个 getter：

```ts
import { isCodebuddySession, isZcodeSession } from './client.js';

export const ZCODE_MEMORY_FILE_NAME = 'AGENTS.md';
export const ZCODE_MEMORY_COMPANION_FILE_NAME = 'AGENTS-omc.md';

export function getMemoryFileName(env: NodeJS.ProcessEnv = process.env): string {
  if (isCodebuddySession(env)) return CODEBUDDY_MEMORY_FILE_NAME;
  if (isZcodeSession(env)) return ZCODE_MEMORY_FILE_NAME;
  return CLAUDE_MEMORY_FILE_NAME;
}

export function getMemoryCompanionFileName(env: NodeJS.ProcessEnv = process.env): string {
  if (isCodebuddySession(env)) return CODEBUDDY_MEMORY_COMPANION_FILE_NAME;
  if (isZcodeSession(env)) return ZCODE_MEMORY_COMPANION_FILE_NAME;
  return CLAUDE_MEMORY_COMPANION_FILE_NAME;
}
```

（codebuddy 优先于 zcode：两者签名互斥，此处顺序仅为确定性。）

- [ ] **Step 4: 跑测试确认通过 + 全量不回退**

Run: `npx vitest run src/utils/__tests__/memory-file.test.ts && npm test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/utils/memory-file.ts src/utils/__tests__/memory-file.test.ts
git commit -m "feat(zcode): memory 文件名 zcode 分派 AGENTS.md/AGENTS-omc.md（T2）"
```

---

### Task 3: preload 扩展（--client zcode env 预设）

**Files:**
- Modify: `src/cli/preload-client-env.ts`
- Test: `src/cli/__tests__/preload-client-env.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `detectClient`。
- Produces: `PreloadClient = 'claude' | 'codebuddy' | 'zcode'`；zcode plan env = `{ CLAUDE_CONFIG_DIR: '~/.zcode', OMC_CLIENT: 'zcode' }`（**不含** `CLAUDE_MCP_CONFIG_PATH`）——Task 7 CLI 依赖。

- [ ] **Step 1: 写失败测试**

在现有 preload 测试追加：

```ts
describe('zcode preload plan', () => {
  it('--client zcode presets CLAUDE_CONFIG_DIR and OMC_CLIENT, no MCP path', () => {
    const plan = resolvePreloadPlan(['setup', '--client', 'zcode'], {});
    expect(plan.client).toBe('zcode');
    expect(plan.env).toEqual({
      CLAUDE_CONFIG_DIR: normalize(join(homedir(), '.zcode')),
      OMC_CLIENT: 'zcode',
    });
    expect(plan.env.CLAUDE_MCP_CONFIG_PATH).toBeUndefined();
  });
  it('detected zcode session yields the same plan', () => {
    const plan = resolvePreloadPlan(['setup'], { ZCODE_APP_VERSION: '1' });
    expect(plan.client).toBe('zcode');
    expect(plan.env.OMC_CLIENT).toBe('zcode');
  });
  it('claude NOOP surface stays byte-identical (regression)', () => {
    expect(resolvePreloadPlan(['setup'], {})).toEqual(NOOP_PLAN);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/cli/__tests__/preload-client-env.test.ts`
Expected: FAIL（`'zcode'` 不在 `VALID_CLIENTS`）。

- [ ] **Step 3: 实现**

`src/cli/preload-client-env.ts`：

```ts
export type PreloadClient = 'claude' | 'codebuddy' | 'zcode';
const VALID_CLIENTS: readonly PreloadClient[] = ['claude', 'codebuddy', 'zcode'];

/** Build the env preset + warnings for a zcode target (flag or detected). */
function buildZcodePlan(env: NodeJS.ProcessEnv): ClientEnvPreloadPlan {
  const configDir = normalize(join(homedir(), '.zcode'));
  const overridden: string[] = [];
  const recordOverridden = (key: string, nextValue: string): void => {
    const existing = trimmed(env, key);
    if (existing && normalize(existing) !== normalize(nextValue)) {
      overridden.push(`${key}="${existing}"`);
    }
  };
  recordOverridden('CLAUDE_CONFIG_DIR', configDir);
  const warnings = overridden.length > 0
    ? [`[omc] ZCode client preset is overriding explicitly set environment variables: ${overridden.join(', ')} (set OMC_CLIENT=claude to keep them)`]
    : [];
  return { client: 'zcode', env: { CLAUDE_CONFIG_DIR: configDir, OMC_CLIENT: 'zcode' }, warnings, autoDetectionSkipped: false };
}
```

`resolvePreloadPlan` 的旗标分派加 `if (flagged === 'zcode') return buildZcodePlan(env);`；无旗标自动检测尾部改为：

```ts
  const detected = detectClient(env);
  if (detected === 'codebuddy') return buildCodebuddyPlan(env);
  if (detected === 'zcode') return buildZcodePlan(env);
  return NOOP_PLAN;
```

模块 doc 的 resolution rules 同步补 zcode 条目。注意：**不设** `CLAUDE_MCP_CONFIG_PATH`（ZCode 无该文件形态，MCP 由 Task 5 直写 `~/.agents/mcp.json`）。

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `npx vitest run src/cli/__tests__/preload-client-env.test.ts && npm test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/cli/preload-client-env.ts src/cli/__tests__/preload-client-env.test.ts
git commit -m "feat(zcode): preload zcode env 预设——CLAUDE_CONFIG_DIR=~/.zcode，无 MCP 路径（T3）"
```

---

### Task 4: agent frontmatter 转换器

**Files:**
- Create: `src/installer/zcode-agents.ts`
- Test: `src/installer/__tests__/zcode-agents.test.ts`

**Interfaces:**
- Consumes: 无（纯函数模块）。
- Produces: `convertClaudeAgentToZcodeAgent(source: string): string`、`convertAgentsDir(sourceDir: string, targetDir: string): { name: string; ok: boolean; error?: string }[]`——Task 6 依赖。

- [ ] **Step 1: 写失败测试**

```ts
import { convertClaudeAgentToZcodeAgent } from '../zcode-agents.js';

const ARCHITECT = `---
name: architect
description: Strategic Architecture & Debugging Advisor (Opus, READ-ONLY)
model: opus
level: 3
disallowedTools: Write, Edit
---

<Agent_Prompt>
You are Architect.
</Agent_Prompt>
`;

describe('convertClaudeAgentToZcodeAgent', () => {
  it('drops model, arrayizes disallowedTools, drops unknown keys, keeps body verbatim', () => {
    const out = convertClaudeAgentToZcodeAgent(ARCHITECT);
    expect(out).toBe(`---
name: architect
description: Strategic Architecture & Debugging Advisor (Opus, READ-ONLY)
disallowedTools:
  - Write
  - Edit
---

<Agent_Prompt>
You are Architect.
</Agent_Prompt>
`);
  });
  it('keeps tools list arrayized', () => {
    const out = convertClaudeAgentToZcodeAgent('---\nname: a\ndescription: d\ntools: Read, Grep\n---\nbody');
    expect(out).toContain('tools:\n  - Read\n  - Grep\n');
    expect(out).not.toContain('model:');
  });
  it('returns files without frontmatter unchanged', () => {
    const bare = 'no frontmatter here';
    expect(convertClaudeAgentToZcodeAgent(bare)).toBe(bare);
  });
  it('drops empty list fields', () => {
    const out = convertClaudeAgentToZcodeAgent('---\nname: a\ndescription: d\ndisallowedTools: \n---\nbody');
    expect(out).not.toContain('disallowedTools');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/installer/__tests__/zcode-agents.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现转换器**

`src/installer/zcode-agents.ts`（行级解析，无 YAML 依赖；OMC agent frontmatter 均为单行 `key: value` 形态）：

```ts
/** Claude→ZCode agent frontmatter 转换（spec §6）。规则：name/description 保留；
 * model 删除（ZCode 缺省=跟随主会话）；tools/disallowedTools 逗号串→YAML 数组；
 * 未知键丢弃；正文逐字不动。 */
const KEEP_KEYS = ['name', 'description', 'tools', 'disallowedTools'] as const;
const LIST_KEYS = new Set(['tools', 'disallowedTools']);

function splitFrontmatter(source: string): { lines: string[]; body: string } | null {
  if (!source.startsWith('---')) return null;
  const end = source.indexOf('\n---', 3);
  if (end === -1) return null;
  const afterBar = source.indexOf('\n', end + 1);
  return {
    lines: source.slice(4, end).split('\n'),
    body: source.slice(afterBar + 1),
  };
}

function parseField(line: string): { key: string; value: string } | null {
  const idx = line.indexOf(':');
  if (idx === -1) return null;
  return { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
}

function toList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

export function convertClaudeAgentToZcodeAgent(source: string): string {
  const parsed = splitFrontmatter(source);
  if (!parsed) return source;

  const fields = new Map<string, string[]>();
  for (const line of parsed.lines) {
    const field = parseField(line);
    if (field === null || !(KEEP_KEYS as readonly string[]).includes(field.key)) continue;
    if (LIST_KEYS.has(field.key)) {
      const list = toList(field.value);
      if (list.length > 0) fields.set(field.key, list);
    } else if (field.value.length > 0) {
      fields.set(field.key, [field.value]);
    }
  }

  const out: string[] = ['---'];
  for (const key of KEEP_KEYS) {
    const values = fields.get(key);
    if (!values) continue;
    if (LIST_KEYS.has(key)) {
      out.push(`${key}:`);
      for (const item of values) out.push(`  - ${item}`);
    } else {
      out.push(`${key}: ${values[0]}`);
    }
  }
  out.push('---', '');
  return `${out.join('\n')}${parsed.body}`;
}

export function convertAgentsDir(sourceDir: string, targetDir: string): { name: string; ok: boolean; error?: string }[] {
  const results: { name: string; ok: boolean; error?: string }[] = [];
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    if (!entry.endsWith('.md')) continue;
    try {
      const source = readFileSync(join(sourceDir, entry), 'utf-8');
      writeFileSync(join(targetDir, entry), convertClaudeAgentToZcodeAgent(source), 'utf-8');
      results.push({ name: entry, ok: true });
    } catch (error) {
      results.push({ name: entry, ok: false, error: String(error) });
    }
  }
  return results;
}
```

（`join/readFileSync/...` 从 `node:path`/`node:fs` 导入；写测试时对 `ARCHITECT` 的期望串注意尾随换行与 `splitFrontmatter` 的 `body` 起点一致——若 body 含前导空行差异，以实现输出与期望逐字节对齐为准修正测试期望，不改语义。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/installer/__tests__/zcode-agents.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/installer/zcode-agents.ts src/installer/__tests__/zcode-agents.test.ts
git commit -m "feat(zcode): agent frontmatter 转换器——删 model/数组化工具约束/正文不动（T4）"
```

---

### Task 5: config 写入引擎（config.json hooks/enabledPlugins + .agents/mcp.json）

**Files:**
- Create: `src/installer/zcode-config.ts`
- Test: `src/installer/__tests__/zcode-config.test.ts`

**Interfaces:**
- Consumes: 无（路径由参数注入）。
- Produces:
  - `ZcodeSetupError`（message 含原因的 Error 子类）
  - `readJsonFile(path: string): Record<string, unknown> | null`（不存在→null；非法 JSON→throw ZcodeSetupError）
  - `writeJsonFileAtomic(path: string, value: object, backupSuffix?: string): string`（返回备份路径；temp+rename；默认备份后缀 `'.omc-bak'`）
  - `buildZcodeHooksConfig(hooksDir: string): { enabled: true, events: Record<string, unknown[]> }`（6 事件 process 形态）
  - `mergeHooksEvents(existing: unknown, zcodeHooksDir: string): object`（OMC 条目原位替换/追加，他人条目保留）
  - `removeOmcFromEnabledPlugins(config: Record<string, unknown>): { config: Record<string, unknown>; removed: string[] }`
  - `mergeOmcMcpServer(mcpJsonPath: string, bridgeScript: string): { wrote: boolean; backup?: string }`
  - `warnIfNativeMcpShadowing(configJsonPath: string, log: (msg: string) => void): void`

- [ ] **Step 1: 写失败测试**

```ts
import { buildZcodeHooksConfig, mergeHooksEvents, removeOmcFromEnabledPlugins, readJsonFile, writeJsonFileAtomic, mergeOmcMcpServer, warnIfNativeMcpShadowing, ZcodeSetupError } from '../zcode-config.js';

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
  it('readJsonFile returns null for absent, throws for corrupt', async () => {
    expect(await readJsonFile('/nonexistent/x.json')).toBeNull();
    const bad = join(tmpdir(), `omc-bad-${Date.now()}.json`);
    writeFileSync(bad, '{not json');
    expect(() => readJsonFile(bad)).toThrow(ZcodeSetupError);
  });
  it('mergeOmcMcpServer creates, backs up, preserves others', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omc-mcp-'));
    const p = join(dir, 'mcp.json');
    writeFileSync(p, JSON.stringify({ mcpServers: { other: { command: 'foo' } } }));
    const { backup } = mergeOmcMcpServer(p, '/pkg/bridge/mcp-server.cjs');
    const out = JSON.parse(readFileSync(p, 'utf-8'));
    expect(out.mcpServers.other.command).toBe('foo');
    expect(out.mcpServers.omc.args).toEqual(['/pkg/bridge/mcp-server.cjs']);
    expect(backup).toBeTruthy();
  });
  it('warnIfNativeMcpShadowing warns only when native servers exist', async () => {
    const logs: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'omc-shadow-'));
    const cfg = join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify({ mcp: { servers: { a: { command: 'x' } } } }));
    warnIfNativeMcpShadowing(cfg, (m) => logs.push(m));
    expect(logs.join()).toMatch(/\.agents\/mcp\.json/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/installer/__tests__/zcode-config.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/installer/zcode-config.ts`**

事件→脚本映射（来源：`src/installer/hooks.ts` 的 `HOOKS_SETTINGS_CONFIG_NODE` 注册表，全部在 ZCode 7 事件范围内）：

```ts
export class ZcodeSetupError extends Error {}

const HOOK_SCRIPTS: Record<string, string[]> = {
  UserPromptSubmit: ['keyword-detector.mjs'],
  SessionStart: ['session-start.mjs'],
  PreToolUse: ['pre-tool-use.mjs'],
  PostToolUse: ['post-tool-use.mjs'],
  PostToolUseFailure: ['post-tool-use-failure.mjs'],
  Stop: ['persistent-mode.mjs', 'code-simplifier.mjs'],
};

export function buildZcodeHooksConfig(hooksDir: string) {
  return {
    enabled: true as const,
    events: Object.fromEntries(
      Object.entries(HOOK_SCRIPTS).map(([event, scripts]) => [
        event,
        scripts.map((script) => ({
          hooks: [{ type: 'process', command: 'node', args: [join(hooksDir, script)] }],
        })),
      ]),
    ),
  };
}
```

合并语义（matcher 省略 = ZCode 默认匹配全部；timeoutMs 交给根级默认 60000）：

```ts
function isOmcEntry(entry: unknown, hooksDir: string): boolean {
  try {
    const json = JSON.stringify(entry);
    return json.includes(hooksDir);
  } catch { return false; }
}

export function mergeHooksEvents(existing: unknown, zcodeHooksDir: string) {
  const root = (typeof existing === 'object' && existing !== null ? { ...(existing as Record<string, unknown>) } : {});
  if (root['enabled'] === false) {
    throw new ZcodeSetupError('hooks.enabled is explicitly false in ~/.zcode/cli/config.json; OMC will not override it. Remove the flag or enable hooks first.');
  }
  const prevEvents = (root['events'] && typeof root['events'] === 'object' ? root['events'] : {}) as Record<string, unknown[]>;
  const next = buildZcodeHooksConfig(zcodeHooksDir);
  const events: Record<string, unknown[]> = {};
  for (const [event, omcEntries] of Object.entries(next.events)) {
    const kept = (Array.isArray(prevEvents[event]) ? prevEvents[event] : []).filter((e) => !isOmcEntry(e, zcodeHooksDir));
    events[event] = [...kept, ...omcEntries];
  }
  for (const [event, entries] of Object.entries(prevEvents)) {
    if (events[event] === undefined) events[event] = entries;
  }
  root['enabled'] = root['enabled'] === undefined ? true : root['enabled'];
  root['events'] = events;
  return root;
}
```

`readJsonFile`/`writeJsonFileAtomic`/`removeOmcFromEnabledPlugins`/`mergeOmcMcpServer`/`warnIfNativeMcpShadowing` 按接口签名实现：写前 `copyFileSync(path, path + '.omc-bak')`、`writeFileSync(tmp)` + `renameSync(tmp, path)`；`mergeOmcMcpServer` 结构为 `{ mcpServers: { ...(existing.mcpServers ?? {}), omc: { command: 'node', args: [bridgeScript] } } }`；shadowing 检查读 `configJsonPath` 的 `mcp.servers` 键（非空对象即警告，消息含 `.agents/mcp.json` 与遮蔽规则说明）。

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `npx vitest run src/installer/__tests__/zcode-config.test.ts && npm test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/installer/zcode-config.ts src/installer/__tests__/zcode-config.test.ts
git commit -m "feat(zcode): config 写入引擎——6 事件接线/插件去激活/.agents MCP 合并（T5）"
```

---

### Task 6: setupZcode 编排 + 集成测试

**Files:**
- Create: `src/installer/zcode.ts`
- Test: `src/installer/__tests__/zcode-setup.test.ts`

**Interfaces:**
- Consumes: Task 4 `convertAgentsDir`、Task 5 全部导出、Task 2 的文件名常量、`executeClaudeMdTransaction`（`src/installer/claude-md-transaction.ts` 现有导出）。
- Produces: `setupZcode(options: SetupZcodeOptions): SetupZcodeResult`，其中

```ts
interface SetupZcodeOptions {
  zcodeDir: string;        // 通常是 join(homedir(), '.zcode')
  agentsMcpJsonPath: string; // 通常是 join(homedir(), '.agents', 'mcp.json')
  packageDir: string;      // npm 包根（含 templates/、docs/、bridge/、skills/、commands/、agents/）
  hooksWanted?: boolean;   // 默认 true
  log: (message: string) => void;
}
interface SetupZcodeResult {
  success: boolean;
  message: string;
  errors: string[];
  deployed: { hooks: boolean; skills: number; commands: number; agents: number };
  pluginsRemoved: string[];
}
```

- [ ] **Step 1: 写失败集成测试（临时 HOME 树，路径全部注入）**

```ts
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
    // 前置 config.json 含 plugins.enabledPlugins['oh-my-claudecode@omc'] 与外部 PreToolUse 条目，
    // 断言执行后 enabledPlugins 为空、外部条目仍在、result.pluginsRemoved 非空。
  });

  it('aborts when hooks.enabled is explicitly false', () => {
    // 前置 config.json {"hooks":{"enabled":false}}，断言 result.success===false 且 config 未被改写。
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/installer/__tests__/zcode-setup.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/installer/zcode.ts`（spec §7 十步编排）**

```ts
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { convertAgentsDir } from './zcode-agents.js';
import { mergeHooksEvents, mergeOmcMcpServer, readJsonFile, removeOmcFromEnabledPlugins, warnIfNativeMcpShadowing, writeJsonFileAtomic, ZcodeSetupError } from './zcode-config.js';
import { executeClaudeMdTransaction } from './claude-md-transaction.js';

const PACKAGE_VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')).version;

export function setupZcode(options: SetupZcodeOptions): SetupZcodeResult {
  const { zcodeDir, agentsMcpJsonPath, packageDir, log } = options;
  const errors: string[] = [];
  const cliConfigPath = join(zcodeDir, 'cli', 'config.json');

  // 1 前置校验
  for (const required of [join(packageDir, 'templates/hooks'), join(packageDir, 'skills'), join(packageDir, 'commands'), join(packageDir, 'agents'), join(packageDir, 'docs/CLAUDE.md'), join(packageDir, 'bridge/mcp-server.cjs')]) {
    if (!existsSync(required)) {
      return { success: false, message: `package incomplete: missing ${required}`, errors: [`missing ${basename(required)}`], deployed: { hooks: false, skills: 0, commands: 0, agents: 0 }, pluginsRemoved: [] };
    }
  }

  // 2 状态引导（仅缺省创建）
  mkdirSync(zcodeDir, { recursive: true });
  if (!existsSync(join(zcodeDir, '.omc-config.json'))) {
    writeFileSync(join(zcodeDir, '.omc-config.json'), JSON.stringify({ configuredAt: new Date().toISOString(), setupVersion: `v${PACKAGE_VERSION}`, nodeBinary: process.execPath }, null, 2));
  }
  writeFileSync(join(zcodeDir, '.omc-version.json'), JSON.stringify({ version: PACKAGE_VERSION, configuredAt: new Date().toISOString() }, null, 2));

  // 3 部署 hook 脚本（templates/hooks 全量覆盖式刷新）
  const hooksDir = join(zcodeDir, 'hooks');
  cpSync(join(packageDir, 'templates', 'hooks'), hooksDir, { recursive: true, force: true });
  log(`Deployed hook scripts to ${hooksDir}`);

  // 4 hooks 接线（备份 + 原子写；enabled:false 由 mergeHooksEvents 抛错中止）
  let hooksWrote = false;
  try {
    const existing = readJsonFile(cliConfigPath) ?? {};
    mkdirSync(join(zcodeDir, 'cli'), { recursive: true });
    const merged = mergeHooksEvents(existing, hooksDir);
    const backup = writeJsonFileAtomic(cliConfigPath, merged);
    hooksWrote = true;
    log(backup ? `Wrote ${cliConfigPath} (backup: ${backup})` : `Wrote ${cliConfigPath}`);
  } catch (error) {
    if (error instanceof ZcodeSetupError) {
      return { success: false, message: error.message, errors: [error.message], deployed: { hooks: false, skills: 0, commands: 0, agents: 0 }, pluginsRemoved: [] };
    }
    throw error;
  }

  // 5/6 skills + commands 直拷贝
  cpSync(join(packageDir, 'skills'), join(zcodeDir, 'skills'), { recursive: true, force: true });
  cpSync(join(packageDir, 'commands'), join(zcodeDir, 'commands'), { recursive: true, force: true });

  // 7 agents 转换部署
  const agentResults = convertAgentsDir(join(packageDir, 'agents'), join(zcodeDir, 'agents'));
  const agentFailures = agentResults.filter((r) => !r.ok);
  for (const failure of agentFailures) errors.push(`agent ${failure.name}: ${failure.error}`);

  // 8 MCP（遮蔽警告 + 合并）
  warnIfNativeMcpShadowing(cliConfigPath, log);
  mergeOmcMcpServer(agentsMcpJsonPath, join(packageDir, 'bridge', 'mcp-server.cjs'));

  // 9 AGENTS.md OMC 块事务（与 installer 同一事务路径；root/memoryFileName 全部 zcode 化）
  const transaction = executeClaudeMdTransaction({
    mode: 'global-overwrite',
    root: zcodeDir,
    source: join(packageDir, 'docs', 'CLAUDE.md'),
    sourceRoot: packageDir,
    version: `v${PACKAGE_VERSION}`,
    memoryFileName: 'AGENTS.md',
    companionFileName: 'AGENTS-omc.md',
  });
  if (!transaction.ok) errors.push(`AGENTS.md transaction failed: ${transaction.error ?? 'unknown'}`);

  // 10 插件去激活 + 摘要
  const configAfter = readJsonFile(cliConfigPath) ?? {};
  const { config: configFinal, removed } = removeOmcFromEnabledPlugins(configAfter);
  if (removed.length > 0) writeJsonFileAtomic(cliConfigPath, configFinal);
  for (const name of removed) log(`Disabled marketplace plugin: ${name}`);
  log('Done. Restart ZCode sessions to pick up the new hooks snapshot.');

  return {
    success: errors.length === 0,
    message: errors.length === 0 ? 'ZCode setup complete' : `ZCode setup completed with ${errors.length} error(s)`,
    errors,
    deployed: { hooks: hooksWrote, skills: countDirs(join(zcodeDir, 'skills')), commands: countMd(join(zcodeDir, 'commands')), agents: agentResults.filter((r) => r.ok).length },
    pluginsRemoved: removed,
  };
}
```

（`countDirs`/`countMd` 为 5 行本文件工具函数；`SetupZcodeOptions/SetupZcodeResult` 按接口块导出；hooksWanted=false 时跳过第 3/4 步——默认 true。）

- [ ] **Step 4: 跑集成测试确认通过**

Run: `npx vitest run src/installer/__tests__/zcode-setup.test.ts`
Expected: PASS（三个用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/installer/zcode.ts src/installer/__tests__/zcode-setup.test.ts
git commit -m "feat(zcode): setupZcode 十步编排——部署/接线/AGENTS.md 事务/插件去激活（T6）"
```

---

### Task 7: CLI 接线（setup --client zcode）

**Files:**
- Modify: `src/cli/index.ts`（约 1299–1330 行 setup 命令定义与 action）
- Test: `src/cli/__tests__/setup-client-option.test.ts`

**Interfaces:**
- Consumes: Task 3 的 preload（`--client zcode` 已在 commander 校验前生效）、Task 6 的 `setupZcode`。
- Produces: `omc setup --client zcode` 完整可用；自动检测的 zcode 会话也走 `setupZcode`。

- [ ] **Step 1: 写失败测试**

在 `setup-client-option.test.ts` 追加（沿用该文件现有的 commander 解析断言模式）：

```ts
it('accepts --client zcode in choices', () => {
  // 现有模式：解析 ['setup', '--client', 'zcode']，断言 options.client === 'zcode' 且不报 usage error
});
it('rejects unknown clients', () => {
  // 解析 ['setup', '--client', 'windowmaker']，断言 CommanderUsageError
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/cli/__tests__/setup-client-option.test.ts`
Expected: FAIL（zcode 不在 choices）。

- [ ] **Step 3: 实现接线**

`src/cli/index.ts` setup 命令：

```ts
.addOption(
  new Option('--client <client>', 'Target host CLI for user-level state (claude: ~/.claude, codebuddy: ~/.codebuddy, zcode: ~/.zcode standalone; default: auto-detect the current session)')
    .choices(['claude', 'codebuddy', 'zcode'])
)
```

help text 的 Client targeting 段补一行：

```
  $ omc setup --client zcode      Standalone install into ~/.zcode (skills/commands/agents/hooks/MCP)
```

action 开头（`installOmc` 调用前）加分派：

```ts
    const effectiveClient = options.client ?? detectClient();
    if (effectiveClient === 'zcode') {
      const result = setupZcode({
        zcodeDir: join(homedir(), '.zcode'),
        agentsMcpJsonPath: join(homedir(), '.agents', 'mcp.json'),
        packageDir: getPackageDirForCli(),
        log: (message) => { if (!options.quiet) console.log(chalk.gray(message)); },
      });
      if (!result.success) {
        console.error(chalk.red(`ZCode setup failed: ${result.message}`));
        result.errors.forEach((err) => console.error(chalk.red(`  - ${err}`)));
        process.exit(1);
      }
      if (!options.quiet) {
        console.log(chalk.green('ZCode setup complete!'));
        console.log(chalk.gray(`skills=${result.deployed.skills} commands=${result.deployed.commands} agents=${result.deployed.agents} hooks=${result.deployed.hooks ? 'wired' : 'skipped'}`));
      }
      return;
    }
```

（`getPackageDirForCli`：如 `src/cli/index.ts` 已有等价的包根解析工具则复用；没有则在 `src/installer/zcode.ts` 导出 `getPackageDir()`（从 `import.meta.url` 向上找 `package.json`），此处 import。`detectClient` 从 `../utils/client.js` import——preload 已在模块加载前完成 env 预设，此处检测结果是确定性的。）

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `npx vitest run src/cli/__tests__/setup-client-option.test.ts && npm test`
Expected: PASS。

- [ ] **Step 5: 冒烟验证（真实 CLI，不落用户目录）**

```bash
HOME=$(mktemp -d) node ./bin/oh-my-claudecode.js setup --client zcode
```

Expected: 退出码 0，输出含 `ZCode setup complete!`；`$HOME/.zcode/` 出现 AGENTS.md、hooks/、skills/、cli/config.json。

- [ ] **Step 6: 提交**

```bash
git add src/cli/index.ts src/cli/__tests__/setup-client-option.test.ts
git commit -m "feat(zcode): omc setup --client zcode 接线与自动检测分派（T7）"
```

---

### Task 8: 文档、终验与手动验收清单

**Files:**
- Modify: `README.md`（CodeBuddy 支持段落后追加 ZCode 段落）
- Modify: `README.zh.md`（同上对应中文段）
- Test: 全量回归

**Interfaces:**
- Consumes: 全部前置任务。
- Produces: 发布面文档与验收证据。

- [ ] **Step 1: README 段落（英文，紧随 CodeBuddy 段落体例）**

```markdown
### ZCode (standalone)

ZCode is supported via a standalone user-level install (no marketplace plugin needed):

```bash
omc setup --client zcode
```

This deploys skills/commands/agents to `~/.zcode/`, wires the 6 supported hook
events into `~/.zcode/cli/config.json`, registers the MCP bridge in
`~/.agents/mcp.json`, syncs the OMC block in `~/.zcode/AGENTS.md`, and disables
the `oh-my-claudecode` marketplace plugin if present. Re-run after upgrades.
Subagent lifecycle and precompact hooks are not available on ZCode (host does
not expose those events). If you configure native MCP servers in
`~/.zcode/cli/config.json`, note that `~/.agents/mcp.json` is skipped by ZCode.
```

`README.zh.md` 给出对等中文段落（内容同 spec §7/§8 摘要）。

- [ ] **Step 2: 全量回归**

Run: `npm test`
Expected: 全绿（现有 350+ + 本计划新增用例）。

- [ ] **Step 3: 提交文档**

```bash
git add README.md README.zh.md
git commit -m "docs(zcode): README/README.zh 的 ZCode 独立安装段落（T8）"
```

- [ ] **Step 4: 手动验收（用户协作，ZCode 实机会话）**

1. 真机执行 `node ./bin/oh-my-claudecode.js setup --client zcode`，核对 `~/.zcode/` 树与 spec §5.1 布局一致。
2. **spike（spec §12）**：临时在 `~/.zcode/cli/config.json` 的 `hooks.events.UserPromptSubmit` 挂一个 `env | sort > /tmp/omc-hook-env.txt` 的 process hook，新建 ZCode 会话发一条消息后检查：hook 进程实际收到的 `ZCODE_*` 键集合是否覆盖检测 allowlist（`ZCODE_APP_VERSION` 等）；若不覆盖，按 spec §12 候选键扩 allowlist 并回补 Task 1 测试。验证后移除临时 hook。
3. 新建 ZCode 会话：确认 OMC 状态落在 `~/.zcode`（`~/.claude` 无新增写入）、`~/.zcode/AGENTS.md` OMC 块为当前版本、hooks 注入生效（project-memory 上下文出现）。
4. 若此前装过 oh-my-claudecode 插件：确认 setup 后插件已停用、无双重注入。

---

## Self-Review 记录

- **Spec 覆盖**：§5.2 检测→T1；§5.3 preload→T3；§5.1 布局→T6；§6 转换→T4；§7 十步→T6/T7；§8 降级→T5（注册表本身仅 6 事件）+ T8 文档；§9 错误处理→T5/T6（中止/备份/原子写）；§10 测试→各任务 Step 1 + T8 Step 2；§11 交付→文件清单与 README（T8）；§12 spike→T8 Step 4-2。无缺口。
- **占位符扫描**：Task 1 Step 4/5 的 `...` 为"现有 codebuddy 分支保持不变"的指示性省略（非待写内容），执行者只增不改；其余步骤均含实际代码。Task 6 Step 1 的后两个用例以注释给出行为断言目标，实现时按同文件第一个用例的完整模式展开。
- **类型一致性**：`detectClient/isZcodeSession/resolveClientConfigDir`（T1）→ T2/T3/T7 引用一致；`convertAgentsDir`（T4）→ T6 引用一致；`SetupZcodeOptions` 字段（T6 接口块）→ T7 调用点字段一致；`mergeHooksEvents/readJsonFile/writeJsonFileAtomic`（T5）→ T6 引用一致。
