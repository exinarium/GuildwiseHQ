import type { IpcRpcRequest, ShiftReport } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';

const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

/** The aom CLI against a real IPC server whose reports and rpcs are recorded. */
async function cli(files: Record<string, string> = {}, rpcResult: unknown = { message: 'ok' }) {
  const reports: ShiftReport[] = [];
  const rpcs: IpcRpcRequest[] = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async (r) => {
      reports.push(r.report);
      return { accepted: true, message: 'Recorded.' } as never;
    },
    rpc: async (r) => {
      rpcs.push(r);
      return { ok: true, result: rpcResult };
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
  return { run: (...a: string[]) => runAom(a, ctx), reports, rpcs, out, err };
}

describe('aom phase: the BA proposes in its intake chat', () => {
  it('list prints phases, targets and defaults from the rpc', async () => {
    const t = await cli(
      {},
      {
        project: 'TOY',
        phases: [
          { ref: 'TOY-P1', name: 'Autosave', status: 'open', members: 2, followups: ['Deploy to local'] },
        ],
        deployTargets: [
          {
            name: 'local',
            kind: 'local_docker',
            host: null,
            appUrl: 'http://localhost:4601',
            workstation: null,
            testerOnWorkstation: null,
            notes: '',
          },
        ],
        defaultFollowups: [],
      },
    );
    expect(await t.run('phase', 'list', '--project', 'toy')).toBe(0);
    expect(t.rpcs).toEqual([{ method: 'phase.list', params: { project: 'toy' } }]);
    const text = t.out.join('');
    expect(text).toContain('TOY-P1 Autosave (open, 2 card(s)); follow-ups: Deploy to local');
    expect(text).toContain('local: local Docker');
    expect(text).toContain('never invent one');
  });

  it('propose sends the name, description and the follow-ups file', async () => {
    const t = await cli({ 'f.json': '[{"kind":"regression"}]' }, { message: 'Proposed phase TOY-P2.' });
    expect(
      await t.run(
        'phase',
        'propose',
        '--name',
        'Phase 2',
        '--description',
        'd',
        '--followups-file',
        'f.json',
      ),
    ).toBe(0);
    expect(t.rpcs[0]).toEqual({
      method: 'phase.propose',
      params: { name: 'Phase 2', description: 'd', followups: [{ kind: 'regression' }] },
    });
    expect(t.out.join('')).toContain('Proposed phase TOY-P2.');
  });

  it('propose needs a name and valid JSON; assign needs a phase or --none', async () => {
    const t = await cli({ 'bad.json': '{nope' });
    expect(await t.run('phase', 'propose')).toBe(1);
    expect(await t.run('phase', 'propose', '--name', 'x', '--followups-file', 'bad.json')).toBe(1);
    expect(t.err.join('')).toContain('cannot read --followups-file as JSON');
    expect(await t.run('phase', 'assign', 'TOY-3')).toBe(1);
    expect(t.rpcs).toEqual([]);
  });

  it('assign puts a card in a phase or takes it out; submit asks for confirmation', async () => {
    const t = await cli();
    expect(await t.run('phase', 'assign', 'TOY-3', '--phase', 'TOY-P1')).toBe(0);
    expect(await t.run('phase', 'assign', 'TOY-3', '--none')).toBe(0);
    expect(await t.run('phase', 'submit', 'TOY-P1')).toBe(0);
    expect(t.rpcs).toEqual([
      { method: 'phase.assign', params: { card: 'TOY-3', phase: 'TOY-P1' } },
      { method: 'phase.assign', params: { card: 'TOY-3', phase: null } },
      { method: 'phase.submit', params: { phase: 'TOY-P1' } },
    ]);
  });
});

describe('aom phase: the BA works a phase task', () => {
  it('followup brief delegates through the rpc; --to must be devops, tester or ba', async () => {
    const t = await cli();
    expect(await t.run('phase', 'followup', 'brief', '2', '--to', 'tester', '--text', 'run the suite')).toBe(
      0,
    );
    expect(t.rpcs).toEqual([
      { method: 'phase.followup.brief', params: { position: 2, to: 'tester', text: 'run the suite' } },
    ]);
    expect(await t.run('phase', 'followup', 'brief', '2', '--to', 'robot', '--text', 'x')).toBe(1);
    expect(await t.run('phase', 'followup', 'brief', 'two', '--to', 'ba', '--text', 'x')).toBe(1);
    expect(await t.run('phase', 'followup', 'brief', '1', '--to', 'ba')).toBe(1);
  });

  it('ready, report, results, done and fail send the terminal outcomes with their data', async () => {
    const t = await cli({ 'r.md': '# Report', 's.md': '# Results' });
    expect(await t.run('phase', 'ready', '--note', 'all briefed')).toBe(0);
    expect(
      await t.run(
        'phase',
        'report',
        '--summary-file',
        'r.md',
        '--outstanding',
        'docs',
        '--outstanding',
        'PR',
      ),
    ).toBe(0);
    expect(await t.run('phase', 'results', '--summary-file', 's.md')).toBe(0);
    expect(
      await t.run('phase', 'followup', 'done', '1', '--summary', 'did it', '--link', 'https://x.test/a'),
    ).toBe(0);
    expect(await t.run('phase', 'followup', 'fail', '3', '--summary', 'could not')).toBe(0);
    expect(t.reports).toEqual([
      { kind: 'outcome', outcomeId: 'phase_ready', note: 'all briefed', data: { note: 'all briefed' } },
      {
        kind: 'outcome',
        outcomeId: 'phase_report',
        note: 'Phase report',
        data: { report: '# Report', outstanding: ['docs', 'PR'] },
      },
      {
        kind: 'outcome',
        outcomeId: 'phase_results',
        note: 'Follow-up results report',
        data: { report: '# Results' },
      },
      {
        kind: 'outcome',
        outcomeId: 'followup_done',
        note: 'Follow-up 1 done',
        data: { position: 1, summary: 'did it', links: ['https://x.test/a'] },
      },
      {
        kind: 'outcome',
        outcomeId: 'followup_failed',
        note: 'Follow-up 3 failed',
        data: { position: 3, summary: 'could not' },
      },
    ]);
  });

  it('report and results need a summary; an unknown subcommand prints the usage', async () => {
    const t = await cli();
    expect(await t.run('phase', 'report')).toBe(1);
    expect(await t.run('phase', 'results')).toBe(1);
    expect(await t.run('phase', 'nonsense')).toBe(1);
    expect(t.err.join('')).toContain('usage: aom phase list');
    expect(t.reports).toEqual([]);
  });

  it('aom card <REF> reads a member card through the rpc', async () => {
    const t = await cli({}, { ref: 'TOY-4', title: 'A card' });
    expect(await t.run('card', 'TOY-4')).toBe(0);
    expect(t.rpcs).toEqual([{ method: 'card.get', params: { ref: 'TOY-4' } }]);
    expect(t.out.join('')).toContain('"title": "A card"');
  });
});
