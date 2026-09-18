/**
 * `omc install --client <claude|codebuddy|zcode>` (T3, zcode dispatch migrated
 * from setup).
 *
 * The option exists for discoverability and validation: the actual env preset
 * happens earlier, in the preload side effect (src/cli/preload-client-env.ts),
 * which scans raw argv before commander parses. These tests drive the real
 * commander program and confirm the install command accepts --client zcode
 * and dispatches to setupZcode with user-level paths. The claude/codebuddy
 * path must remain byte-identical (installOmc is called with no --client).
 *
 * Integration with `omc setup --client zcode` as an alias is verified in T6.
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
  message: 'ZCode install complete',
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
    isInstalled: () => false,
    getInstallInfo: () => null,
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

describe('omc install --client option', () => {
  it('accepts --client zcode and dispatches to setupZcode with user-level paths', async () => {
    const program = await freshProgram();
    await program.parseAsync(['install', '--client', 'zcode', '--quiet'], { from: 'user' });
    expect(installMock).not.toHaveBeenCalled();
    expect(zcodeMock).toHaveBeenCalledTimes(1);
    expect(zcodeMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'user',
      zcodeDir: join(homedir(), '.zcode'),
      agentsMcpJsonPath: join(homedir(), '.agents', 'mcp.json'),
      packageDir: expect.any(String),
      hooksWanted: true,
    }));
    const install = program.commands.find((cmd) => cmd.name() === 'install');
    expect(install?.opts().client).toBe('zcode');
  });

  it('accepts --client claude and still routes to installOmc', async () => {
    const program = await freshProgram();
    await program.parseAsync(['install', '--client', 'claude', '--quiet'], { from: 'user' });
    expect(zcodeMock).not.toHaveBeenCalled();
    expect(installMock).toHaveBeenCalled();
  });

  it('keeps installOmc path when no --client is given (NOOP for default users)', async () => {
    const program = await freshProgram();
    await program.parseAsync(['install', '--quiet'], { from: 'user' });
    expect(zcodeMock).not.toHaveBeenCalled();
    expect(installMock).toHaveBeenCalled();
  });

  it('passes hooksWanted=false through to setupZcode with --skip-hooks', async () => {
    const program = await freshProgram();
    await program.parseAsync(['install', '--client', 'zcode', '--skip-hooks', '--quiet'], { from: 'user' });
    expect(zcodeMock).toHaveBeenCalledTimes(1);
    expect(zcodeMock).toHaveBeenCalledWith(expect.objectContaining({ hooksWanted: false }));
  });

  it('rejects unknown clients', async () => {
    const program = await freshProgram();
    await expect(
      program.parseAsync(['install', '--client', 'windowmaker'], { from: 'user' }),
    ).rejects.toThrow(/Allowed choices are claude, codebuddy, zcode/);
    expect(installMock).not.toHaveBeenCalled();
    expect(zcodeMock).not.toHaveBeenCalled();
  });

  it('documents the --client option choices on the install command', async () => {
    const { buildProgram } = await import('../index.js');
    const install = buildProgram().commands.find((cmd) => cmd.name() === 'install');
    const clientOption = install?.options.find((option) => option.long === '--client');
    expect(clientOption).toBeDefined();
    expect(clientOption?.argChoices).toEqual(['claude', 'codebuddy', 'zcode']);
  });
});
