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

async function cli() {
  const reports: ShiftReport[] = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async (r) => {
      reports.push(r.report);
      return { accepted: true, message: 'Recorded. Finish now.' } as never;
    },
    rpc: async () => ({ ok: true, result: {} }),
  });
  const err: string[] = [];
  const ctx: AomContext = {
    env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
    io: { out: () => undefined, err: (s) => err.push(s) },
    fetch,
    readFile: () => {
      throw new Error('no files');
    },
  };
  return { run: (...a: string[]) => runAom(a, ctx), reports, err };
}

describe('aom batch', () => {
  it('done, skip and fail report their outcome with the note', async () => {
    const c = await cli();
    expect(await c.run('batch', 'done', '--note', 'TOY-1 and TOY-2')).toBe(0);
    expect(await c.run('batch', 'skip', '--note', 'duplicate')).toBe(0);
    expect(await c.run('batch', 'fail', '--note', 'no access')).toBe(0);
    expect(c.reports.map((r) => [(r as any).outcomeId, (r as any).note])).toEqual([
      ['batch_done', 'TOY-1 and TOY-2'],
      ['batch_skip', 'duplicate'],
      ['batch_fail', 'no access'],
    ]);
  });

  it('ask sends the question, the options and the recommended option', async () => {
    const c = await cli();
    expect(
      await c.run(
        'batch',
        'ask',
        '--text',
        'Web or API?',
        '--option',
        'Web',
        '--option',
        'API',
        '--recommend',
        '1',
      ),
    ).toBe(0);
    expect(c.reports[0]).toMatchObject({
      outcomeId: 'batch_ask',
      data: { question: 'Web or API?', options: ['Web', 'API'], recommend: 1 },
    });
  });

  it('needs a verb, a question text and a reason for fail', async () => {
    const c = await cli();
    expect(await c.run('batch')).not.toBe(0);
    expect(await c.run('batch', 'ask')).not.toBe(0);
    expect(await c.run('batch', 'fail')).not.toBe(0);
    expect(c.reports).toEqual([]);
  });
});
