import type { ShiftReport } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';

const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function cli(files: Record<string, string> = {}) {
  const reports: ShiftReport[] = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async (r) => {
      reports.push(r.report);
      return { accepted: true, message: 'Recorded.' } as never;
    },
    rpc: async () => ({ ok: true, result: {} }),
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
  return { run: (...a: string[]) => runAom(a, ctx), reports, out, err };
}

describe('aom report: the BA reports to the manager', () => {
  it('triage, notes and signals send their JSON file as the outcome data', async () => {
    const decisions = { decisions: [{ itemId: 'a', action: 'pass', note: 'n' }] };
    const notes = { notes: [{ itemId: 'a', note: 'asked 3 times' }] };
    const reports = { reports: [{ signalId: 's', summary: '# analysis' }] };
    const t = await cli({
      'd.json': JSON.stringify(decisions),
      'n.json': JSON.stringify(notes),
      'r.json': JSON.stringify(reports),
    });
    expect(await t.run('report', 'triage', '--file', 'd.json')).toBe(0);
    expect(await t.run('report', 'notes', '--file', 'n.json')).toBe(0);
    expect(await t.run('report', 'signals', '--file', 'r.json')).toBe(0);
    expect(t.reports.map((r) => (r as { outcomeId: string }).outcomeId)).toEqual([
      'triage_done',
      'notes_done',
      'signal_report',
    ]);
    expect((t.reports[0] as { data: unknown }).data).toEqual(decisions);
    expect((t.reports[2] as { data: unknown }).data).toEqual(reports);
  });

  it('floor sends the markdown; a missing file or an unknown subcommand prints the usage', async () => {
    const t = await cli({ 'f.md': '# Floor report\n\nAll quiet.' });
    expect(await t.run('report', 'floor', '--summary-file', 'f.md')).toBe(0);
    expect(t.reports[0]).toMatchObject({
      kind: 'outcome',
      outcomeId: 'floor_report',
      data: { report: '# Floor report\n\nAll quiet.' },
    });
    expect(await t.run('report', 'floor')).toBe(1);
    expect(await t.run('report', 'triage')).toBe(1);
    expect(await t.run('report', 'bogus')).toBe(1);
    expect(t.err.join('')).toContain('aom report triage --file');
    expect(t.reports).toHaveLength(1);
  });
});
