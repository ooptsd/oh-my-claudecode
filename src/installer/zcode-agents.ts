/** Claude→ZCode agent frontmatter 转换（spec §6）。规则：name/description 保留；
 * model 删除（ZCode 缺省=跟随主会话）；tools/disallowedTools 逗号串→YAML 数组；
 * 未知键丢弃；正文逐字不动。 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEEP_KEYS = ['name', 'description', 'tools', 'disallowedTools'] as const;
const LIST_KEYS = new Set(['tools', 'disallowedTools']);

function splitFrontmatter(source: string): { lines: string[]; body: string } | null {
  if (!source.startsWith('---')) return null;
  const end = source.indexOf('\n---', 3);
  if (end === -1) return null;
  const afterBar = source.indexOf('\n', end + 1);
  if (afterBar === -1) return null;
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
