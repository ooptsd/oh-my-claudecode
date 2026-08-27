/**
 * Client-aware memory file naming helpers (src/utils/memory-file.ts).
 */

import { describe, expect, it } from 'vitest';
import { getMemoryCompanionFileName, getMemoryFileName } from '../memory-file.js';

describe('memory file naming', () => {
  it('defaults to the claude names', () => {
    expect(getMemoryFileName({})).toBe('CLAUDE.md');
    expect(getMemoryCompanionFileName({})).toBe('CLAUDE-omc.md');
  });

  it('maps CodeBuddy sessions to the CODEBUDDY names', () => {
    expect(getMemoryFileName({ CODEBUDDY_PLUGIN_ROOT: '/p' })).toBe('CODEBUDDY.md');
    expect(getMemoryCompanionFileName({ CODEBUDDY_PLUGIN_DATA: '/d' })).toBe('CODEBUDDY-omc.md');
    expect(getMemoryFileName({ OMC_CLIENT: 'codebuddy' })).toBe('CODEBUDDY.md');
  });

  it('honours OMC_CLIENT=claude over the session signature', () => {
    expect(getMemoryFileName({ OMC_CLIENT: 'claude', CODEBUDDY_PLUGIN_ROOT: '/p' })).toBe('CLAUDE.md');
    expect(getMemoryCompanionFileName({ OMC_CLIENT: 'claude', CODEBUDDY_PLUGIN_ROOT: '/p' })).toBe('CLAUDE-omc.md');
  });
});
