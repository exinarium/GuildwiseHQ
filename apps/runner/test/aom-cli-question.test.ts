import type { ShiftReport } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, parseArgs, runAom } from '../src/aom/aom-cli.ts';
import { IpcServer } from '../src/ipc/server.ts';

const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

interface Status {
  state: string;
  remainingMs: number;
  answer?: string;
  keepBlockedUntil?: string;
}

/** An IPC server whose `question.status` replies come from `statuses` (the last one repeats). */
async function setup(statuses: Status[] = []) {
  const reports: ShiftReport[] = [];
  const rpcs: Array<{ method: string; params: unknown }> = [];
  const ipc = new IpcServer();
  servers.push(ipc);
  await ipc.start();
  let polled = 0;
  const token = ipc.registerShift({
    report: async (r) => {
      reports.push(r.report);
      return { accepted: true, message: 'Recorded.' } as never;
    },
    rpc: async (r) => {
      rpcs.push({ method: r.method, params: r.params });
      if (r.method === 'question.status') {
        const s = statuses[Math.min(polled, statuses.length - 1)] ?? { state: 'open', remainingMs: 600_000 };
        polled++;
        return { ok: true, result: s };
      }
      if (r.method === 'card.depend')
        return { ok: true, result: { added: true, message: 'TOY-2 now depends on TOY-1.' } };
      return { ok: true, result: { ref: 'TOY-2', stage: 'build' } };
    },
  });
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const ctx: AomContext = {
    env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    fetch,
    readFile: () => {
      throw new Error('ENOENT');
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  const run = (...argv: string[]) => runAom(argv, ctx);
  return { run, reports, rpcs, out, err, sleeps };
}

describe('aom question: topic and keep-blocked-until', () => {
  it('sends the topic and rejects an unknown one', async () => {
    const t = await setup();
    expect(await t.run('question', '--text', 'Is the app up?', '--topic', 'environment')).toBe(0);
    expect(t.reports[0]).toMatchObject({
      kind: 'question',
      topic: 'environment',
      blocking: true,
      wait: false,
    });
    expect(await t.run('question', '--text', 'x', '--topic', 'weather')).toBe(1);
    expect(t.err.join('')).toMatch(/--topic must be one of/);
  });

  it('aom answer --keep-blocked-until sends the condition', async () => {
    const t = await setup();
    const item = '0190b2d4-8a3e-7c5b-9f1e-2a4b6c8d0e1f';
    expect(
      await t.run(
        'answer',
        '--item',
        item,
        '--text',
        'Wait for TOY-1',
        '--keep-blocked-until',
        'TOY-1 merged',
      ),
    ).toBe(0);
    expect(t.reports[0]).toMatchObject({ kind: 'answer', itemId: item, keepBlockedUntil: 'TOY-1 merged' });
    expect(await t.run('answer', '--item', item, '--text', 'Go on')).toBe(0);
    expect(t.reports[1]).not.toHaveProperty('keepBlockedUntil');
  });
});

describe('aom card facts and aom block', () => {
  it('card facts asks the server (optionally about another card)', async () => {
    const t = await setup();
    expect(await t.run('card', 'facts')).toBe(0);
    expect(await t.run('card', 'facts', 'TOY-1')).toBe(0);
    expect(t.rpcs).toEqual([
      { method: 'card.facts', params: {} },
      { method: 'card.facts', params: { ref: 'TOY-1' } },
    ]);
    expect(JSON.parse(t.out[0] ?? '{}').ref).toBe('TOY-2');
  });

  it('block --on dependency records a dependency through card.depend', async () => {
    const t = await setup();
    expect(await t.run('block', '--on', 'dependency', 'TOY-1')).toBe(0);
    expect(t.rpcs).toEqual([{ method: 'card.depend', params: { on: 'TOY-1' } }]);
    expect(t.out.join('')).toContain('TOY-2 now depends on TOY-1');
    expect(await t.run('block', '--on', 'dependency', 'TOY-1', '--card', 'TOY-3')).toBe(0);
    expect(t.rpcs[1]).toEqual({ method: 'card.depend', params: { on: 'TOY-1', card: 'TOY-3' } });
    // anything but a dependency is not available, and a reference is required
    expect(await t.run('block', '--on', 'time', '4h')).toBe(2);
    expect(await t.run('block', '--on', 'dependency')).toBe(1);
  });
});

describe('aom question --wait', () => {
  it('parses an optional duration', () => {
    expect(parseArgs(['--text', 'x', '--wait', '10m'], 'question').flags.get('wait')).toEqual(['10m']);
    expect(parseArgs(['--wait', '--text', 'x'], 'question').flags.get('wait')).toEqual(['true']);
    expect(parseArgs(['--text', 'x', '--wait'], 'question').flags.get('wait')).toEqual(['true']);
    // `aom run step --wait` keeps its boolean meaning
    expect(parseArgs(['--wait', 'x'], 'run').flags.get('wait')).toEqual(['true']);
  });

  it('raises a non-blocking waiting question, polls and prints the answer', async () => {
    const t = await setup([
      { state: 'open', remainingMs: 600_000 },
      { state: 'open', remainingMs: 600_000 },
      { state: 'answered', remainingMs: 600_000, answer: 'Use tabs.' },
    ]);
    expect(await t.run('question', '--text', 'Tabs or spaces?', '--wait')).toBe(0);
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]).toMatchObject({ kind: 'question', blocking: false, wait: true, converts: false });
    expect(t.sleeps).toEqual([15_000, 15_000]);
    expect(t.out.join('')).toContain('Answer: Use tabs.');
    expect(t.out.join('')).toContain('Continue with your work.');
  });

  it('turns the question into a blocking one when the time is up', async () => {
    const t = await setup([{ state: 'open', remainingMs: 600_000 }]);
    expect(await t.run('question', '--text', 'Tabs or spaces?', '--wait', '1m')).toBe(0);
    // 15 s polls until the minute is used up, then one converting report
    expect(t.sleeps).toEqual([15_000, 15_000, 15_000, 15_000]);
    expect(t.reports.map((r) => (r as { converts?: boolean }).converts)).toEqual([false, true]);
    expect(t.reports[1]).toMatchObject({ kind: 'question', blocking: true, converts: true });
  });

  it('never waits longer than the shift has left', async () => {
    const t = await setup([
      { state: 'open', remainingMs: 20_000 },
      { state: 'open', remainingMs: 5_000 },
      { state: 'open', remainingMs: 0 },
    ]);
    expect(await t.run('question', '--text', 'Tabs or spaces?', '--wait')).toBe(0);
    expect(t.sleeps).toEqual([15_000, 5_000]);
    expect(t.reports[1]).toMatchObject({ converts: true });
  });

  it('converts at once when only the manager can answer', async () => {
    const t = await setup([{ state: 'unattended', remainingMs: 600_000 }]);
    expect(await t.run('question', '--text', 'Tabs or spaces?', '--wait')).toBe(0);
    expect(t.sleeps).toEqual([]);
    expect(t.reports[1]).toMatchObject({ converts: true, blocking: true });
  });

  it('stops when the card was parked by the server', async () => {
    const t = await setup([{ state: 'parked', remainingMs: 600_000 }]);
    expect(await t.run('question', '--text', 'Tabs or spaces?', '--wait')).toBe(0);
    expect(t.reports).toHaveLength(1);
    expect(t.out.join('')).toContain('parked');
  });

  it('reports a kept park from the answer', async () => {
    const t = await setup([
      { state: 'answered', remainingMs: 1, answer: 'Not yet.', keepBlockedUntil: 'TOY-1 merged' },
    ]);
    expect(await t.run('question', '--text', 'Can I build?', '--wait')).toBe(0);
    expect(t.out.join('')).toContain('stays parked until: TOY-1 merged');
  });

  it('refuses --wait together with --non-blocking', async () => {
    const t = await setup();
    expect(await t.run('question', '--text', 'x', '--wait', '--non-blocking')).toBe(1);
    expect(t.reports).toHaveLength(0);
  });
});
