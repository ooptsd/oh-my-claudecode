/**
 * `omc install --client zcode --workspace=<path>` (T4, explicit path form).
 *
 * When --workspace is given an explicit path (string), the path itself is
 * zcodeDir (spec §5.4: NO auto-append). setupZcode's workspacePath argument
 * is dirname(zcodeDir) so .omc/ + .omc-version.json land at the parent.
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
  const workDir = mkdtempSync(join(tmpdir(), 'omc-ws-path-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workDir);
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
  for (const command of [program, ...program.commands]) {
    command.exitOverride((err) => { throw err; });
  }
  return program;
}

describe('omc install --workspace=<path> flag dispatch', () => {
  it('--workspace=/abs/path uses that exact path as zcodeDir (no auto-append)', async () => {
    const program = await freshProgram();
    const workDir = (cwdSpy as unknown as { __workDir: string }).__workDir;
    const target = join(workDir, 'myproj');
    await program.parseAsync(['install', '--client', 'zcode', `--workspace=${target}`, '--quiet'], { from: 'user' });
    expect(installMock).not.toHaveBeenCalled();
    expect(zcodeMock).toHaveBeenCalledTimes(1);
    // zcodeDir = target (no .zcode suffix appended per spec §5.4)
    expect(zcodeMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'workspace',
      zcodeDir: target,
      agentsMcpJsonPath: join(target, '.agents', 'mcp.json'),
      workspacePath: workDir, // dirname(zcodeDir) = parent of target
      packageDir: expect.any(String),
      hooksWanted: true,
    }));
    const install = program.commands.find((cmd) => cmd.name() === 'install');
    expect(install?.opts().workspace).toBe(target);
  });

  it('--workspace with relative-looking value is passed through verbatim to setupZcode (resolveZcodePaths owns it)', async () => {
    const program = await freshProgram();
    await program.parseAsync(['install', '--client', 'zcode', '--workspace=myrel/.zcode', '--quiet'], { from: 'user' });
    expect(zcodeMock).toHaveBeenCalledTimes(1);
    const call = zcodeMock.mock.calls[0][0];
    expect(call.scope).toBe('workspace');
    // We only assert zcodeDir identity; resolveZcodePaths returns it as-is per spec §5.4.
    expect(call.zcodeDir).toBe('myrel/.zcode');
  });
});