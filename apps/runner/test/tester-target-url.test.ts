import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

/** A tester shift on a regression card of a phase follow-up: the suite runs against the deployed app. */
async function envOf(stage: 'test' | 'build', fields: Record<string, unknown>) {
  const adapter = new ScriptedAdapter(async (_i, ctl) => {
    await ctl.post('/v1/report', {
      report: {
        kind: 'outcome',
        outcomeId: stage === 'test' ? 'pass' : 'handoff',
        note: 'ok',
        data: stage === 'test' ? { summary: 'ok', commands: [], outputExcerpt: '' } : {},
      },
    });
  });
  h = await startHarness({}, { adapters: new Map([['mock', adapter]]), envChecker: async () => null });
  await h.runShift({ stage, fields, mode: 'create' });
  return adapter.inputs[0]?.env ?? {};
}

describe('AOM_TARGET_URL', () => {
  it('a tester gets the target URL of the card as an environment variable', async () => {
    const env = await envOf('test', { targetUrl: 'http://localhost:4601' });
    expect(env.AOM_TARGET_URL).toBe('http://localhost:4601');
  });

  it('is not set without a target URL, and never for other roles', async () => {
    expect((await envOf('test', {})).AOM_TARGET_URL).toBeUndefined();
    await h?.stop();
    h = undefined;
    expect((await envOf('build', { targetUrl: 'http://localhost:4601' })).AOM_TARGET_URL).toBeUndefined();
  });
});
