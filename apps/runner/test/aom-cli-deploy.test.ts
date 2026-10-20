import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';

const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function setup(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async () => ({ accepted: true, message: 'ok' }) as never,
    rpc: async (r) => {
      rpcs.push({ method: r.method, params: r.params });
      return { ok: true, result: answer(r.method, r.params) };
    },
  });
  const out: string[] = [];
  const err: string[] = [];
  const ctx: AomContext = {
    env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    fetch,
    readFile: () => '',
  };
  return { run: (...argv: string[]) => runAom(argv, ctx), rpcs, out, err };
}

describe('aom deploy (docs/design/ceo-front-door.md 9.6): the model only asks', () => {
  it('run <env> sends one rpc with the project, commit and target, and prints the server answer', async () => {
    const { run, rpcs, out } = await setup(() => ({
      message:
        'production on p5-prod is ready and waits in the release queue for the Owner or an Admin to press Release.',
      runs: [{ status: 'waiting_release' }],
    }));
    expect(
      await run(
        'deploy',
        'run',
        'production',
        '--project',
        'P5',
        '--commit',
        'abc1234',
        '--target',
        'p5-prod',
      ),
    ).toBe(0);
    expect(rpcs).toEqual([
      {
        method: 'deploy.run',
        params: { env: 'production', project: 'P5', commit: 'abc1234', target: 'p5-prod' },
      },
    ]);
    expect(out.join('')).toContain('waits in the release queue');
  });

  it('a refused deploy exits non-zero (a normal answer, not a crash)', async () => {
    const refusedRun = await setup(() => ({
      message: 'Refused (gate_unsatisfied): the gate does not hold',
      runs: [{ status: 'refused' }],
    }));
    expect(await refusedRun.run('deploy', 'run', 'production')).toBe(1);
    const viaCeo = await setup(() => ({
      status: 'refused',
      message: 'Refused: the owner set this action to never.',
    }));
    expect(await viaCeo.run('deploy', 'run', 'production')).toBe(1);
  });

  it('trial and status; usage errors', async () => {
    const { run, rpcs, out } = await setup((m) =>
      m === 'deploy.status' ? { runs: [] } : { message: 'released as a trial', runs: [{ status: 'queued' }] },
    );
    expect(await run('deploy', 'trial', '--env', 'local', '--project', 'P5')).toBe(0);
    expect(await run('deploy', 'status')).toBe(0);
    expect(rpcs.map((r) => r.method)).toEqual(['deploy.trial', 'deploy.status']);
    expect(out.join('')).toContain('"runs"');
    expect(await run('deploy', 'run')).toBe(1);
    expect(await run('deploy', 'launch', 'x')).toBe(1);
  });
});

describe('aom recipe save', () => {
  it('sends the absolute scratch folder and the project; prints the hash and lint', async () => {
    const { run, rpcs, out } = await setup(() => ({
      message: 'Saved into the project vault.',
      hash: 'a'.repeat(64),
      status: 'observed',
      lint: [{ level: 'warn', message: 'something' }],
    }));
    expect(await run('recipe', 'save', '--dir', '/tmp/scratch', '--project', 'P5')).toBe(0);
    expect(rpcs).toEqual([{ method: 'recipe.save', params: { dir: '/tmp/scratch', project: 'P5' } }]);
    expect(out.join('')).toContain(`recipe hash: ${'a'.repeat(64)}`);
    expect(await run('recipe', 'save')).toBe(1);
  });

  it('exits non-zero when the lint has errors', async () => {
    const { run } = await setup(() => ({
      message: 'Saved.',
      lint: [{ level: 'error', message: 'script is not executable' }],
    }));
    expect(await run('recipe', 'save', '--dir', '/tmp/s', '--project', 'P5')).toBe(1);
  });
});
