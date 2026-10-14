import type { IpcRpcRequest, ShiftReport } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';

const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function cli(files: Record<string, string> = {}, answer: unknown = { status: 'executed', message: 'Done.' }) {
  const reports: ShiftReport[] = [];
  const calls: IpcRpcRequest[] = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async (r) => {
      reports.push(r.report);
      return { accepted: true, message: 'Recorded.' } as never;
    },
    rpc: async (req) => {
      calls.push(req);
      return { ok: true, result: answer };
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
      if (f === undefined) throw new Error(`no such file ${p}`);
      return f;
    },
  };
  return { run: (...a: string[]) => runAom(a, ctx), reports, calls, out, err };
}

describe('aom ceo', () => {
  it('act sends the action with its parameters, reason, confidence and evidence', async () => {
    const t = await cli();
    const code = await t.run(
      'ceo', 'act', 'priority', '--card', 'TOY-3', '--to', '2', '--reason', 'it blocks the release', '--confidence', '0.85',
      '--evidence', 'ledger:abc', '--evidence', 'signal:def', '--key', 'k1',
    );
    expect(code).toBe(0);
    expect(t.calls[0]).toEqual({
      method: 'ceo',
      params: {
        op: 'act',
        action: 'priority',
        params: { card: 'TOY-3', to: '2' },
        reason: 'it blocks the release',
        confidence: 0.85,
        evidence: ['ledger:abc', 'signal:def'],
        key: 'k1',
        dryRun: false,
      },
    });
    expect(t.out.join('')).toContain('executed: Done.');
  });

  it('turns flags into parameters (kebab case to camel case, switches to true) and honours --dry-run', async () => {
    const t = await cli();
    await t.run('ceo', 'act', 'stop-shift', '--shift', 's1', '--keep-card', '--dry-run', '--reason', 'looping', '--confidence', '0.9');
    expect((t.calls[0]?.params as any).params).toEqual({ shift: 's1', keepCard: 'true' });
    expect((t.calls[0]?.params as any).dryRun).toBe(true);
  });

  it('needs a reason and a confidence between 0 and 1', async () => {
    const t = await cli();
    expect(await t.run('ceo', 'act', 'release', '--card', 'TOY-1')).toBe(1);
    expect(await t.run('ceo', 'act', 'release', '--card', 'TOY-1', '--reason', 'x', '--confidence', '3')).toBe(1);
    expect(t.calls).toHaveLength(0);
  });

  it('a refusal is exit code 1, a recommendation is not an error', async () => {
    const refused = await cli({}, { status: 'refused', message: 'the card is not claimed' });
    expect(await refused.run('ceo', 'act', 'release', '--card', 'TOY-1', '--reason', 'stuck', '--confidence', '0.9')).toBe(1);
    const rec = await cli({}, { status: 'recommended', message: 'Recommended to the owner instead of done.' });
    expect(await rec.run('ceo', 'act', 'release', '--card', 'TOY-1', '--reason', 'stuck', '--confidence', '0.9')).toBe(0);
  });

  it('recommend on a desk item, snapshot, show, search, notify, task and memory', async () => {
    const t = await cli({}, { text: 'snapshot text' });
    await t.run('ceo', 'recommend', '--item', 'i1', '--option', 'o2', '--reason', 'cheaper', '--confidence', '0.7');
    await t.run('ceo', 'snapshot', '--section', 'desk');
    await t.run('ceo', 'show', 'card', 'TOY-4');
    await t.run('ceo', 'search', 'memory', 'database choice');
    await t.run('ceo', 'notify', '--kind', 'urgent', '--text', 'builders crash', '--title', 'Crashes');
    await t.run('ceo', 'task', 'create', '--title', 'Speed up builds', '--request', 'look into it');
    await t.run('ceo', 'task', 'update', '--id', 't1', '--status', 'done', '--note', 'finished', '--watch', 'card:c1');
    await t.run('ceo', 'memory', 'propose', '--text', 'always use Postgres', '--source', 'owner_chat');
    const ops = t.calls.map((c) => (c.params as any).op);
    expect(ops).toEqual(['recommend', 'snapshot', 'show', 'search', 'notify', 'task', 'task', 'memory']);
    expect(t.calls[0]?.params).toMatchObject({ item: 'i1', option: 'o2', confidence: 0.7 });
    expect(t.calls[2]?.params).toMatchObject({ kind: 'card', ref: 'TOY-4' });
    expect(t.calls[3]?.params).toMatchObject({ in: 'memory', q: 'database choice' });
    expect(t.calls[6]?.params).toMatchObject({ id: 't1', status: 'done', watch: [{ kind: 'card', id: 'c1' }] });
    expect(t.out.join('')).toContain('snapshot text');
  });

  it('done and report are the terminal outcomes', async () => {
    const t = await cli({ 'r.md': '## Needs you\nnone' });
    expect(await t.run('ceo', 'done', '--summary', 'handled two items')).toBe(0);
    expect(await t.run('ceo', 'report', '--summary-file', 'r.md')).toBe(0);
    expect(t.reports).toEqual([
      { kind: 'outcome', outcomeId: 'ceo_done', note: 'Wake handled', data: { summary: 'handled two items' } },
      { kind: 'outcome', outcomeId: 'ceo_report', note: 'Daily report', data: { report: '## Needs you\nnone' } },
    ]);
    expect(await t.run('ceo', 'bogus')).toBe(1);
  });
});
