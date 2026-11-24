import { join } from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { q, waitFor } from '../../support/db.ts';
import { E2E_DIR } from '../../support/env.ts';
import { commitCount, makeRemote, pushToMain, type Remote, revParse } from '../fixtures/remotes.ts';
import { addRepo, createCard, createProject, deskItems, hire, newOwner, person } from '../support/flow.ts';
import { type Host, startHost } from '../support/host.ts';

// A9 (round 3 item 9): an empty bare repository (HEAD -> master, working branch main): one desk item and no repeated
// worktree_failed; "Create the first commit on main" pushes one commit and the cards start; a second click, or a push in
// between, is a plain refusal and nothing is forced.
test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;
let host: Host;
let remote: Remote;
let remote2: Remote;
let projectId: string;
let repoId: string;
let project2: string;
let repo2: string;
const refs: string[] = [];
const OWNER = person('a9owner');

test.afterAll(async () => {
  await host?.stop();
});

const rejectedPerCard = (cards: string[]) =>
  q<{ ref: string; n: number }>(
    `SELECT c.ref, count(*)::int AS n FROM shifts s JOIN cards c ON c.id=s.card_id
      WHERE c.ref = ANY($1) AND s.outcome='rejected' GROUP BY c.ref`,
    [cards],
  );

test('[A9] setup: two empty bare repositories (HEAD -> master, working branch main), a project on each, three cards on the first', async () => {
  api = await newOwner(OWNER);
  const roots = join(E2E_DIR, 'combined', 'a9-repos');
  remote = makeRemote('empty', null, roots);
  remote2 = makeRemote('empty2', null, roots);
  expect(commitCount(remote.origin, 'HEAD')).toBe(0);
  host = await startHost(api, { password: OWNER.password, name: 'a9-box', repoRoot: roots });
  projectId = await createProject(api, 'EMP', 'Empty repo project');
  repoId = await addRepo(api, projectId, remote.origin, 'empty');
  project2 = await createProject(api, 'EM2', 'Second empty repo project');
  repo2 = await addRepo(api, project2, remote2.origin, 'empty2');
  for (const p of [projectId, project2])
    await hire(api, {
      name: p === projectId ? 'Bo' : 'Bea',
      roleKey: 'builder',
      workstationId: host.workstationId,
      projectId: p,
    });
  for (const t of ['One', 'Two', 'Three'])
    refs.push(await createCard(api, { projectId, repoId, title: `Card ${t}` }));
  expect(refs).toHaveLength(3);
});

test('[A9] one desk item for the empty repository, and no worktree_failed shift after another', async () => {
  const items = await waitFor(
    'the empty-repository desk item',
    () => deskItems('repo_empty', projectId),
    (r) => r.filter((x) => x.status === 'open').length >= 1,
    90_000,
  );
  expect(items.filter((x) => x.status === 'open')).toHaveLength(1);
  expect(items[0]?.title).toContain('has no commits yet');
  // an environment check again (the dispatcher keeps trying the cards meanwhile): wait for it, then count
  const before =
    (await q<{ n: number }>(`SELECT count(*)::int AS n FROM events WHERE type='EnvironmentPrepared'`))[0]
      ?.n ?? 0;
  expect(
    (await api.post(`/api/projects/${projectId}/environment/check`, { data: {} })).status(),
  ).toBeLessThan(300);
  await waitFor(
    'the environment was checked again',
    () => q<{ n: number }>(`SELECT count(*)::int AS n FROM events WHERE type='EnvironmentPrepared'`),
    (r) => (r[0]?.n ?? 0) > before,
    60_000,
  );
  for (const r of await rejectedPerCard(refs)) expect(r.n, `${r.ref} rejected shifts`).toBeLessThanOrEqual(1);
  const cards = await q<{ ref: string; retry_failures: number }>(
    `SELECT ref, retry_failures FROM cards WHERE ref = ANY($1)`,
    [refs],
  );
  for (const c of cards) expect(c.retry_failures, `${c.ref} retry failures`).toBeLessThanOrEqual(1);
  // still exactly one open item (a repeat of the finding adds nothing), and no storm item
  expect((await deskItems('repo_empty', projectId)).filter((x) => x.status === 'open')).toHaveLength(1);
  const all = await deskItems(undefined, projectId);
  expect(all.filter((d) => d.status === 'open')).toHaveLength(1);
});

test('[A9] one click makes the one first commit on main and the cards start', async () => {
  const res = await api.post(`/api/projects/${projectId}/repos/${repoId}/initial-commit`, {
    data: { workstationId: host.workstationId },
  });
  expect(res.status(), await res.text()).toBe(200);
  await waitFor(
    'one commit on origin main',
    async () => commitCount(remote.origin, 'main'),
    (n) => n === 1,
    60_000,
  );
  await waitFor(
    'the desk item closed',
    () => deskItems('repo_empty', projectId),
    (r) => r.every((x) => x.status !== 'open'),
    30_000,
  );
  await waitFor(
    'the cards started',
    () =>
      q<{ n: number }>(
        `SELECT count(*)::int AS n FROM shifts s JOIN cards c ON c.id=s.card_id WHERE c.ref = ANY($1)`,
        [refs],
      ),
    (r) => (r[0]?.n ?? 0) >= 1,
    120_000,
  );
});

test('[A9] a second click is a plain refusal and adds no commit', async () => {
  const sha = revParse(remote.origin, 'main');
  const second = await api.post(`/api/projects/${projectId}/repos/${repoId}/initial-commit`, {
    data: { workstationId: host.workstationId },
  });
  expect(second.status()).toBe(409);
  expect(await second.text()).toContain('not reported empty');
  expect(revParse(remote.origin, 'main')).toBe(sha);
  expect(commitCount(remote.origin, 'main')).toBe(1);
});

test('[A9] someone pushes first: the click is refused, the pushed commit stays, nothing is forced', async () => {
  const item = await waitFor(
    'the second repository is reported empty',
    () => deskItems('repo_empty', project2),
    (r) => r.some((x) => x.status === 'open'),
    90_000,
  );
  expect(item.filter((x) => x.status === 'open')).toHaveLength(1);
  // another person pushes before the click (the runner has not looked again: the item is still open)
  const theirs = pushToMain(remote2, 'README.md', '# theirs\n', 'Their first commit');
  const click = await api.post(`/api/projects/${project2}/repos/${repo2}/initial-commit`, {
    data: { workstationId: host.workstationId },
  });
  expect(click.status(), await click.text()).toBe(200);
  // the runner refuses (the repository has a commit by now): the old item closes and a new one says why
  const after = await waitFor(
    'a refusal item that says why',
    () => deskItems('repo_empty', project2),
    (r) => r.some((x) => x.status === 'open' && /first commit was not made/i.test(x.body)),
    60_000,
  );
  expect(after.filter((x) => x.status === 'open')).toHaveLength(1);
  expect(revParse(remote2.origin, 'main')).toBe(theirs);
  expect(commitCount(remote2.origin, 'main')).toBe(1);
});
