import type { ShiftReport } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';

const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function cli() {
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
    readFile: () => {
      throw new Error('no files');
    },
  };
  return { run: (...a: string[]) => runAom(a, ctx), reports, err };
}

describe('aom prep: the end of a release prep task', () => {
  it('done reports the prep_done outcome with the summary', async () => {
    const t = await cli();
    expect(await t.run('prep', 'done', '--summary', 'wrote the forms video')).toBe(0);
    expect(t.reports).toEqual([
      { kind: 'outcome', outcomeId: 'prep_done', note: 'wrote the forms video', data: { summary: 'wrote the forms video' } },
    ]);
  });

  it('fail reports the prep_failed outcome with the reason', async () => {
    const t = await cli();
    expect(await t.run('prep', 'fail', '--reason', 'the page is behind a flag')).toBe(0);
    expect(t.reports[0]).toMatchObject({ outcomeId: 'prep_failed', note: 'the page is behind a flag' });
  });

  it('anything else is a usage error and reports nothing', async () => {
    const t = await cli();
    expect(await t.run('prep', 'later')).not.toBe(0);
    expect(t.reports).toEqual([]);
    expect(t.err.join('')).toContain('aom prep done');
  });
});
