/**
 * `omc setup --client <claude|codebuddy>` (T5).
 *
 * The option exists for discoverability and validation: the actual env preset
 * happens earlier, in the preload side effect (src/cli/preload-client-env.ts),
 * which scans raw argv before commander parses. These tests drive the real
 * commander program and additionally probe the built bundle for the choices
 * validation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

  it('rejects an invalid client value with the allowed choices', async () => {
    const program = await freshProgram();
    await expect(
      program.parseAsync(['setup', '--client', 'zcode'], { from: 'user' }),
    ).rejects.toThrow(/Allowed choices are claude, codebuddy/);
    expect(installMock).not.toHaveBeenCalled();
  });

  it('documents auto-detection as the default in the option help', async () => {
    await freshProgram();
    const { buildProgram } = await import('../index.js');
    const setup = buildProgram().commands.find((cmd) => cmd.name() === 'setup');
    const clientOption = setup?.options.find((option) => option.long === '--client');
    expect(clientOption).toBeDefined();
    expect(clientOption?.argChoices).toEqual(['claude', 'codebuddy']);
    expect(clientOption?.description).toMatch(/auto-detect/i);
  });
});
