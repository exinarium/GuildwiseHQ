import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { latestMerge } from '../src/delivery/gate.ts';
import { automatedCommitAllowed, requestDeployRun } from '../src/delivery/runs.ts';
import { MIN_RUNNER_FOR_SUBMODULE_PIN } from '../src/delivery/submodule-pin.ts';
import { deliveryPass, queueMergeTrigger } from '../src/delivery/triggers.ts';
import { keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import {
  advance,
  type DeliveryWorld,
  deliveryWorld,
  mergeLanded,
  parseFixture,
  setWeekday,
} from './helpers/delivery.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { ok, until } from './helpers/world.ts';

/**
 * A merge only deploys its own repository, and a merge into a submodule moves the pin in the repository that contains it
 * (docs/ARCHITECTURE.md, delivery). The project has two repositories: `cloud` (D, deployed by the recipe, holds `toy` as a
 * submodule) and `toy` (X, where the cards merge, renamed `zcore` so that D is the first repository by name).
 */
let d: DeliveryWorld;
let r: FakeRunner;
let X: string;
let D: string;
const ctx = () => d.w.t.app.ctx;
const hex = (c: string) => c.repeat(40);

beforeAll(async () => {
  d = await deliveryWorld();
  r = await d.w.connectRunner({ capabilities: ['ceo:1', 'delivery:1'] });
  await keepOnline(d.w);
  await setWeekday(d);
  X = d.w.repoId;
  D = randomUUID();
  await q(`UPDATE project_repos SET name='zcore' WHERE id=$1`, [X]);
  await q(
    `INSERT INTO project_repos (id, project_id, name, remote_url, remote_url_normalized, working_branch, forge_kind)
     VALUES ($1,$2,'cloud','git@github.com:acme/cloud.git','github.com/acme/cloud','release/1.4.0','github')`,
    [D, d.w.projectId],
  );
  await q(
    `INSERT INTO workstation_repos (workstation_id, project_repo_id, local_path, reported_at) VALUES ($1,$2,'/tmp/cloud',now())`,
    [d.w.workstationId, D],
  );
  await setRunner(MIN_RUNNER_FOR_SUBMODULE_PIN);
  const o = await d.observe(parseFixture(), { commit: '9999999aaaaaaa' });
  await ok(d.approve(o.hash));
  await ok(
    d.w.t.req('PUT', `/api/projects/${d.w.projectId}/delivery/mode`, {
      cookie: d.w.owner.cookie,
      body: { mode: 'recipe' },
    }),
  );
});
afterAll(async () => {
  r.close();
  await d.w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await q('DELETE FROM deploy_trigger_queue');
  await q(
    `UPDATE deploy_runs SET status='failed', finished_at=now() WHERE status IN ('queued','running','requested','waiting_release')`,
  );
  await q(`UPDATE desk_items SET status='dismissed' WHERE subject_key LIKE 'submodule_pin:%'`);
  await setRunner(MIN_RUNNER_FOR_SUBMODULE_PIN);
});

const setRunner = (v: string) =>
  q('UPDATE workstations SET runner_version=$2 WHERE id=$1', [d.w.workstationId, v]);
const pins = () => r.of('command').filter((c) => c.command === 'repo.bump_submodule');
const execs = () => r.of('command').filter((c) => c.command === 'deploy.exec');
const notices = () =>
  q(`SELECT * FROM desk_items WHERE subject_key LIKE 'submodule_pin:%' AND status='open'`);

/** A card of `repoId` merged at `commit`, and the merge trigger queued as the gateway does. */
async function mergeIn(repoId: string, commit: string) {
  const card = await d.w.card({ title: `Merge ${commit.slice(0, 4)}` });
  await q('UPDATE cards SET repo_id=$1 WHERE id=$2', [repoId, card.id]);
  await mergeLanded(d, commit, card.id);
  expect(await queueMergeTrigger(ctx(), card.id, commit)).toBe(true);
  return card.id as string;
}
const settle = async () => {
  await advance(d, 3 * 60_000);
  await deliveryPass(ctx());
};
const answer = (cmd: { commandId: string }, result: unknown) =>
  r.send('command.result', { commandId: cmd.commandId, ok: true, result });

describe('a merge into a submodule moves the pin, then deploys the repository that holds it', () => {
  it('asks the runner to bump the pin (not to deploy the submodule commit); its answer deploys the returned commit', async () => {
    const before = execs().length;
    await mergeIn(X, hex('a'));
    await settle();
    await until(async () => pins().length === 1, 4000, 'repo.bump_submodule reached the runner');
    expect(pins()[0]!.payload).toMatchObject({
      projectId: d.w.projectId,
      repoId: D,
      remoteUrlNormalized: 'github.com/acme/cloud',
      workingBranch: 'release/1.4.0',
      sourceRepoId: X,
      submoduleRemoteUrlNormalized: 'github.com/acme/toy',
      commit: hex('a'),
      forge: 'github',
      envs: ['local'],
    });
    expect(execs()).toHaveLength(before); // nothing deployed yet
    answer(pins()[0]!, { ok: true, commit: hex('d'), path: 'core' });
    await until(async () => execs().length === before + 1, 4000, 'deploy of the pinned commit');
    expect(execs().at(-1)!.payload).toMatchObject({
      env: 'local',
      commit: hex('d'),
      repo: { repoId: D, workingBranch: 'release/1.4.0' },
    });
    expect(await q('SELECT 1 FROM deploy_trigger_queue')).toHaveLength(0);
  });

  it('an unchanged pin deploys the current head of the deploy repository', async () => {
    const before = execs().length;
    await mergeIn(X, hex('b'));
    await settle();
    await until(async () => pins().length === 2, 4000, 'second command');
    answer(pins().at(-1)!, { ok: true, unchanged: true, commit: hex('e') });
    await until(async () => execs().length === before + 1, 4000, 'deploy');
    expect(execs().at(-1)!.payload).toMatchObject({ commit: hex('e') });
  });

  it('a failure is a desk notice with the runner words, and nothing is deployed', async () => {
    const before = execs().length;
    const cmds = pins().length;
    await mergeIn(X, hex('c'));
    await settle();
    await until(async () => pins().length === cmds + 1, 4000, 'command');
    answer(pins().at(-1)!, {
      ok: false,
      error: 'main refused the push of the pin: GH006',
      protectedBranch: true,
    });
    await until(async () => (await notices()).length === 1, 4000, 'desk notice');
    const [n] = await notices();
    expect(n!.title).toContain('could not be updated');
    expect(n!.body).toContain('GH006');
    expect(n!.body).toContain('protected');
    await new Promise((res) => setTimeout(res, 200));
    expect(execs()).toHaveLength(before);
  });

  it('several merges in the window make one command with the newest merge commit', async () => {
    const cmds = pins().length;
    await mergeIn(X, hex('5'));
    await advance(d, 60_000);
    await mergeIn(X, hex('6'));
    await advance(d, 60_000);
    await deliveryPass(ctx()); // not due yet: the second merge pushed it back
    expect(pins()).toHaveLength(cmds);
    await settle();
    await until(async () => pins().length === cmds + 1, 4000, 'one command');
    await new Promise((res) => setTimeout(res, 200));
    expect(pins()).toHaveLength(cmds + 1);
    expect(pins().at(-1)!.payload).toMatchObject({ commit: hex('6') });
  });

  it('a repository that does not hold the merged one as a submodule is deployed as it is, with no commit of the other', async () => {
    const before = execs().length;
    const cmds = pins().length;
    await mergeIn(X, hex('9'));
    await settle();
    await until(async () => pins().length === cmds + 1, 4000, 'command');
    answer(pins().at(-1)!, {
      ok: false,
      notSubmodule: true,
      error: 'github.com/acme/cloud does not contain github.com/acme/toy as a submodule',
    });
    await until(async () => execs().length === before + 1, 4000, 'deploy of D as it is');
    expect(execs().at(-1)!.payload).toMatchObject({ commit: null, repo: { repoId: D } });
    expect(await notices()).toHaveLength(0);
  });

  it('an older runner gets no command: D is deployed as it is, and a notice says the pin was not moved', async () => {
    await setRunner('0.1.62');
    const before = execs().length;
    const cmds = pins().length;
    await mergeIn(X, hex('1'));
    await settle();
    await until(async () => execs().length === before + 1, 4000, 'deploy');
    expect(pins()).toHaveLength(cmds);
    expect(execs().at(-1)!.payload).toMatchObject({ commit: null, repo: { repoId: D } });
    const [n] = await notices();
    expect(n!.title).toContain('pin');
    expect(n!.body).toContain(MIN_RUNNER_FOR_SUBMODULE_PIN);
  });
});

describe('a merge is only deployed in its own repository', () => {
  it('latestMerge filters by the repository of the card', async () => {
    const x1 = hex('1');
    const d1 = hex('2');
    const x2 = hex('3');
    await mergeIn(X, x1);
    await mergeIn(D, d1);
    await mergeIn(X, x2);
    expect((await latestMerge(ctx().pool, d.w.projectId))?.commit).toBe(x2);
    expect((await latestMerge(ctx().pool, d.w.projectId, X))?.commit).toBe(x2);
    expect((await latestMerge(ctx().pool, d.w.projectId, D))?.commit).toBe(d1);
    expect(await latestMerge(ctx().pool, d.w.projectId, randomUUID())).toBeNull();
    // the allow-list of automated commits is per repository too
    expect(await automatedCommitAllowed(ctx().pool, d.w.projectId, x1, [], X)).toBe(true);
    expect(await automatedCommitAllowed(ctx().pool, d.w.projectId, x1, [], D)).toBe(false);
    expect(await automatedCommitAllowed(ctx().pool, d.w.projectId, d1, [], D)).toBe(true);
    const res = await requestDeployRun(ctx(), {
      projectId: d.w.projectId,
      env: 'local',
      commit: x1,
      trigger: 'after_merge',
      requester: { kind: 'trigger', id: null, name: 'after_merge', provenance: 'trigger' },
    });
    expect(res.runs[0]).toMatchObject({ status: 'refused', refusal: 'commit_not_allowed' });
  });

  it('a deploy that names no commit gets the newest merge of its own repository, never a newer one of another', async () => {
    await mergeIn(X, hex('4')); // X has merged after D
    const before = execs().length;
    const res = await requestDeployRun(ctx(), {
      projectId: d.w.projectId,
      env: 'local',
      trigger: 'after_merge',
      requester: { kind: 'trigger', id: null, name: 'after_merge', provenance: 'trigger' },
    });
    expect(res.runs[0]).toMatchObject({ status: 'queued' });
    await until(async () => execs().length === before + 1, 4000, 'deploy.exec');
    expect(execs().at(-1)!.payload).toMatchObject({ commit: hex('2'), repo: { repoId: D, name: 'cloud' } });
  });
});

describe('merges in both repositories', () => {
  it('merges in both repositories of one burst: the pin is moved, and the deploy is of the pinned commit', async () => {
    const cmds = pins().length;
    const before = execs().length;
    await mergeIn(X, hex('7'));
    await mergeIn(D, hex('8'));
    await settle();
    await until(async () => pins().length === cmds + 1, 4000, 'command');
    expect(pins().at(-1)!.payload).toMatchObject({ commit: hex('7'), repoId: D });
    answer(pins().at(-1)!, { ok: true, commit: hex('f') });
    await until(async () => execs().length === before + 1, 4000, 'deploy');
    expect(execs().at(-1)!.payload).toMatchObject({ commit: hex('f') });
  });

  it('a merge into the deploy repository itself deploys that merge commit, as before', async () => {
    const before = execs().length;
    const cmds = pins().length;
    await mergeIn(D, hex('2'));
    await settle();
    await until(async () => execs().length === before + 1, 4000, 'deploy');
    expect(pins()).toHaveLength(cmds);
    expect(execs().at(-1)!.payload).toMatchObject({ commit: hex('2'), repo: { repoId: D } });
  });
});
