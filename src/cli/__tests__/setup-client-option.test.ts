/**
 * `omc setup --client <claude|codebuddy|zcode>` (T5, zcode dispatch in T7).
 *
 * The option exists for discoverability and validation: the actual env preset
 * happens earlier, in the preload side effect (src/cli/preload-client-env.ts),
 * which scans raw argv before commander parses. These tests drive the real
 * commander program and additionally probe the built bundle for the choices
 * validation. The zcode path routes to setupZcode (mocked here) instead of
 * the Claude installer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';

// Tell src/cli/index.ts not to auto-parse process.argv on import.
process.env.OMC_CLI_SKIP_PARSE = '1';

const installMock = vi.fn(() => ({
  success: true,
  message: 'ok',
  installedAgents: [],
  installedCommands: [],
  installedSkills: [],
  hooksConfigured: true,
  hookConflicts: [],
  errors: [],
}));

const zcodeMock = vi.fn(() => ({
  success: true,
  message: 'ZCode setup complete',
  errors: [],
  deployed: { hooks: true, skills: 0, commands: 0, agents: 0 },
  pluginsRemoved: [],
}));

vi.mock('../../installer/zcode.js', () => ({
  setupZcode: zcodeMock,
}));

vi.mock('../../installer/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../installer/index.js')>(
    '../../installer/index.js'
  );
  return {
    ...actual,
    install: installMock,
    isInstalled: () => true,
    getInstallInfo: () => ({ installed: true, version: 'test' }),
  };
});

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  installMock.mockClear();
  zcodeMock.mockClear();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

async function freshProgram() {
  vi.resetModules();
  const { buildProgram } = await import('../index.js');
  const program = buildProgram();
  // exitOverride is per-command: option errors are raised on the subcommand.
  for (const command of [program, ...program.commands]) {
    command.exitOverride((err) => { throw err; });
  }
  return program;
}

describe('omc setup --client option', () => {
  it('accepts --client codebuddy (space form) and still runs install', async () => {
    const program = await freshProgram();
    await program.parseAsync(['setup', '--client', 'codebuddy', '--quiet'], { from: 'user' });
    expect(installMock).toHaveBeenCalled();
    const setup = program.commands.find((cmd) => cmd.name() === 'setup');
    expect(setup?.opts().client).toBe('codebuddy');
  });

  it('accepts --client=claude (equals form)', async () => {
    const program = await freshProgram();
    await program.parseAsync(['setup', '--client=claude', '--quiet'], { from: 'user' });
    expect(installMock).toHaveBeenCalled();
    const setup = program.commands.find((cmd) => cmd.name() === 'setup');
    expect(setup?.opts().client).toBe('claude');
  });

  it('accepts --client zcode in choices', async () => {
    const program = await freshProgram();
    await program.parseAsync(['setup', '--client', 'zcode', '--quiet'], { from: 'user' });
    expect(installMock).not.toHaveBeenCalled();
    expect(zcodeMock).toHaveBeenCalledTimes(1);
    expect(zcodeMock).toHaveBeenCalledWith(expect.objectContaining({
      zcodeDir: join(homedir(), '.zcode'),
      agentsMcpJsonPath: join(homedir(), '.agents', 'mcp.json'),
      packageDir: expect.any(String),
      hooksWanted: true, // 默认接线 hooks
    }));
    const setup = program.commands.find((cmd) => cmd.name() === 'setup');
    expect(setup?.opts().client).toBe('zcode');
  });

  it('passes hooksWanted=false through to setupZcode with --skip-hooks', async () => {
    const program = await freshProgram();
    await program.parseAsync(['setup', '--client', 'zcode', '--skip-hooks', '--quiet'], { from: 'user' });
    expect(zcodeMock).toHaveBeenCalledTimes(1);
    expect(zcodeMock).toHaveBeenCalledWith(expect.objectContaining({ hooksWanted: false }));
  });

  it('rejects unknown clients', async () => {
    const program = await freshProgram();
    await expect(
      program.parseAsync(['setup', '--client', 'windowmaker'], { from: 'user' }),
    ).rejects.toThrow(/Allowed choices are claude, codebuddy, zcode/);
    expect(installMock).not.toHaveBeenCalled();
    expect(zcodeMock).not.toHaveBeenCalled();
  });

  it('documents auto-detection as the default in the option help', async () => {
    await freshProgram();
    const { buildProgram } = await import('../index.js');
    const setup = buildProgram().commands.find((cmd) => cmd.name() === 'setup');
    const clientOption = setup?.options.find((option) => option.long === '--client');
    expect(clientOption).toBeDefined();
    expect(clientOption?.argChoices).toEqual(['claude', 'codebuddy', 'zcode']);
    expect(clientOption?.description).toMatch(/auto-detect/i);
  });
});
