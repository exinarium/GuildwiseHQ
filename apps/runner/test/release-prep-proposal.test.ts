import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PREP_PROPOSAL_FILE, type ReleasePrepShift, writableFilesFor } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { finishPrepProposal } from '../src/git/release-prep-proposal.ts';
import { addPrepTaskWorktree, removePrepTaskWorktree } from '../src/git/release-prep-task.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const GUIDE = [
  '# Guide',
  '',
  '<!-- toc -->',
  '**Contents**',
  '',
  '- [4. Delivery](#4-delivery)',
  '  - [4.28 Releases](#428-releases)',
  '',
  '<!-- /toc -->',
  '',
  '## 4. Delivery',
  '',
  '### 4.28 Releases',
  '',
  'The **Releases** page lists each version.',
  '',
].join('\n');

function put(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const ID = (n: number) => `019e3f6a-7b1c-7a2d-8c3e-01234567890${n}`;
const GUIDE_TASK = {
  kind: 'guide_edits' as const,
  guidePath: 'docs/USER-GUIDE.md',
  changes: [{ sources: ['card:GWP-89'], title: 'Release prep', subjects: [], files: [], areas: [], routes: [], hints: [] }],
  coveredSources: [],
};
const CHANGELOG_TASK = {
  kind: 'changelog_entries' as const,
  projectName: 'Toy',
  repoName: 'toy',
  releaseBranch: 'release/1.5.0',
  changes: [],
  existing: [],
};

async function setup(task: typeof GUIDE_TASK | typeof CHANGELOG_TASK) {
  const repo = makeRepo();
  put(repo.clone, 'docs/USER-GUIDE.md', GUIDE);
  put(repo.clone, 'CHANGELOG.md', '# Changelog\n');
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', 'chore: start']);
  sh(repo.clone, 'git', ['push', 'origin', 'main']);
  const head = sh(repo.clone, 'git', ['rev-parse', 'HEAD']);
  const rp: ReleasePrepShift = {
    taskId: ID(5),
    runId: ID(1),
    repoId: ID(3),
    step: 'x',
    phase: 'write',
    remoteUrlNormalized: repo.remoteNormalized,
    workRef: `refs/guildwise/docs-prep/${ID(1)}/work`,
    startSha: head,
    task,
    writable: writableFilesFor(task),
  };
  const wt = await addPrepTaskWorktree(repo.clone, rp, join(tmp('aom-wt-'), 'task'));
  return { repo, rp, wt };
}

const GOOD_EDITS = {
  edits: [{ op: 'append', section: '4.28', text: '**Release prep.** Run it before you approve.', sources: ['card:GWP-89'] }],
};

describe('finishPrepProposal', () => {
  it('accepts a valid guide proposal and commits nothing', async () => {
    const { rp, wt, repo } = await setup(GUIDE_TASK);
    put(wt.path, PREP_PROPOSAL_FILE, JSON.stringify(GOOD_EDITS));
    const r = await finishPrepProposal(wt, rp);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.proposal as { edits: unknown[] }).edits).toHaveLength(1);
    expect(sh(repo.clone, 'git', ['for-each-ref', rp.workRef])).toBe('');
    await removePrepTaskWorktree(wt);
  });

  it('refuses edits that break the guide, with the checkGuideUpdate findings', async () => {
    const { rp, wt } = await setup(GUIDE_TASK);
    put(wt.path, PREP_PROPOSAL_FILE, JSON.stringify({ edits: [{ op: 'append', section: '9.9', text: 'x', sources: [] }] }));
    const r = await finishPrepProposal(wt, rp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.findings.join()).toMatch(/9\.9/);
    await removePrepTaskWorktree(wt);
  });

  it('refuses a guide edit that damages the table of contents', async () => {
    const { rp, wt } = await setup(GUIDE_TASK);
    put(
      wt.path,
      PREP_PROPOSAL_FILE,
      JSON.stringify({
        edits: [{ op: 'replace_text', section: '4.28', find: 'The **Releases** page', replace: '### 4.30 Extra\n\nThe page', sources: [] }],
      }),
    );
    const r = await finishPrepProposal(wt, rp);
    expect(r.ok).toBe(false);
    await removePrepTaskWorktree(wt);
  });

  it('refuses a changed file other than the proposal', async () => {
    const { rp, wt } = await setup(GUIDE_TASK);
    put(wt.path, PREP_PROPOSAL_FILE, JSON.stringify(GOOD_EDITS));
    put(wt.path, 'docs/USER-GUIDE.md', 'oops');
    const r = await finishPrepProposal(wt, rp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.findings[0]).toContain('docs/USER-GUIDE.md');
    await removePrepTaskWorktree(wt);
  });

  it('refuses invalid JSON and a missing file', async () => {
    const { rp, wt } = await setup(GUIDE_TASK);
    const none = await finishPrepProposal(wt, rp);
    expect(none.ok).toBe(false);
    put(wt.path, PREP_PROPOSAL_FILE, '{ nope');
    const bad = await finishPrepProposal(wt, rp);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.findings[0]).toContain('not valid JSON');
    await removePrepTaskWorktree(wt);
  });

  it('a changelog proposal is only shape-checked here (the server does the deep checks)', async () => {
    const { rp, wt } = await setup(CHANGELOG_TASK);
    put(
      wt.path,
      PREP_PROPOSAL_FILE,
      JSON.stringify({ entries: [{ heading: 'Added', text: 'A thing.', sources: ['s1'] }], covered: [], skipped: [] }),
    );
    const ok = await finishPrepProposal(wt, rp);
    expect(ok.ok).toBe(true);
    put(wt.path, PREP_PROPOSAL_FILE, JSON.stringify({ entries: 'nope' }));
    const bad = await finishPrepProposal(wt, rp);
    expect(bad.ok).toBe(false);
    await removePrepTaskWorktree(wt);
  });
});
