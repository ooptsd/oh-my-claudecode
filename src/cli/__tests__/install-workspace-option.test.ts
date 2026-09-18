/**
 * `omc install --client zcode --workspace` (T4, workspace dispatch for zcode).
 *
 * Bare `--workspace` (no value) must:
 *   - resolve zcodeDir = <cwd>/.zcode
 *   - resolve agentsMcpJsonPath = <cwd>/.zcode/.agents/mcp.json (spec W5)
 *   - pass workspacePath = <cwd> (= dirname(zcodeDir)) so setupZcode writes
 *     .omc-version.json + .omc/ to <cwd>/ (top level, outside zcodeDir;
 *     spec W6)
 *   - set scope = 'workspace' (vs T3 user-level)
 *
 * E1 conflict: `--workspace` with --client claude|codebuddy exits 1 with the
 * documented stderr message. T5 will add the regression test that runs the
 * integration directly; here we wire the check and assert the dispatch exit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  installMock.mockClear();
  zcodeMock.mockClear();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const workDir = mkdtempSync(join(tmpdir(), 'omc-ws-cli-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workDir);
  // Stash workDir on a shared ref so afterEach can clean it up.
  (cwdSpy as unknown as { __workDir: string }).__workDir = workDir;
});

afterEach(() => {
  const workDir = (cwdSpy as unknown as { __workDir?: string }).__workDir;
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  cwdSpy.mockRestore();
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

describe('omc install --workspace flag dispatch', () => {
  it('accepts bare --workspace with --client zcode and routes to setupZcode with workspace scope + cwd paths', async () => {
    const program = await freshProgram();
    await program.parseAsync(['install', '--client', 'zcode', '--workspace', '--quiet'], { from: 'user' });
    expect(installMock).not.toHaveBeenCalled();
    expect(zcodeMock).toHaveBeenCalledTimes(1);
    const workDir = (cwdSpy as unknown as { __workDir: string }).__workDir;
    expect(zcodeMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'workspace',
      zcodeDir: join(workDir, '.zcode'),
      agentsMcpJsonPath: join(workDir, '.zcode', '.agents', 'mcp.json'),
      workspacePath: workDir, // dirname(zcodeDir) → .omc/ + .omc-version.json 顶层
      packageDir: expect.any(String),
      hooksWanted: true,
    }));
    const install = program.commands.find((cmd) => cmd.name() === 'install');
    expect(install?.opts().workspace).toBe(true);
  });

  it('still uses scope=user (NOT workspace) when --workspace is absent (T3 path preserved)', async () => {
    const program = await freshProgram();
    await program.parseAsync(['install', '--client', 'zcode', '--quiet'], { from: 'user' });
    expect(zcodeMock).toHaveBeenCalledTimes(1);
    const call = zcodeMock.mock.calls[0][0];
    expect(call.scope).toBe('user');
    expect(call.workspacePath).toBeUndefined();
    expect(call.zcodeDir.endsWith('/.zcode')).toBe(true);
  });

  it('E1: --workspace with --client claude exits 1 with the documented stderr message', async () => {
    const program = await freshProgram();
    // exitOverride already routes process.exit through thrown CommanderError; with our handler
    // we set process.exit(1) BEFORE returning, so we catch via the exit listener below.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT_${code ?? 0}`);
    }) as never);
    try {
      await expect(
        program.parseAsync(['install', '--client', 'claude', '--workspace'], { from: 'user' }),
      ).rejects.toThrow(/EXIT_1/);
    } finally {
      exitSpy.mockRestore();
    }
    expect(installMock).not.toHaveBeenCalled();
    expect(zcodeMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    const stderrMessage = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stderrMessage).toMatch(/--workspace currently only supports --client zcode/);
    expect(stderrMessage).toMatch(/--client claude/);
  });

  it('E1 (auto-detected non-zcode): --workspace without --client resolves effectiveClient=claude → exit 1', async () => {
    // With no ZCODE_* / CODEBUDDY_* / OMC_CLIENT env, detectClient() falls back to 'claude'.
    const program = await freshProgram();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT_${code ?? 0}`);
    }) as never);
    try {
      await expect(
        program.parseAsync(['install', '--workspace'], { from: 'user' }),
      ).rejects.toThrow(/EXIT_1/);
    } finally {
      exitSpy.mockRestore();
    }
    expect(installMock).not.toHaveBeenCalled();
    expect(zcodeMock).not.toHaveBeenCalled();
    const stderrMessage = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stderrMessage).toMatch(/--workspace currently only supports --client zcode/);
    expect(stderrMessage).toMatch(/--client claude/);
  });

  it('documents the --workspace option on the install command', async () => {
    const { buildProgram } = await import('../index.js');
    const install = buildProgram().commands.find((cmd) => cmd.name() === 'install');
    const workspaceOption = install?.options.find((option) => option.long === '--workspace');
    expect(workspaceOption).toBeDefined();
    expect(workspaceOption?.description).toMatch(/workspace|Install to/i);
  });
});