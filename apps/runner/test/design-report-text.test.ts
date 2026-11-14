import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, sh } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const REPORT = 'docs/investigations/TOY-1-add-greeting.md';
const TEXT = '# TOY-1\n\n## Design\n\nAdd the greeting in the greeting module.\n';
const investigation = {
  reportPath: REPORT,
  location: 'repo' as const,
  folder: 'docs/investigations',
  investigationOnly: false,
  mergeMainFirst: false,
};
const handoff = {
  report: {
    kind: 'outcome',
    outcomeId: 'handoff',
    note: 'done',
    data: { reportPath: REPORT, summary: 'Build it in the greeting module.', location: 'repo' },
  },
};

async function start(script: ConstructorParameters<typeof ScriptedAdapter>[0]) {
  h = await startHarness({}, { adapters: new Map([['mock', new ScriptedAdapter(script)]]) });
}

describe('design gate: the runner attaches the committed design report text', () => {
  it('a committed repository report carries its full text for the owner to read at the gate', async () => {
    await start(async (i, ctl) => {
      mkdirSync(dirname(join(i.cwd, REPORT)), { recursive: true });
      writeFileSync(join(i.cwd, REPORT), TEXT);
      sh(i.cwd, 'git', ['add', '-A']);
      sh(i.cwd, 'git', ['commit', '-m', 'design report']);
      const r = await ctl.post('/v1/report', handoff);
      expect(r.status).toBe(200);
    });
    const { shiftId, ended } = await h!.runShift({
      stage: 'investigate',
      briefExtra: { investigation },
    });
    expect(ended.outcome).toBe('reported');
    const rep = h!.server.of('shift.report').find((r) => r.shiftId === shiftId);
    const sent = (rep?.report as { data?: Record<string, unknown> } | undefined)?.data ?? {};
    expect(sent).toMatchObject({ reportPath: REPORT, location: 'repo', reportText: TEXT });
    // the text is for reading only: nothing for the builder to commit later
    expect(sent.body).toBeUndefined();
  });
});
