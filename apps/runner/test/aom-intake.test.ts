import type { ShiftReport } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();
const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const ITEM = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';

async function cli(
  files: Record<string, string> = {},
  rpcResult: (m: string, p: Record<string, unknown>) => unknown = () => ({}),
) {
  const reports: ShiftReport[] = [];
  const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async (r) => {
      reports.push(r.report);
      return { accepted: true, message: 'Recorded. Finish now.' } as never;
    },
    rpc: async (r) => {
      rpcs.push({ method: r.method, params: r.params });
      return { ok: true, result: rpcResult(r.method, r.params) };
    },
  });
  const out: string[] = [];
  const err: string[] = [];
  const ctx: AomContext = {
    env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    fetch,
    readFile: (p) => {
      const f = files[p];
      if (f === undefined) throw new Error(`ENOENT ${p}`);
      return f;
    },
  };
  return { run: (...a: string[]) => runAom(a, ctx), reports, rpcs, out, err };
}

describe('aom answer / escalate / finalize', () => {
  it('answer sends the item, the text and the chosen option', async () => {
    const t = await cli();
    expect(await t.run('answer', '--item', ITEM, '--text', 'Use tabs.', '--option', 'o1')).toBe(0);
    expect(t.reports).toEqual([{ kind: 'answer', itemId: ITEM, text: 'Use tabs.', optionId: 'o1' }]);
    expect(await t.run('answer', '--item', ITEM, '--text-file', 'a.md')).toBe(1); // unreadable file
    expect(await t.run('answer', '--text', 'x')).toBe(1);
    expect(t.err.join('')).toMatch(/usage: aom answer/);
  });

  it('escalate needs a note', async () => {
    const t = await cli();
    expect(await t.run('escalate', '--item', ITEM, '--note', 'only the manager can decide')).toBe(0);
    expect(t.reports).toEqual([{ kind: 'escalate', itemId: ITEM, note: 'only the manager can decide' }]);
    expect(await t.run('escalate', '--item', ITEM)).toBe(1);
  });

  it('finalize reports the finalized outcome without an action; an agent may not choose one', async () => {
    const t = await cli();
    expect(await t.run('finalize', '--note', 'small and green')).toBe(0);
    expect(t.reports).toEqual([
      { kind: 'outcome', outcomeId: 'finalized', note: 'small and green', data: {} },
    ]);
    expect(await t.run('finalize')).toBe(0);
    expect(t.reports.at(-1)).toMatchObject({ note: 'Finalize' });
    const before = t.reports.length;
    expect(await t.run('finalize', '--action', 'pr')).toBe(1);
    expect(await t.run('finalize', '--action', 'merge', '--note', 'x')).toBe(1);
    expect(t.reports).toHaveLength(before);
  });
});

