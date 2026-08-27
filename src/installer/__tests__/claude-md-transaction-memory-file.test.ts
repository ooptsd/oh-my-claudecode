/**
 * Client-aware memory file naming for CLAUDE.md transactions (T4c).
 *
 * `ClaudeMdTransactionRequest.memoryFileName`/`companionFileName` default to
 * the historical 'CLAUDE.md'/'CLAUDE-omc.md'. Defaults must stay
 * byte-identical to the pre-parameterization behaviour; CodeBuddy sessions
 * pass 'CODEBUDDY.md'/'CODEBUDDY-omc.md' and every constructed filename,
 * import reference, and import block must follow.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_MD_IMPORT_END,
  CLAUDE_MD_IMPORT_START,
  executeClaudeMdTransaction,
} from '../claude-md-transaction.js';

const roots: string[] = [];
function fixture(): { root: string; canonicalRoot: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), 'omc-md-memory-file-'));
  roots.push(root);
  const plugin = join(root, 'plugin');
  mkdirSync(plugin);
  const source = join(plugin, 'CLAUDE.md');
  writeFileSync(source, '<!-- OMC:START -->\n# canonical\n<!-- OMC:END -->\n');
  // macOS /var -> /private/var: the transaction canonicalizes the root via
  // realpath, so expected operation paths must use the canonical root too.
  return { root, canonicalRoot: realpathSync(root), source };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const DEFAULT_IMPORT_BLOCK = `${CLAUDE_MD_IMPORT_START}\n@CLAUDE-omc.md\n${CLAUDE_MD_IMPORT_END}\n`;

describe('CLAUDE.md transaction memoryFileName defaults (byte equivalence)', () => {
  it('preserve mode keeps the exact historical CLAUDE.md/CLAUDE-omc.md bytes', () => {
    const { root, source } = fixture();
    writeFileSync(join(root, 'CLAUDE.md'), '# user\n');
    const result = executeClaudeMdTransaction({ mode: 'global-preserve', root, source, sourceRoot: join(root, 'plugin') });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(`# user\n\n\n${DEFAULT_IMPORT_BLOCK}`);
    expect(readFileSync(join(root, 'CLAUDE-omc.md'), 'utf8')).toBe('<!-- OMC:START -->\n# canonical\n<!-- OMC:END -->\n');
    expect(existsSync(join(root, 'CODEBUDDY.md'))).toBe(false);
    expect(existsSync(join(root, 'CODEBUDDY-omc.md'))).toBe(false);
  });

  it('local mode with defaults writes only CLAUDE.md', () => {
    const { root, canonicalRoot, source } = fixture();
    const result = executeClaudeMdTransaction({ mode: 'local', root, source, sourceRoot: join(root, 'plugin') });
    expect(result.ok).toBe(true);
    expect(result.createdPaths).toEqual([join(canonicalRoot, 'CLAUDE.md')]);
  });

  it('global-overwrite deletes the default companion orphan', () => {
    const { root, canonicalRoot, source } = fixture();
    writeFileSync(join(root, 'CLAUDE.md'), 'user\n');
    writeFileSync(join(root, 'CLAUDE-omc.md'), 'orphan\n');
    const result = executeClaudeMdTransaction({ mode: 'global-overwrite', root, source, sourceRoot: join(root, 'plugin') });
    expect(result.ok).toBe(true);
    expect(result.deletedPaths).toEqual([join(canonicalRoot, 'CLAUDE-omc.md')]);
  });
});

describe('CLAUDE.md transaction codebuddy file names', () => {
  const codebuddy = {
    memoryFileName: 'CODEBUDDY.md',
    companionFileName: 'CODEBUDDY-omc.md',
  };

  it('preserve mode writes CODEBUDDY.md with a @CODEBUDDY-omc.md import block', () => {
    const { root, source } = fixture();
    writeFileSync(join(root, 'CODEBUDDY.md'), '# user\n');
    const result = executeClaudeMdTransaction({
      mode: 'global-preserve',
      root,
      source,
      sourceRoot: join(root, 'plugin'),
      ...codebuddy,
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, 'CODEBUDDY.md'), 'utf8'))
      .toBe(`# user\n\n\n${CLAUDE_MD_IMPORT_START}\n@CODEBUDDY-omc.md\n${CLAUDE_MD_IMPORT_END}\n`);
    expect(readFileSync(join(root, 'CODEBUDDY-omc.md'), 'utf8')).toBe('<!-- OMC:START -->\n# canonical\n<!-- OMC:END -->\n');
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(root, 'CLAUDE-omc.md'))).toBe(false);
  });

  it('local mode writes only the custom main file', () => {
    const { root, canonicalRoot, source } = fixture();
    const result = executeClaudeMdTransaction({
      mode: 'local',
      root,
      source,
      sourceRoot: join(root, 'plugin'),
      ...codebuddy,
    });
    expect(result.ok).toBe(true);
    expect(result.createdPaths).toEqual([join(canonicalRoot, 'CODEBUDDY.md')]);
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('global-overwrite deletes only the custom companion orphan', () => {
    const { root, canonicalRoot, source } = fixture();
    writeFileSync(join(root, 'CODEBUDDY.md'), 'user\n');
    writeFileSync(join(root, 'CODEBUDDY-omc.md'), 'orphan\n');
    const result = executeClaudeMdTransaction({
      mode: 'global-overwrite',
      root,
      source,
      sourceRoot: join(root, 'plugin'),
      ...codebuddy,
    });
    expect(result.ok).toBe(true);
    expect(result.deletedPaths).toEqual([join(canonicalRoot, 'CODEBUDDY-omc.md')]);
    expect(result.createdPaths).toEqual([]);
    expect(readFileSync(join(root, 'CODEBUDDY.md'), 'utf8')).toContain('# canonical');
  });

  it('recognizes an owned custom import on rerun (idempotent)', () => {
    const { root, source } = fixture();
    const request = {
      mode: 'global-preserve' as const,
      root,
      source,
      sourceRoot: join(root, 'plugin'),
      ...codebuddy,
    };
    expect(executeClaudeMdTransaction(request).ok).toBe(true);
    const rerun = executeClaudeMdTransaction(request);
    expect(rerun).toMatchObject({ ok: true, operations: [], mutatedPaths: [] });
  });

  it('treats a stale @CLAUDE-omc.md import in the custom main as removable content', () => {
    const { root, source } = fixture();
    writeFileSync(
      join(root, 'CODEBUDDY.md'),
      `${CLAUDE_MD_IMPORT_START}\n@CLAUDE-omc.md\n${CLAUDE_MD_IMPORT_END}\n`,
    );
    const result = executeClaudeMdTransaction({
      mode: 'global-preserve',
      root,
      source,
      sourceRoot: join(root, 'plugin'),
      ...codebuddy,
    });
    expect(result.ok).toBe(true);
    const main = readFileSync(join(root, 'CODEBUDDY.md'), 'utf8');
    // The client-specific reference is appended; a stale cross-client import
    // block is NOT recognized under the new reference and is preserved as
    // user content (conservative: never silently delete user-visible bytes).
    expect(main).toContain('@CODEBUDDY-omc.md');
    expect(main).toContain('@CLAUDE-omc.md');
  });
});
