import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { computeCardDiff } from '../../../apps/runner/src/git/card-diff.ts';
import { q, waitFor } from '../../support/db.ts';
import { git, makeRemote, pushToMain, type Remote } from '../fixtures/remotes.ts';
import {
  addRepo,
  createCard,
  createProject,
  hire,
  newOwner,
  person,
  progressText,
  waitBuilt,
  waitCard,
} from '../support/flow.ts';
import { type Host, startHost } from '../support/host.ts';
import { PLACEHOLDERS } from '../support/scenario-adapter.ts';

// A7 (round 3 item 7): the architect hands over with the sandbox's empty placeholder files in its worktree: no
// architect_edited_non_docs, no stub in the WIP commit or the reviewer diff.
// A8 (round 3 item 8): the card branch already carries a commit of empty .idea/.vscode (f6179b8); a builder shift that
// ends with them gone has no tree_revert; and finalize after `main` moved rebases and merges.
// The scripted agent PLAYS the sandbox here (it writes or removes the stubs itself); the runner, guard, auto-commit,
// diff and server around it are the product's. The real-sandbox lane of A7 is a-real-sandbox.spec.ts.
test.describe.configure({ mode: 'serial' });

const OWNER = person('a78owner');
let api: APIRequestContext;
let host: Host;
let remote: Remote;
let projectId: string;
let repoId: string;
let workstationId: string;

test.afterAll(async () => {
  await host?.stop();
});

const worktreeOf = (key: string, ref: string): string => {
  const root = join(host.home, 'worktrees');
  const dir = existsSync(root) ? readdirSync(root).find((d) => d.startsWith(`${key}-`)) : undefined;
  return join(root, dir ?? key, ref);
};
const branchesOf = (): string[] =>
  git(remote.clone, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter((b) => b && b !== 'main');
const trackedOn = (branch: string): string[] =>
  git(remote.clone, 'ls-tree', '-r', '--name-only', branch).split('\n').filter(Boolean);
const stubsIn = (files: string[]): string[] =>
  files.filter((f) => PLACEHOLDERS.some((p) => f === p || f.startsWith(`${p}/`)));

test('[A7] setup: a plain-git project with a builder, a reviewer and an architect, the design step on', async () => {
  api = await newOwner(OWNER);
  remote = makeRemote('placeholders', { 'README.md': '# toy\n', 'index.js': "console.log('toy');\n" });
  host = await startHost(api, { password: OWNER.password, name: 'a78-box', repoRoot: remote.repoRoot });
  workstationId = host.workstationId;
  projectId = await createProject(api, 'PLH', 'Placeholders project');
  const s = await api.put(`/api/projects/${projectId}/architect-settings`, {
    data: {
      designStep: true,
      mergeMainFirst: true,
      investigationPath: 'docs/investigations',
      investigationLocation: 'repo',
    },
  });
  expect(s.status(), await s.text()).toBe(200);
  repoId = await addRepo(api, projectId, remote.origin, 'placeholders');
  for (const [name, roleKey, seniority] of [
    ['Bo', 'builder', 'junior'],
    ['Rae', 'reviewer', 'senior'],
    ['Tess', 'tester', 'junior'],
    ['Aria', 'architect', 'senior'],
    ['Ben', 'ba', 'senior'],
  ] as const)
    await hire(api, { name, roleKey, seniority, workstationId, projectId });
  await waitFor(
    'the workstation holds the repo',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n === 1,
    60_000,
  );
});

test('[A7] the architect hands over with the 0-byte stubs in its worktree: accepted, no stub in the WIP commit or the reviewer diff', async () => {
  const ref = await createCard(api, {
    projectId,
    repoId,
    title: 'Design with stubs [scn:stubs]',
    extra: { designNeeded: true },
  });
  // the scripted architect really ran (otherwise this check proves nothing)
  await waitFor(
    'the script wrote the stubs',
    () => progressText(ref),
    (t) => t.includes('scn: architect wrote'),
    60_000,
  );
  // the design handoff is accepted: the card leaves the investigate step for build
  await waitCard(
    ref,
    'past the design step',
    (c) => !!c && ['build', 'review', 'test', 'finalize'].includes(c.stage),
    180_000,
  );
  const refused = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM events WHERE payload::text LIKE '%architect_edited_non_docs%'`,
  );
  expect(refused[0]?.n, 'architect_edited_non_docs was raised').toBe(0);
  // the commit the report went in carries the docs, never a stub
  const branch = branchesOf().find((b) => b.toLowerCase().includes(ref.toLowerCase())) ?? branchesOf()[0];
  expect(branch, `card branch among ${branchesOf().join(', ')}`).toBeTruthy();
  const files = trackedOn(branch as string);
  expect(files.some((f) => f.startsWith('docs/investigations/'))).toBe(true);
  expect(stubsIn(files)).toEqual([]);
  // the reviewer's diff (the product's own function on the card worktree) lists no stub either
  const diff = await computeCardDiff(worktreeOf('PLH', ref), 'main');
  const text = JSON.stringify(diff);
  for (const p of PLACEHOLDERS)
    expect(text, `diff mentions ${p}`).not.toMatch(new RegExp(`["/ ]${p.replace('.', '\\.')}["/\\s]`));
  expect(text).toContain('docs/investigations');
  // and what the worktree shows is the stubs as untracked noise: the sandbox's, not the architect's work
});

test('[A8] a card branch that already carries committed stubs: the builder shift has no tree_revert and hands off', async () => {
  const ref = await createCard(api, {
    projectId,
    repoId,
    title: 'Stub commit [scn:a8]',
    extra: { designNeeded: false },
  });
  await waitBuilt(ref);
  expect(await progressText(ref), 'the scripted builder ran').toContain(
    'scn: stubs committed on the card branch',
  );
  // no "did not commit the leftovers" note (that is how a refused tree_revert / mass_deletion shows on the card)
  const notes = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM events WHERE payload::text LIKE '%tree_revert%' OR payload::text LIKE '%did not commit the leftovers%'`,
  );
  expect(notes[0]?.n, 'a refused leftovers commit was noted on the card').toBe(0);
  const wt = worktreeOf('PLH', ref);
  // nothing is left uncommitted in the worktree except the (untracked or removed) stubs
  const status = git(wt, 'status', '--porcelain').split('\n').filter(Boolean);
  expect(status.filter((l) => !PLACEHOLDERS.some((p) => l.includes(p)))).toEqual([]);
});

test('[A8] main moves while the card waits: the card still finalizes, rebased onto the new main', async () => {
  const ref = 'PLH-2';
  const theirs = pushToMain(remote, 'THEIRS.md', 'pushed by another person\n', 'Their change on main');
  await waitCard(ref, 'done', (c) => c?.status === 'done', 240_000);
  const tip = git(remote.origin, 'rev-parse', 'main').trim();
  expect(tip).not.toBe(theirs); // the card's work landed on top of theirs
  const onMain = git(remote.origin, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  expect(onMain).toContain('THEIRS.md');
  // The card's ONLY commit is the seeded stub commit (the scripted builder makes no other change), so it reaching main on top of
  // THEIRS.md is what shows the rebase and merge went through. The product does not remove stubs that an earlier commit
  // put on a branch (it only stops making or reverting them), so they travel with it: that is the seeded damage, not a defect.
  expect(onMain).toEqual(expect.arrayContaining(['.idea', '.vscode', 'THEIRS.md']));
  git(remote.origin, 'merge-base', '--is-ancestor', theirs, 'main'); // throws unless their commit is in main's history
});