describe('aom intake and card drafting', () => {
  it('maps a ticket or asks the manager', async () => {
    const t = await cli({}, (m) =>
      m === 'intake.map' ? { project: 'TOY', repos: ['toy'] } : { message: 'Asked the manager.' },
    );
    expect(await t.run('intake', 'map', '--project', 'toy')).toBe(0);
    expect(t.out.join('')).toContain('Mapped to project TOY (repos: toy).');
    expect(await t.run('intake', 'unmapped', '--note', 'no project fits')).toBe(0);
    expect(t.rpcs).toEqual([
      { method: 'intake.map', params: { project: 'toy' } },
      { method: 'intake.unmapped', params: { note: 'no project fits' } },
    ]);
    expect(await t.run('intake', 'map')).toBe(1);
    expect(await t.run('intake')).toBe(1);
  });

  it('creates, updates and specifies cards from JSON files', async () => {
    const draft = { title: 'Login', completionAction: 'pr', fields: { context: 'c' } };
    const t = await cli(
      { 'd.json': JSON.stringify(draft), 'p.json': '{"completionAction":"push_branch"}', 'bad.json': '{' },
      (m) =>
        m === 'card.create'
          ? { ref: 'TOY-1', missing: ['testPlan'] }
          : m === 'card.update'
            ? { ref: 'TOY-1', missing: [] }
            : { ref: 'TOY-1', stage: 'build', status: 'queued' },
    );
    expect(await t.run('card', 'create', '--file', 'd.json')).toBe(0);
    expect(t.out.join('')).toContain(
      'Created TOY-1 (draft). Still missing before it can be specified: testPlan.',
    );
    expect(await t.run('card', 'update', 'TOY-1', '--file', 'p.json')).toBe(0);
    expect(await t.run('card', 'specify', 'TOY-1')).toBe(0);
    expect(t.out.join('')).toContain('Specified TOY-1: it is now in build (queued).');
    expect(t.rpcs).toEqual([
      { method: 'card.create', params: draft },
      { method: 'card.update', params: { completionAction: 'push_branch', ref: 'TOY-1' } },
      { method: 'card.specify', params: { ref: 'TOY-1' } },
    ]);
    expect(await t.run('card', 'create', '--file', 'bad.json')).toBe(1);
    expect(t.err.join('')).toMatch(/cannot read bad.json as JSON/);
    expect(await t.run('card', 'create')).toBe(1);
    expect(await t.run('card', 'update', '--file', 'p.json')).toBe(1);
  });

  it('accepts the draft inline (--json), from a file and from stdin (--file -)', async () => {
    const draft = { title: 'Login', completionAction: 'pr', fields: { context: 'c' } };
    const t = await cli({ '-': JSON.stringify(draft), 'd.json': JSON.stringify(draft) }, () => ({
      ref: 'TOY-1',
      missing: [],
    }));
    expect(await t.run('card', 'create', '--json', JSON.stringify(draft))).toBe(0);
    expect(await t.run('card', 'create', '--file', '-')).toBe(0);
    expect(await t.run('card', 'create', '--file', 'd.json')).toBe(0);
    expect(await t.run('card', 'update', 'TOY-1', '--json', '{"priority":1}')).toBe(0);
    expect(t.rpcs.map((r) => r.params)).toEqual([draft, draft, draft, { priority: 1, ref: 'TOY-1' }]);
    expect(await t.run('card', 'create', '--json', '{')).toBe(1);
    expect(t.err.join('')).toMatch(/cannot read --json as JSON/);
    expect(await t.run('card', 'create', '--json', '{}', '--file', 'd.json')).toBe(1);
    expect(await t.run('card', 'create', '--json', '[1]')).toBe(1);
  });

  it('aom repo create takes a provider and host, and aom git status|connect call the runner', async () => {
    const t = await cli({}, () => ({ requestId: 'r1', message: 'ok' }));
    expect(
      await t.run(
        'repo',
        'create',
        '--provider',
        'azure-devops',
        '--name',
        'acme/Shop/web',
        '--private',
        '--project',
        'TOY',
      ),
    ).toBe(0);
    expect(
      await t.run(
        'repo',
        'create',
        '--provider',
        'gitlab',
        '--host',
        'git.example.com',
        '--name',
        'team/tools',
        '--public',
        '--project',
        'TOY',
      ),
    ).toBe(0);
    expect(await t.run('git', 'connect', 'gitlab', '--host', 'git.example.com')).toBe(0);
    expect(await t.run('git', 'status')).toBe(0);
    expect(await t.run('git', 'status', 'github')).toBe(0);
    expect(await t.run('git', 'connect')).toBe(1);
    expect(await t.run('git', 'nope')).toBe(1);
    expect(t.rpcs.map((r) => [r.method, r.params])).toEqual([
      [
        'repo.create',
        { name: 'acme/Shop/web', project: 'TOY', provider: 'azure-devops', visibility: 'private' },
      ],
      [
        'repo.create',
        {
          name: 'team/tools',
          project: 'TOY',
          provider: 'gitlab',
          host: 'git.example.com',
          visibility: 'public',
        },
      ],
      ['git.connect', { provider: 'gitlab', host: 'git.example.com' }],
      ['git.status', {}],
      ['git.status', { provider: 'github' }],
    ]);
  });

  it('asks for a repository (aom repo create) and validates its flags', async () => {
    const t = await cli({}, () => ({ requestId: 'r1', message: 'Asked the project owner.' }));
    expect(
      await t.run(
        'repo',
        'create',
        '--name',
        'acme/new',
        '--public',
        '--project',
        'TOY',
        '--description',
        'D',
      ),
    ).toBe(0);
    expect(await t.run('repo', 'create', '--name', 'acme/new', '--project', 'TOY')).toBe(0 + 1);
    expect(
      await t.run('repo', 'create', '--name', 'acme/new', '--private', '--public', '--project', 'TOY'),
    ).toBe(1);
    expect(await t.run('repo', 'create', '--private', '--project', 'TOY')).toBe(1);
    expect(await t.run('repo', 'create', '--name', 'acme/p', '--private', '--project', 'TOY')).toBe(0);
    expect(t.rpcs).toEqual([
      {
        method: 'repo.create',
        params: { name: 'acme/new', project: 'TOY', visibility: 'public', description: 'D' },
      },
      { method: 'repo.create', params: { name: 'acme/p', project: 'TOY', visibility: 'private' } },
    ]);
    expect(t.out.join('')).toContain('Asked the project owner.');
  });

  it('reads a source through the runner', async () => {
    const t = await cli({}, () => 'acme/toy#12: Add dark mode\n\nUsers want it.');
    expect(await t.run('source', 'read', '--ref', 'acme/toy#12')).toBe(0);
    expect(t.out.join('')).toContain('acme/toy#12: Add dark mode');
    expect(t.rpcs[0]).toEqual({ method: 'source.read', params: { ref: 'acme/toy#12' } });
    expect(await t.run('source', 'read')).toBe(1);
  });
});
