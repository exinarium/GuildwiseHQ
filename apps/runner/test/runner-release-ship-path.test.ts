import { delimiter } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecOptions, ExecResult, Executor } from '../src/toolchain/exec.ts';
import { cleanupTmp, makeConfig, tmp } from './helpers.ts';

type ShipOpts = {
  repoPath: string;
  toolPathDirs: string[];
  exec: (
    cmd: string,
    args: string[],
    o: { cwd: string; timeoutMs: number },
  ) => Promise<ExecResult & { timedOut: boolean }>;
};

const shipCalls: ShipOpts[] = [];

vi.mock('../src/git/release-ship.ts', async (orig) => {
  const real = await orig<typeof import('../src/git/release-ship.ts')>();
  return {
    ...real,
    shipReleaseCommit: async (opts: ShipOpts) => {
      shipCalls.push(opts);
      return { ok: false, step: 'prepare', error: 'stubbed', components: [], notices: [] };
    },
  };
});

afterEach(() => {
  shipCalls.length = 0;
  cleanupTmp();
});

class RecordingExec implements Executor {
  calls: Array<{ cmd: string; args: string[]; opts?: ExecOptions }> = [];
  async run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, args, opts });
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

const payload = {
  shipId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d1',
  projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d2',
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  remoteUrlNormalized: 'github.com/acme/web',
  projectName: 'Toy',
  workingBranch: 'develop',
  version: '1.4.0',
  tag: 'v1.4.0',
  date: '2026-11-01',
  lastTag: 'v1.3.0',
};

describe('runner release.ship command', () => {
  it('passes the tool PATH split and joined with the platform delimiter', async () => {
    const { Runner } = await import('../src/runner.ts');
    const exec = new RecordingExec();
    const r = new Runner({
      config: makeConfig('ws://127.0.0.1:9'),
      dataDir: tmp('aom-data-'),
      executor: exec,
    });
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const internals = r as unknown as {
      runCommand(id: string, command: string, payload: Record<string, unknown>): Promise<void>;
      findRepo: (n: string) => Promise<{ localPath: string } | null>;
      client: { send: (type: string, payload: Record<string, unknown>) => void };
    };
    internals.findRepo = async () => ({ localPath: '/repo/web' });
    internals.client.send = (type, p) => {
      sent.push({ type, payload: p });
    };

    await internals.runCommand('c1', 'release.ship', payload);

    expect(sent[0]?.type).toBe('command.result');
    expect(sent[0]?.payload.ok).toBe(true);
    expect(sent[0]?.payload.error).toBeUndefined();
    expect(shipCalls).toHaveLength(1);
    const call = shipCalls[0] as ShipOpts;
    expect(call.repoPath).toBe('/repo/web');
    const pathParts = (process.env.PATH ?? '').split(delimiter);
    expect(call.toolPathDirs.slice(-pathParts.length)).toEqual(pathParts);

    await call.exec('prettier', ['--write', 'CHANGELOG.md'], { cwd: '/repo/web', timeoutMs: 1000 });
    const run = exec.calls.find((c) => c.cmd === 'prettier');
    expect(run?.opts?.cwd).toBe('/repo/web');
    const envPath = run?.opts?.env?.PATH ?? '';
    expect(envPath.endsWith(process.env.PATH ?? '')).toBe(true);
    expect(envPath.split(delimiter)).toEqual(expect.arrayContaining(pathParts));
  });
});
