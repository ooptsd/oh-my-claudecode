/** ZCode 安装编排（spec §7 十步）：前置校验 → 状态引导 → hook 脚本部署 → config.json hooks 接线 →
 * skills/commands 直拷贝 → agents frontmatter 转换 → ~/.agents/mcp.json 合并 → AGENTS.md OMC 块事务 →
 * enabledPlugins 去激活 → 摘要。路径全部由参数注入（packageDir = npm 包根），模块加载期只读包版本。
 * 可预期失败（包不完整、hooks.enabled 显式 false、agent 单文件失败、JSON 配置损坏、AGENTS.md 事务失败）不抛出：
 * 前两者短路返回 success:false，其余计入 errors。 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertAgentsDir } from './zcode-agents.js';
import { ZcodeHooksRoot, mergeHooksEvents, mergeOmcMcpServer, readJsonFile, removeOmcFromEnabledPlugins, warnIfNativeMcpShadowing, writeJsonFileAtomic, ZcodeSetupError } from './zcode-config.js';
import { executeClaudeMdTransaction } from './claude-md-transaction.js';
import { ZCODE_MEMORY_COMPANION_FILE_NAME, ZCODE_MEMORY_FILE_NAME } from '../utils/memory-file.js';

/** 包根解析：从本模块位置向上找 package.json（src/installer、dist/installer 上两级；
 * esbuild CJS 束 import.meta.url 被 shim 到 bridge/cli.cjs，上一级即包根）。
 * 相对 URL 字面量（new URL('../../package.json', import.meta.url)）在 CJS 束里会解析到包外。 */
function resolvePackageRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(moduleDir, '..'), join(moduleDir, '..', '..'), join(moduleDir, '..', '..', '..')];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return moduleDir;
}

const PACKAGE_VERSION: string = JSON.parse(readFileSync(join(resolvePackageRoot(), 'package.json'), 'utf-8')).version;

export interface SetupZcodeOptions {
  scope: 'user' | 'workspace'; // user=现有默认行为（~/.zcode）；workspace=项目级（<workspacePath>/.zcode）
  zcodeDir: string; // 通常是 join(homedir(), '.zcode') 或 join(workspacePath, '.zcode')
  agentsMcpJsonPath: string; // 通常是 join(homedir(), '.agents', 'mcp.json') 或 <zcodeDir>/.agents/mcp.json
  workspacePath?: string; // 仅 scope='workspace' 时使用；用于第 1/10 步定位 .omc/ 与 .omc-version.json（顶层，不进 zcodeDir）
  packageDir: string; // npm 包根（含 templates/、docs/、bridge/、skills/、commands/、agents/）
  hooksWanted?: boolean; // 默认 true
  log: (message: string) => void;
}

export interface SetupZcodeResult {
  success: boolean;
  message: string;
  errors: string[];
  deployed: { hooks: boolean; skills: number; commands: number; agents: number };
  pluginsRemoved: string[];
}

function countDirs(dir: string): number {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length; } catch { return 0; }
}
function countMd(dir: string): number {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).length; } catch { return 0; }
}

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
  // workspace scope: 顶层 .omc/ state 子目录（spec W6；不进 zcodeDir）
  if (options.scope === 'workspace' && options.workspacePath) {
    mkdirSync(join(options.workspacePath, '.omc'), { recursive: true });
  }
  if (!existsSync(join(zcodeDir, '.omc-config.json'))) {
    writeFileSync(join(zcodeDir, '.omc-config.json'), JSON.stringify({ configuredAt: new Date().toISOString(), setupVersion: `v${PACKAGE_VERSION}`, nodeBinary: process.execPath }, null, 2));
  }
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

  // 3 部署 hook 脚本（templates/hooks 全量覆盖式刷新）
  // 4 hooks 接线（备份 + 原子写；enabled:false 由 mergeHooksEvents 抛错中止）
  let hooksWrote = false;
  if (options.hooksWanted !== false) {
    const hooksDir = join(zcodeDir, 'hooks');
    cpSync(join(packageDir, 'templates', 'hooks'), hooksDir, { recursive: true, force: true });
    log(`Deployed hook scripts to ${hooksDir}`);
    try {
      const existing = readJsonFile(cliConfigPath) ?? {};
      mkdirSync(join(zcodeDir, 'cli'), { recursive: true });
      const hooksSectionRaw = existing['hooks'];
      const hooksSection = hooksSectionRaw !== null && typeof hooksSectionRaw === 'object' && !Array.isArray(hooksSectionRaw) ? hooksSectionRaw as Record<string, unknown> : {};
      const merged: ZcodeHooksRoot = mergeHooksEvents(hooksSection, hooksDir);
      const backup = writeJsonFileAtomic(cliConfigPath, { ...existing, hooks: merged });
      hooksWrote = true;
      log(backup ? `Wrote ${cliConfigPath} (backup: ${backup})` : `Wrote ${cliConfigPath}`);
    } catch (error) {
      if (error instanceof ZcodeSetupError) {
        return { success: false, message: error.message, errors: [error.message], deployed: { hooks: false, skills: 0, commands: 0, agents: 0 }, pluginsRemoved: [] };
      }
      throw error;
    }
  }

  // 5/6 skills + commands 直拷贝
  cpSync(join(packageDir, 'skills'), join(zcodeDir, 'skills'), { recursive: true, force: true });
  cpSync(join(packageDir, 'commands'), join(zcodeDir, 'commands'), { recursive: true, force: true });

  // 7 agents 转换部署
  const agentResults = convertAgentsDir(join(packageDir, 'agents'), join(zcodeDir, 'agents'));
  const agentFailures = agentResults.filter((r) => !r.ok);
  for (const failure of agentFailures) errors.push(`agent ${failure.name}: ${failure.error}`);

  // 8 MCP（遮蔽警告 + 合并）：config.json 或 ~/.agents/mcp.json 损坏时计入 errors 后继续
  // （对齐第 7 步 agent 失败计入模式），不穿透 setupZcode 直达 CLI；两调用相互独立，分别兜底。
  try {
    warnIfNativeMcpShadowing(cliConfigPath, log);
  } catch (error) {
    if (error instanceof ZcodeSetupError) errors.push(error.message);
    else throw error;
  }
  try {
    mergeOmcMcpServer(agentsMcpJsonPath, join(packageDir, 'bridge', 'mcp-server.cjs'));
  } catch (error) {
    if (error instanceof ZcodeSetupError) errors.push(error.message);
    else throw error;
  }

  // 9 AGENTS.md OMC 块事务（与 installer 同一事务路径；root/memoryFileName 全部 zcode 化）
  const transaction = executeClaudeMdTransaction({
    mode: 'global-overwrite',
    root: zcodeDir,
    source: join(packageDir, 'docs', 'CLAUDE.md'),
    sourceRoot: packageDir,
    version: `v${PACKAGE_VERSION}`,
    memoryFileName: ZCODE_MEMORY_FILE_NAME,
    companionFileName: ZCODE_MEMORY_COMPANION_FILE_NAME,
  });
  if (!transaction.ok) errors.push(`AGENTS.md transaction failed: ${transaction.error ?? 'unknown'}`);

  // 10 插件去激活 + 摘要（config.json 损坏已在第 8 步计入 errors，这里按空配置跳过去激活）
  let configAfter: Record<string, unknown> = {};
  try {
    configAfter = readJsonFile(cliConfigPath) ?? {};
  } catch (error) {
    if (!(error instanceof ZcodeSetupError)) throw error;
  }
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
