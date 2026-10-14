import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, parseArgs, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { buildHash, findBuildDoc } from '../src/runs/discovery.ts';
import { parseDotenv, redactValues, substitute } from '../src/runs/text.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function setup(answer: unknown = { message: 'ok', exitCode: 0 }) {
  const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async () => ({ accepted: true, message: 'x' }),
    rpc: async (r) => {
      rpcs.push({ method: r.method, params: r.params });
      return { ok: true, result: answer };
    },
  });
  const out: string[] = [];
  const err: string[] = [];
  const ctx: AomContext = {
    env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    fetch,
    readFile: () => {
      throw new Error('no files');
    },
  };
  return { run: (...argv: string[]) => runAom(argv, ctx), rpcs, out, err };
}

describe('aom run', () => {
  it('takes the command after -- as it is, flags included', () => {
    const p = parseArgs(['service', '--name', 'api', '--', 'dotnet', 'run', '--no-build', '--urls=x'], 'run');
    expect(p.positionals).toEqual(['service']);
    expect(p.flags.get('name')).toEqual(['api']);
    expect(p.flags.get(' cmd')).toEqual(['dotnet', 'run', '--no-build', '--urls=x']);
  });

  it('turns step and service into rpcs with parsed ports, health, env and the command', async () => {
    const t = await setup();
    expect(
      await t.run(
        'run',
        'step',
        '--name',
        'npm ci',
        '--repo',
        'web',
        '--env',
        'A=b',
        '--',
        'npm',
        'ci',
        '--prefer-offline',
      ),
    ).toBe(0);
    expect(t.rpcs.at(-1)).toEqual({
      method: 'run.step',
      params: {
        name: 'npm ci',
        repo: 'web',
        cmd: ['npm', 'ci', '--prefer-offline'],
        env: { A: 'b' },
        wait: false,
      },
    });
    expect(
      await t.run(
        'run',
        'service',
        '--name',
        'api',
        '--repo',
        'api',
        '--cwd',
        'src/Api',
        '--port',
        'http:5000:ASPNETCORE_HTTP_PORTS',
        '--health',
        'http://localhost:${port}/health',
        '--after',
        'db',
        '--stop-cmd',
        'dotnet build-server shutdown',
        '--',
        'dotnet',
        'run',
      ),
    ).toBe(0);
    const s = t.rpcs.at(-1)!;
    expect(s.method).toBe('run.service');
    expect(s.params).toMatchObject({
      name: 'api',
      repo: 'api',
      cwd: 'src/Api',
      cmd: ['dotnet', 'run'],
      ports: [
        { name: 'http', default: 5000, envVar: 'ASPNETCORE_HTTP_PORTS', url: 'http://localhost:${port}/' },
      ],
      health: { kind: 'http', url: 'http://localhost:${port}/health', expect: '2xx' },
      after: ['db'],
      stopCmd: ['dotnet', 'build-server', 'shutdown'],
      docker: false,
    });
  });

  it('prints the answer and exits with its code; status, logs, ready and fail are plain rpcs', async () => {
    const t = await setup({ message: 'Service "web" is still starting.', exitCode: 3 });
    expect(await t.run('run', 'status')).toBe(3);
    expect(t.out.join('')).toContain('still starting');
    expect(t.rpcs.at(-1)).toEqual({ method: 'run.status', params: {} });
    await t.run('run', 'logs', 'web', '--lines', '20');
    expect(t.rpcs.at(-1)).toEqual({ method: 'run.logs', params: { service: 'web', lines: 20 } });
    await t.run('run', 'ready', '--notes', 'all good');
    expect(t.rpcs.at(-1)).toEqual({ method: 'run.ready', params: { notes: 'all good' } });
    await t.run('run', 'fail', '--reason', 'needs a database');
    expect(t.rpcs.at(-1)).toEqual({ method: 'run.fail', params: { reason: 'needs a database' } });
  });

  it('checks the usage', async () => {
    const t = await setup();
    expect(await t.run('run')).toBe(1);
    expect(await t.run('run', 'service', '--name', 'x')).toBe(1); // no command
    expect(await t.run('run', 'service', '--name', 'x', '--port', 'oops', '--', 'a')).toBe(1);
    expect(t.err.join('')).toMatch(/name:number/);
    expect(await t.run('run', 'service', '--name', 'x', '--env', 'NOEQUALS', '--', 'a')).toBe(1);
    expect(await t.run('run', 'fail')).toBe(1);
    expect(t.rpcs).toEqual([]);
  });
});

describe('run helpers', () => {
  it('finds BUILD.md in the project folder first, then the root, in any case', () => {
    const wt = tmp();
    mkdirSync(join(wt, 'app'), { recursive: true });
    writeFileSync(join(wt, 'Build.md'), 'root');
    expect(findBuildDoc(wt)).toMatchObject({ path: 'Build.md', content: 'root' });
    expect(findBuildDoc(wt, 'app')).toMatchObject({ content: 'root' }); // none in app: the root one
    writeFileSync(join(wt, 'app', 'build.MD'), 'sub');
    expect(findBuildDoc(wt, 'app')).toMatchObject({ path: join('app', 'build.MD'), content: 'sub' });
    expect(findBuildDoc(tmp())).toBeNull();
    expect(buildHash([{ repoId: 'a', content: 'x' }])).toMatch(/^[0-9a-f]{64}$/);
    expect(buildHash([{ repoId: 'a', content: 'x' }])).not.toBe(buildHash([{ repoId: 'a', content: 'y' }]));
  });

  it('parses env files, substitutes port templates and redacts secrets', () => {
    expect(parseDotenv('# c\nA=1\nexport B="two words"\nC=x # note\nD=\'q\'\n')).toEqual({
      A: '1',
      B: 'two words',
      C: 'x',
      D: 'q',
    });
    const svcs = new Map([['db', { ports: [{ name: 'pg', port: 5433 }] }]]);
    const own = { ports: [{ name: 'http', port: 5001 }] };
    expect(
      substitute('p=${port} h=${http} d=${db.port} n=${db.pg} u=${nope.port} x=${port2}', own, svcs),
    ).toBe('p=5001 h=5001 d=5433 n=5433 u=${nope.port} x=${port2}');
    expect(redactValues('token=abcdef123 and short=ab', new Set(['abcdef123', 'ab']))).toBe(
      'token=*** and short=ab',
    );
  });
});
