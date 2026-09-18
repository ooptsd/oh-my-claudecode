/** ZCode 安装编排（spec §7 十步）：前置校验 → 状态引导 → hook 脚本部署 → config.json hooks 接线 →
 * skills/commands 直拷贝 → agents frontmatter 转换 → ~/.agents/mcp.json 合并 → AGENTS.md OMC 块事务 →
 * enabledPlugins 去激活 → 摘要。路径全部由参数注入（packageDir = npm 包根），模块加载期只读包版本。
 * 可预期失败（包不完整、hooks.enabled 显式 false、agent 单文件失败、AGENTS.md 事务失败）不抛出：
 * 前两者短路返回 success:false，后两者计入 errors。 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { convertAgentsDir } from './zcode-agents.js';
import { ZcodeHooksRoot, mergeHooksEvents, mergeOmcMcpServer, readJsonFile, removeOmcFromEnabledPlugins, warnIfNativeMcpShadowing, writeJsonFileAtomic, ZcodeSetupError } from './zcode-config.js';
import { executeClaudeMdTransaction } from './claude-md-transaction.js';
import { ZCODE_MEMORY_COMPANION_FILE_NAME, ZCODE_MEMORY_FILE_NAME } from '../utils/memory-file.js';

const PACKAGE_VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')).version;

export interface SetupZcodeOptions {
  zcodeDir: string; // 通常是 join(homedir(), '.zcode')
  agentsMcpJsonPath: string; // 通常是 join(homedir(), '.agents', 'mcp.json')
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
  if (!existsSync(join(zcodeDir, '.omc-config.json'))) {
    writeFileSync(join(zcodeDir, '.omc-config.json'), JSON.stringify({ configuredAt: new Date().toISOString(), setupVersion: `v${PACKAGE_VERSION}`, nodeBinary: process.execPath }, null, 2));
  }
  writeFileSync(join(zcodeDir, '.omc-version.json'), JSON.stringify({ version: PACKAGE_VERSION, configuredAt: new Date().toISOString() }, null, 2));

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
    memoryFileName: ZCODE_MEMORY_FILE_NAME,
    companionFileName: ZCODE_MEMORY_COMPANION_FILE_NAME,
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
