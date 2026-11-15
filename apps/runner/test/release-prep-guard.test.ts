import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';
import { makeDevopsStart } from './vault-fixtures.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

/** A release_prep shift start for a DevOps (or, with `isDevops: false`, another) agent. */
function prepStart(o: { releaseBranch?: string; isDevops?: boolean } = {}): Record<string, unknown> {
  const base = makeDevopsStart({ summary: 'prep' }) as {
    brief: { shift: Record<string, unknown> };
    agent: Record<string, unknown>;
  };
  return {
    ...base,
    kind: 'release_prep',
    devops: undefined,
    brief: { ...base.brief, shift: { ...base.brief.shift, kind: 'release_prep', stage: 'release_prep' } },
    agent: { ...base.agent, isDevops: o.isDevops ?? true },
    releasePrep: {
      taskId: uuidv7(),
      runId: uuidv7(),
      repoId: uuidv7(),
      step: 'changelog',
      phase: 'write',
      remoteUrlNormalized: 'github.com/acme/none',
      workRef: 'refs/guildwise/docs-prep/run/work',
      startSha: 'a'.repeat(40),
      ...(o.releaseBranch ? { releaseBranch: o.releaseBranch } : {}),
      task: { kind: 'new_video', slug: 'forms', title: 'Forms', pages: [], cards: [] },
      writable: ['docs/help/a.md'],
    },
  };
}

async function reject(start: Record<string, unknown>) {
  const adapter = new ScriptedAdapter(async () => ({}));
  h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
  h.server.send('shift.start', start);
  const msg = await h.server.waitFor('shift.rejected', (m) => m.shiftId === start.shiftId, 30_000);
  return { msg, adapter };
}

describe('release_prep shift of a DevOps agent: the guard is never skipped', () => {
  it('without the release branch it is rejected naming the branch, with no worktree and no session', async () => {
    const { msg, adapter } = await reject(prepStart());
    expect(msg.reason).toBe('internal');
    expect(msg.detail ?? '').toContain('release branch');
    expect(adapter.inputs).toEqual([]);
    expect(existsSync(join(h!.dataDir, 'worktrees'))).toBe(false);
  });

  it('a release_prep shift of a non-DevOps agent is judged as before (no release-branch rule)', async () => {
    const { msg } = await reject(prepStart({ isDevops: false }));
    expect(msg.reason).toBe('repo_missing');
  });
});
