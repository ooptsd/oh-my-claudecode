/** ZCode 配置写入引擎（T5）：~/.zcode/cli/config.json 的 hooks 接线与 enabledPlugins 去激活、
 * ~/.agents/mcp.json 的 OMC 桥接合并、原生 mcp.servers 遮蔽告警。
 * 路径全部由参数注入，模块加载期不做任何 IO。写入 = tmp 文件 + renameSync 原子替换，
 * 写前 copyFileSync 固定后缀单份备份。事件→脚本映射与 src/installer/hooks.ts 的
 * HOOKS_SETTINGS_CONFIG_NODE 注册表对齐，但独立维护（hooks.ts 模块加载时读模板文件，不可 import）。 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** ZCode 配置安装过程中的可预期失败（文件损坏、用户显式禁用 hooks 等），message 含具体原因。 */
export class ZcodeSetupError extends Error {}

/** 事件→脚本映射（来源：src/installer/hooks.ts 的 HOOKS_SETTINGS_CONFIG_NODE 注册表，全部在 ZCode 事件范围内）。 */
const HOOK_SCRIPTS: Record<string, string[]> = {
  UserPromptSubmit: ['keyword-detector.mjs'],
  SessionStart: ['session-start.mjs'],
  PreToolUse: ['pre-tool-use.mjs'],
  PostToolUse: ['post-tool-use.mjs'],
  PostToolUseFailure: ['post-tool-use-failure.mjs'],
  Stop: ['persistent-mode.mjs', 'code-simplifier.mjs'],
};

type HookInvocation = { type: string; command: string; args: string[] };
type HookEntry = { hooks: HookInvocation[] };

/** 构造 ZCode hooks 接线（6 事件 process 形态；matcher 省略 = ZCode 默认匹配全部；timeoutMs 交给根级默认 60000）。 */
export function buildZcodeHooksConfig(hooksDir: string): { enabled: true; events: Record<string, HookEntry[]> } {
  return {
    enabled: true,
    events: Object.fromEntries(
      Object.entries(HOOK_SCRIPTS).map(([event, scripts]): [string, HookEntry[]] => [
        event,
        scripts.map(
          (script): HookEntry => ({
            hooks: [{ type: 'process', command: 'node', args: [join(hooksDir, script)] }],
          }),
        ),
      ]),
    ),
  };
}

export type ZcodeHooksRoot = Record<string, unknown> & { events: Record<string, unknown[]> };

function isOmcEntry(entry: unknown, hooksDir: string): boolean {
  try {
    const json = JSON.stringify(entry);
    return json.includes(hooksDir);
  } catch {
    return false;
  }
}

/** 把 OMC hooks 条目合并进既有 config 根对象：他人条目保留在前，OMC 条目按 zcodeHooksDir 路径识别并
 * 原位替换（重跑不叠加）；非 OMC 事件的既有事件键整体保留；enabled 仅在 undefined 时置 true，
 * 显式 false 抛 ZcodeSetupError（不覆盖用户选择）。不改入参。 */
export function mergeHooksEvents(existing: unknown, zcodeHooksDir: string): ZcodeHooksRoot {
  const root: Record<string, unknown> = typeof existing === 'object' && existing !== null ? { ...(existing as Record<string, unknown>) } : {};
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
  return root as ZcodeHooksRoot;
}

/** 同步读取 JSON 文件：不存在返回 null；非法 JSON 或顶层非对象抛 ZcodeSetupError。 */
export function readJsonFile(path: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ZcodeSetupError(`Invalid JSON in ${path}: ${String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ZcodeSetupError(`${path} must contain a JSON object at top level`);
  }
  return parsed as Record<string, unknown>;
}

/** 原子写入 JSON：目标目录不存在时递归创建；写前把旧文件复制为固定后缀（默认 '.omc-bak'）单份备份；
 * 先写同目录 tmp 文件再 renameSync。返回备份路径，目标原本不存在（无可备份）时返回空串。 */
export function writeJsonFileAtomic(path: string, value: object, backupSuffix: string = '.omc-bak'): string {
  mkdirSync(dirname(path), { recursive: true });
  let backup = '';
  if (existsSync(path)) {
    backup = `${path}${backupSuffix}`;
    copyFileSync(path, backup);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  renameSync(tmp, path);
  return backup;
}

/** 便于消费方直接取 config.plugins.enabledPlugins（plugins 运行时可能缺席，类型上声明为必有以收敛调用侧判空）。 */
export type ZcodeConfigWithPlugins = Record<string, unknown> & { plugins: { enabledPlugins?: Record<string, unknown> } };

/** 从 config.json 的 enabledPlugins 中移除 oh-my-claudecode@* 条目（插件由插件机制托管，不经 config.json 激活），
 * 其余键与其他顶层配置原样保留；plugins/enabledPlugins 缺失时为 no-op。不改入参。 */
export function removeOmcFromEnabledPlugins(config: Record<string, unknown>): { config: ZcodeConfigWithPlugins; removed: string[] } {
  const next = { ...config } as ZcodeConfigWithPlugins;
  const removed: string[] = [];
  const plugins = next.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return { config: next, removed };
  const source = plugins as Record<string, unknown>;
  const enabled = source.enabledPlugins;
  if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) return { config: next, removed };
  const nextEnabled = { ...(enabled as Record<string, unknown>) };
  for (const key of Object.keys(nextEnabled)) {
    if (key.startsWith('oh-my-claudecode@')) {
      delete nextEnabled[key];
      removed.push(key);
    }
  }
  if (removed.length > 0) {
    next.plugins = { ...source, enabledPlugins: nextEnabled };
  }
  return { config: next, removed };
}

/** 把 OMC MCP 桥接服务器合并进 ~/.agents/mcp.json：
 * 结构 { mcpServers: { ...既有条目, omc: { command: 'node', args: [bridgeScript] } } }，他人条目原样保留；
 * omc 条目已一致时不重写（幂等，wrote=false）。返回是否实际写入与备份路径。 */
export function mergeOmcMcpServer(mcpJsonPath: string, bridgeScript: string): { wrote: boolean; backup?: string } {
  const existing = readJsonFile(mcpJsonPath) ?? {};
  const serversRaw = existing['mcpServers'];
  const servers = (serversRaw && typeof serversRaw === 'object' && !Array.isArray(serversRaw) ? serversRaw : {}) as Record<string, unknown>;
  const omc = { command: 'node', args: [bridgeScript] };
  if (JSON.stringify(servers['omc']) === JSON.stringify(omc)) return { wrote: false };
  const backup = writeJsonFileAtomic(mcpJsonPath, { mcpServers: { ...servers, omc } });
  return { wrote: true, backup: backup || undefined };
}

/** config.json 里存在原生 mcp.servers（非空对象）时告警：ZCode 原生条目优先，
 * ~/.agents/mcp.json 兜底（OMC 桥接服务器）在原生服务器存在期间被跳过。 */
export function warnIfNativeMcpShadowing(configJsonPath: string, log: (msg: string) => void): void {
  const config = readJsonFile(configJsonPath);
  if (!config) return;
  const mcp = config['mcp'];
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return;
  const servers = (mcp as Record<string, unknown>)['servers'];
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return;
  if (Object.keys(servers as Record<string, unknown>).length === 0) return;
  log(`Native mcp.servers entries found in ${configJsonPath}; ZCode gives native entries precedence, so the ~/.agents/mcp.json fallback (OMC bridge server) is skipped while native servers exist.`);
}
