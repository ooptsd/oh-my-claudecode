/**
 * 路径派生单一来源 (T1 of workspace-level zcode install plan).
 *
 * setupZcode (T2)、CLI dispatch (T3-T6) 都消费此 helper，避免散落的路径字面量。
 */

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
    if (workspacePath !== undefined) {
      // v1: 不规范化路径，原样追加 .agents/mcp.json（与 spec W5 一致；path.join 会吃掉 "./"）
      return {
        zcodeDir: workspacePath,
        agentsMcpJsonPath: `${workspacePath}/.agents/mcp.json`,
      };
    }
    const zcodeDir = join(process.cwd(), '.zcode');
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
