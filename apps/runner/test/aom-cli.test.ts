import type { ShiftBrief, ShiftReport } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, parseArgs, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { makeShiftStart } from './fixtures.ts';

const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const brief = (makeShiftStart({ remoteNormalized: 'x' }) as { brief: ShiftBrief }).brief;

async function setup(
  verdict: (r: ShiftReport) => unknown = () => ({
    accepted: true,
    message: 'Recorded. Finish now; do not make further changes.',
  }),
) {
  const reports: ShiftReport[] = [];
  const rpcs: Array<{ method: string; params: unknown }> = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async (r) => {
      reports.push(r.report);
      return verdict(r.report) as never;
    },
    rpc: async (r) => {
      rpcs.push({ method: r.method, params: r.params });
      return r.method === 'card.get' ? { ok: true, result: brief } : { ok: true, result: 'found it' };
    },
  });
  const out: string[] = [];
  const err: string[] = [];
  const files: Record<string, string> = {
    '/n.txt': 'note from file',
    '/ev.txt': 'evidence from file',
    '/d.json': '{"items":[1]}',
  };
  const ctx: AomContext = {
    env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    fetch,
    readFile: (p) =>
      files[p] ??
      (() => {
        throw new Error(`ENOENT ${p}`);
      })(),
  };
  const run = (...argv: string[]) => runAom(argv, ctx);
  return { run, reports, rpcs, out, err, ctx, token, ipc };
}

describe('aom CLI', () => {
  it('parses repeated flags, =values and booleans', () => {
    const p = parseArgs(['approve', '--score', '4', '--option=a', '--option', 'b', '--json']);
    expect(p.positionals).toEqual(['approve']);
    expect(p.flags.get('option')).toEqual(['a', 'b']);
    expect(p.flags.get('json')).toEqual(['true']);
    expect(() => parseArgs(['--note'])).toThrow(/needs a value/);
  });

  it('card prints the prompt, card --json the brief', async () => {
    const t = await setup();
    expect(await t.run('card')).toBe(0);
    expect(t.out.join('')).toContain('# TOY-1: Add greeting');
    t.out.length = 0;
    expect(await t.run('card', '--json')).toBe(0);
    expect(JSON.parse(t.out.join('')).card.ref).toBe('TOY-1');
  });

  it('handoff, review, test and outcome map to outcome reports', async () => {
    const t = await setup();
    expect(await t.run('handoff', '--note', 'built')).toBe(0);
    expect(await t.run('review', 'approve', '--score', '4', '--note', 'good')).toBe(0);
    expect(
      await t.run(
        'review',
        'changes',
        '--reason',
        'weak_tests,broke_convention',
        '--score',
        '2',
        '--criteria-missed',
        'c1',
        '--criteria-missed',
        'c2',
        '--note-file',
        '/n.txt',
      ),
    ).toBe(0);
    expect(
      await t.run(
        'test',
        'pass',
        '--evidence',
        'all green',
        '--command',
        'pnpm test',
        '--command',
        'pnpm e2e',
      ),
    ).toBe(0);
    expect(
      await t.run(
        'test',
        'fail',
        '--title',
        'Crash on save',
        '--note',
        'it crashes',
        '--evidence-file',
        '/ev.txt',
      ),
    ).toBe(0);
    expect(await t.run('outcome', 'digest', '--note', 'ok', '--data-file', '/d.json')).toBe(0);
    expect(t.reports).toEqual([
      { kind: 'outcome', outcomeId: 'handoff', note: 'built', data: {} },
      { kind: 'outcome', outcomeId: 'approve', note: 'good', data: { score: 4 } },
      {
        kind: 'outcome',
        outcomeId: 'changes',
        note: 'note from file',
        data: { score: 2, reasons: ['weak_tests', 'broke_convention'], criteriaMissed: ['c1', 'c2'] },
      },
      {
        kind: 'outcome',
        outcomeId: 'pass',
        note: 'all green',
        data: { commands: ['pnpm test', 'pnpm e2e'], summary: 'all green', outputExcerpt: '' },
      },
      {
        kind: 'outcome',
        outcomeId: 'fail',
        note: 'it crashes',
        data: { title: 'Crash on save', evidence: 'evidence from file' },
      },
      { kind: 'outcome', outcomeId: 'digest', note: 'ok', data: { items: [1] } },
    ]);
    expect(t.out.join('')).toContain('Recorded. Finish now');
  });

  it('comment and ledger search', async () => {
    const t = await setup();
    expect(await t.run('comment', '--note', 'fyi')).toBe(0);
    expect(t.reports[0]).toEqual({ kind: 'comment', note: 'fyi' });
    expect(await t.run('ledger', 'search', 'cookies', '--scope', 'decision')).toBe(0);
    expect(t.rpcs.at(-1)).toEqual({
      method: 'ledger.search',
      params: { query: 'cookies', scope: 'decision' },
    });
    expect(t.out.join('')).toContain('found it');
  });

  it('question is stubbed (501): exit 2 and a clear message', async () => {
    const t = await setup();
    // the real supervisor answers 501; emulate with the handler status contract
    const ipc = new IpcServer();
    servers.push(ipc);
    await ipc.start();
    const token = ipc.registerShift({
      report: async () => ({ status: 501, error: 'questions are not available yet (M2)' }),
      rpc: async () => ({ ok: true }),
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runAom(
      ['question', '--text', 'why?', '--option', 'a', '--recommend', '0', '--doing', 'x'],
      {
        ...t.ctx,
        env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
        io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      },
    );
    expect(code).toBe(2);
    expect(err.join('')).toContain('not available yet');
  });

  it('a rejected report prints the reason and guard violations and exits 1', async () => {
    const t = await setup(() => ({
      accepted: false,
      message: 'Report rejected by the post-shift guard.',
      error: 'reviewer_modified_code: changed x',
      guardViolations: [{ rule: 'reviewer_modified_code', detail: 'changed x' }],
    }));
    expect(await t.run('review', 'approve', '--score', '5', '--note', 'ok')).toBe(1);
    const err = t.err.join('');
    expect(err).toContain('guard: reviewer_modified_code: changed x');
    expect(err).toContain('run the command again');
  });

  it('usage errors exit 1; unknown verbs exit 2; missing env explains itself', async () => {
    const t = await setup();
    expect(await t.run('handoff')).toBe(1);
    expect(t.err.join('')).toContain('--note');
    expect(await t.run('review', 'approve', '--note', 'x')).toBe(1); // missing score
    expect(await t.run('devops', 'do a thing')).toBe(2);
    const noEnv = await runAom(['card'], { ...t.ctx, env: {} });
    expect(noEnv).toBe(1);
    expect(t.err.join('')).toContain('AOM_SHIFT_TOKEN');
  });

  it('an expired token says the shift is over', async () => {
    const t = await setup();
    t.ipc.revoke(t.token);
    expect(await t.run('handoff', '--note', 'late')).toBe(1);
    expect(t.err.join('')).toContain('shift is over');
  });
});
