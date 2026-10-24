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
    readFile: () => 'from a file',
  };
  return { run: (...argv: string[]) => runAom(argv, ctx), rpcs, out, err };
}

const executed = () => ({ status: 'executed', message: 'done' });

describe('aom backlog suggest (agents)', () => {
  it('sends the title, description, priority and tags, and nothing about who is asking', async () => {
    const { run, rpcs, out } = await setup(() => ({ message: 'Added to the GWP backlog as a suggestion.' }));
    expect(
      await run(
        'backlog',
        'suggest',
        '--title',
        'Tidy the login page',
        '--description',
        'It has two spinners',
        '--priority',
        'High',
        '--tag',
        'ui',
        '--tag',
        'login',
      ),
    ).toBe(0);
    expect(rpcs).toEqual([
      {
        method: 'backlog.suggest',
        params: {
          title: 'Tidy the login page',
          description: 'It has two spinners',
          priority: 'high',
          tags: ['ui', 'login'],
        },
      },
    ]);
    expect(out.join('')).toContain('Added to the GWP backlog');
  });

  it('reads the description from a file and may name another project', async () => {
    const { run, rpcs } = await setup(() => ({}));
    expect(
      await run('backlog', 'suggest', '--title', 'T', '--description-file', 'd.md', '--project', 'WEB'),
    ).toBe(0);
    expect(rpcs[0]?.params).toEqual({ title: 'T', description: 'from a file', project: 'WEB' });
  });

  it('refuses a missing title and any other sub-verb: agents can only suggest', async () => {
    const { run, rpcs, err } = await setup(() => ({}));
    expect(await run('backlog', 'suggest')).toBe(1);
    for (const sub of ['list', 'update', 'drop', 'send'])
      expect(await run('backlog', sub, '--title', 'x')).toBe(1);
    expect(rpcs).toEqual([]);
    expect(err.join('')).toContain('only `suggest` exists for agents');
  });
});

describe('aom ceo backlog', () => {
  it('add: the project, title, description, priority, tags and flag', async () => {
    const { run, rpcs } = await setup(executed);
    expect(
      await run(
        'ceo',
        'backlog',
        'add',
        '--project',
        'GWP',
        '--title',
        'Export to CSV',
        '--description',
        'For the monthly report',
        '--priority',
        'CRITICAL',
        '--tag',
        'reports',
        '--tag',
        'export',
        '--flag',
      ),
    ).toBe(0);
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]?.method).toBe('ceo');
    expect(rpcs[0]?.params).toMatchObject({
      op: 'act',
      action: 'backlog-add',
      params: {
        project: 'GWP',
        title: 'Export to CSV',
        description: 'For the monthly report',
        priority: 'critical',
        tags: ['reports', 'export'],
        flagged: true,
      },
      dryRun: false,
    });
  });

  it('add needs a project and a title', async () => {
    const { run, rpcs } = await setup(executed);
    expect(await run('ceo', 'backlog', 'add', '--title', 'x')).toBe(1);
    expect(await run('ceo', 'backlog', 'add', '--project', 'GWP')).toBe(1);
    expect(rpcs).toEqual([]);
  });

  it('list: every filter, and the default sends no status (the server defaults to Open)', async () => {
    const { run, rpcs, out } = await setup(() => ({ items: [], text: 'No backlog items match.' }));
    expect(await run('ceo', 'backlog', 'list')).toBe(0);
    expect(rpcs[0]?.params).toEqual({ op: 'backlog', sub: 'list' });
    expect(out.join('')).toContain('No backlog items match.');
    expect(
      await run(
        'ceo',
        'backlog',
        'list',
        '--project',
        'GWP',
        '--tag',
        'ui',
        '--priority',
        'High',
        '--priority',
        'low',
        '--flagged',
        '--status',
        'done',
        '--status',
        'dropped',
        '--search',
        'dark',
        '--sort',
        'created',
      ),
    ).toBe(0);
    expect(rpcs[1]?.params).toEqual({
      op: 'backlog',
      sub: 'list',
      project: 'GWP',
      tag: ['ui'],
      priority: ['high', 'low'],
      flagged: true,
      status: ['done', 'dropped'],
      q: 'dark',
      sort: 'created',
    });
  });

  it('list --status all asks for every status', async () => {
    const { run, rpcs } = await setup(() => ({ text: '' }));
    expect(await run('ceo', 'backlog', 'list', '--status', 'all')).toBe(0);
    expect(rpcs[0]?.params).toMatchObject({ status: ['open', 'done', 'dropped'] });
  });

  it('update: each field, flag, unflag and drop', async () => {
    const { run, rpcs } = await setup(executed);
    const id = '0192f3a0-0000-7000-8000-000000000201';
    expect(
      await run(
        'ceo',
        'backlog',
        'update',
        id,
        '--title',
        'New',
        '--description',
        'D',
        '--priority',
        'Low',
        '--tag',
        'a',
        '--unflag',
      ),
    ).toBe(0);
    expect(rpcs[0]?.params).toMatchObject({
      action: 'backlog-update',
      params: { item: id, title: 'New', description: 'D', priority: 'low', tags: ['a'], flagged: false },
    });
    expect(await run('ceo', 'backlog', 'update', id, '--flag')).toBe(0);
    expect(rpcs[1]?.params).toMatchObject({ params: { item: id, flagged: true } });
    expect(await run('ceo', 'backlog', 'update', id, '--drop')).toBe(0);
    expect(rpcs[2]?.params).toMatchObject({ params: { item: id, drop: true } });
    expect(await run('ceo', 'backlog', 'update')).toBe(1);
    expect(await run('ceo', 'backlog', 'update', id, '--flag', '--unflag')).toBe(1);
  });

  it('send: by id, and by filters ("the flagged ui items")', async () => {
    const { run, rpcs } = await setup(executed);
    const id = '0192f3a0-0000-7000-8000-000000000201';
    expect(await run('ceo', 'backlog', 'send', id)).toBe(0);
    expect(rpcs[0]?.params).toMatchObject({ action: 'backlog-send', params: { item: id } });
    expect(await run('ceo', 'backlog', 'send', '--flagged', '--tag', 'ui')).toBe(0);
    expect(rpcs[1]?.params).toMatchObject({ action: 'backlog-send', params: { flagged: true, tag: ['ui'] } });
    expect(rpcs[1]?.params).not.toHaveProperty('params.item');
  });

  it('a refused action exits non-zero and prints the reason', async () => {
    const { run, out } = await setup(() => ({ status: 'refused', message: 'name an item or give filters' }));
    expect(await run('ceo', 'backlog', 'send')).toBe(1);
    expect(out.join('')).toContain('name an item or give filters');
  });

  it('an unknown sub-verb prints the usage', async () => {
    const { run, rpcs, err } = await setup(executed);
    expect(await run('ceo', 'backlog', 'nope')).toBe(1);
    expect(rpcs).toEqual([]);
    expect(err.join('')).toContain('aom ceo backlog add');
  });
});
