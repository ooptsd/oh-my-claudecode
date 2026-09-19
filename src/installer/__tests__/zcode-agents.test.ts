import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { convertClaudeAgentToZcodeAgent } from '../zcode-agents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..', '..', '..');

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
  it('treats closing delimiter without trailing newline as no frontmatter', () => {
    const noTrailingNewline = '---\nname: a\ndescription: d\n---';
    expect(convertClaudeAgentToZcodeAgent(noTrailingNewline)).toBe(noTrailingNewline);
  });
  it('drops empty list fields', () => {
    const out = convertClaudeAgentToZcodeAgent('---\nname: a\ndescription: d\ndisallowedTools: \n---\nbody');
    expect(out).not.toContain('disallowedTools');
  });
  it('round-trips the real agents/architect.md (no model, list-ified tools, body intact)', () => {
    const source = readFileSync(join(packageRoot, 'agents', 'architect.md'), 'utf-8');
    const out = convertClaudeAgentToZcodeAgent(source);
    expect(out).not.toContain('model:');
    expect(out).toContain('disallowedTools:\n  - Write\n  - Edit\n');
    expect(out).toContain('<Agent_Prompt>');
  });
});
