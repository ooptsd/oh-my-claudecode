/**
 * Rules Injector Constants
 *
 * Constants for rule file discovery and matching.
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */

import { join } from 'path';
import { homedir } from 'os';
import { detectClient } from '../../utils/client.js';

/** Storage directory for rules injector state */
export const OMC_STORAGE_DIR = join(homedir(), '.omc');
export const RULES_INJECTOR_STORAGE = join(OMC_STORAGE_DIR, 'rules-injector');

/** Project marker files that indicate a project root */
export const PROJECT_MARKERS = [
  '.git',
  'pyproject.toml',
  'package.json',
  'Cargo.toml',
  'go.mod',
  '.venv',
];

/** Subdirectories to search for rules within projects */
export const PROJECT_RULE_SUBDIRS: [string, string][] = [
  ['.github', 'instructions'],
  ['.cursor', 'rules'],
  ['.claude', 'rules'],
];

/**
 * Session-aware project rule subdirectories. Identical to
 * PROJECT_RULE_SUBDIRS except that CodeBuddy sessions swap the `.claude/rules`
 * entry for `.codebuddy/rules`: CodeBuddy never reads `.claude/` project
 * state, so rule discovery must not cross-read it either.
 */
export function getProjectRuleSubdirs(): [string, string][] {
  if (detectClient() === 'codebuddy') {
    return PROJECT_RULE_SUBDIRS.map(([parent, subdir]) =>
      parent === '.claude' ? (['.codebuddy', subdir] as [string, string]) : [parent, subdir],
    );
  }
  return PROJECT_RULE_SUBDIRS;
}

/** Single-file rules that always apply */
export const PROJECT_RULE_FILES: string[] = [
  '.github/copilot-instructions.md',
];

/** Pattern for GitHub instructions files */
export const GITHUB_INSTRUCTIONS_PATTERN = /\.instructions\.md$/;

/** Valid rule file extensions */
export const RULE_EXTENSIONS = ['.md', '.mdc'];

/** Tools that trigger rule injection */
export const TRACKED_TOOLS = ['read', 'write', 'edit', 'multiedit'];
