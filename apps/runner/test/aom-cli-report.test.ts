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

describe('aom report: the BA reporter is retired', () => {
  it('triage, notes, signals and floor answer "retired" and send nothing', async () => {
    const t = await cli({ 'd.json': '{}', 'f.md': '# x' });
    expect(await t.run('report', 'triage', '--file', 'd.json')).toBe(1);
    expect(await t.run('report', 'notes', '--file', 'd.json')).toBe(1);
    expect(await t.run('report', 'signals', '--file', 'd.json')).toBe(1);
    expect(await t.run('report', 'floor', '--summary-file', 'f.md')).toBe(1);
    expect(t.err.join('')).toContain('aom report triage is retired');
    expect(t.reports).toHaveLength(0);
  });

  it('brief sends the markdown; a missing file or an unknown subcommand prints the usage', async () => {
    const t = await cli({ 'f.md': '# Analysis\n\nAll quiet.' });
    expect(await t.run('report', 'brief', '--summary-file', 'f.md')).toBe(0);
    expect(t.reports[0]).toMatchObject({
      kind: 'outcome',
      outcomeId: 'scheduled_brief',
      data: { report: '# Analysis\n\nAll quiet.' },
    });
    expect(await t.run('report', 'brief')).toBe(1);
    expect(await t.run('report', 'bogus')).toBe(1);
    expect(t.err.join('')).toContain('aom report brief --summary-file');
    expect(t.reports).toHaveLength(1);
  });
});
