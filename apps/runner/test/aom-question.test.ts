import type { ShiftReport } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();
const servers: IpcServer[] = [];
let h: Harness | undefined;
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  await h?.stop();
  h = undefined;
});

const match = {
  id: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  scope: 'decision',
  title: 'Indentation',
  body: 'Use tabs.',
};

async function cli(verdict: (r: ShiftReport) => unknown) {
  const reports: ShiftReport[] = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  const token = ipc.registerShift({
    report: async (r) => {
      reports.push(r.report);
      return verdict(r.report) as never;
    },
    rpc: async () => ({ ok: true, result: { entries: [match] } }),
  });
  const out: string[] = [];
  const err: string[] = [];
  const ctx: AomContext = {
    env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    fetch,
    readFile: () => '',
  };
  return { run: (...a: string[]) => runAom(a, ctx), reports, out, err };
}

describe('aom question', () => {
  it('sends a blocking question with options, recommendation and what it was doing; prints the server message', async () => {
    const t = await cli(() => ({
      accepted: true,
      message: 'Recorded. The card is now Blocked and your question is on the manager desk.',
    }));
    const code = await t.run(
      'question',
      '--text',
      'Tabs or spaces?',
      '--option',
      'tabs',
      '--option',
      'spaces',
      '--recommend',
      '0',
      '--doing',
      'writing the formatter',
    );
    expect(code).toBe(0);
    expect(t.reports).toEqual([
      {
        kind: 'question',
        text: 'Tabs or spaces?',
        options: ['tabs', 'spaces'],
        recommend: 0,
        doing: 'writing the formatter',
        blocking: true,
        force: false,
      },
    ]);
    expect(t.out.join('')).toContain('now Blocked');
  });

  it('--non-blocking and --force are passed through', async () => {
    const t = await cli(() => ({ accepted: true, message: 'Recorded.' }));
    expect(await t.run('question', '--text', 'Colour?', '--non-blocking', '--force')).toBe(0);
    expect(t.reports[0]).toMatchObject({ blocking: false, force: true, options: [] });
  });

  it('a duplicate check rejection prints the ledger matches once and exits 1', async () => {
    const error = `The ledger already has similar entries. Use --force.\n- [decision] Indentation (id ${match.id})\n  Use tabs.`;
    const t = await cli(() => ({
      accepted: false,
      message: `Report rejected: ${error}`,
      error,
      matches: [match],
    }));
    expect(await t.run('question', '--text', 'Tabs?', '--non-blocking')).toBe(1);
    const err = t.err.join('');
    expect(err).toContain('[decision] Indentation');
    expect(err.match(/Use tabs\./g)).toHaveLength(1);
  });

  it('requires --text', async () => {
    const t = await cli(() => ({ accepted: true, message: 'x' }));
    expect(await t.run('question', '--option', 'a')).toBe(1);
    expect(t.err.join('')).toContain('--text');
  });
});

describe('aom ledger search', () => {
  it('prints the matching entries', async () => {
    const t = await cli(() => ({ accepted: true, message: 'x' }));
    expect(await t.run('ledger', 'search', 'tabs', '--scope', 'decision')).toBe(0);
    expect(t.out.join('')).toContain('[decision] Indentation');
    expect(t.out.join('')).toContain('Use tabs.');
  });
});

describe('questions through the runner', () => {
  it('a mock builder with {"build":["question","ok"]} asks, ends its shift as reported, then hands off next time', async () => {
    h = await startHarness({
      reportResult: (m) =>
        m.report.kind === 'question'
          ? {
              accepted: true,
              message: 'Recorded. Card Blocked; question on the desk. Finish now.',
              matches: [match],
            }
          : { accepted: true },
    });
    const mock = { build: ['question', 'ok'] };
    const first = await h.runShift({ stage: 'build', mock });
    expect(first.ended.outcome).toBe('reported');
    const q = h.server.of('shift.report').find((r) => r.shiftId === first.shiftId);
    expect(q?.report).toMatchObject({
      kind: 'question',
      text: 'Mock question for TOY-1?',
      options: ['yes', 'no'],
      recommend: 0,
      doing: 'mock build',
      blocking: true,
    });
    expect(first.ended.finalText).toContain('Card Blocked');
    expect(h.server.invalid).toEqual([]);

    const second = await h.runShift({ stage: 'build', mock });
    expect(second.ended.outcome).toBe('reported');
    expect(h.server.of('shift.report').find((r) => r.shiftId === second.shiftId)?.report).toMatchObject({
      kind: 'outcome',
      outcomeId: 'handoff',
    });
  }, 120_000);

  it('a blocking question is terminal (a second report is refused); a non-blocking one is not', async () => {
    const seen: any = {};
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      seen.soft = await ctl.post('/v1/report', {
        report: { kind: 'question', text: 'small thing?', options: [], doing: '', blocking: false },
      });
      seen.hard = await ctl.post('/v1/report', {
        report: {
          kind: 'question',
          text: 'big thing?',
          options: ['a'],
          recommend: 0,
          doing: 'x',
          blocking: true,
        },
      });
      seen.after = await ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'handoff', note: 'n', data: {} },
      });
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    const { ended } = await h.runShift({ stage: 'build' });
    expect(seen.soft.status).toBe(200);
    expect(seen.soft.json.message).toBe('Recorded.');
    expect(seen.hard.status).toBe(200);
    expect(seen.hard.json.message).toContain('Finish now');
    expect(seen.after.status).toBe(409);
    expect(ended.outcome).toBe('reported');
  });

  it('a rejected question returns the matches to the agent so it can retry in the same shift', async () => {
    const seen: any = {};
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      seen.first = await ctl.post('/v1/report', {
        report: { kind: 'question', text: 'tabs?', options: [], doing: '', blocking: false },
      });
      seen.forced = await ctl.post('/v1/report', {
        report: { kind: 'question', text: 'tabs?', options: [], doing: '', blocking: false, force: true },
      });
    });
    h = await startHarness(
      {
        reportResult: (m) =>
          m.report.kind === 'question' && !(m.report as { force?: boolean }).force
            ? { accepted: false, error: 'similar entries exist; use --force', matches: [match] }
            : { accepted: true },
      },
      { adapters: new Map([['mock', adapter]]) },
    );
    await h.runShift({ stage: 'build' });
    expect(seen.first.status).toBe(422);
    expect(seen.first.json.matches).toEqual([match]);
    expect(seen.forced.status).toBe(200);
  });
});
