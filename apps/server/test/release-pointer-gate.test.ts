import {
  RELEASE_FACTS_CAPABILITY,
  RELEASE_SHIP_CAPABILITY,
  type ReleaseFacts,
  ReleaseFactsSchema,
  type ReleaseSubmoduleFacts,
} from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { releaseViewFor } from '../src/release/approve.ts';
import { requestReleaseFacts } from '../src/release/facts.ts';
import { reconcileReleaseProposal } from '../src/release/reconcile.ts';
import { applyReleaseShipResult } from '../src/release/ship.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, markOnline, ok, type World } from './helpers/world.ts';

let w: World;
let coreId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  const added = await ok<any>(
    w.t.req('POST', `/api/projects/${w.projectId}/repos`, {
      cookie: w.owner.cookie,
      body: { name: 'core', remoteUrl: 'https://github.com/acme/core.git' },
    }),
    201,
  );
  coreId = added.repos.find((r: { name: string }) => r.name === 'core').id;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

type Rows = [any, ...any[]];
const HEAD = 'a'.repeat(40);
const PIN = 'abc1234def5678abc1234def5678abc1234def56';
const file = (v: string) => `export const RUNNER_VERSION = '${v}';\n`;
const sub = (over: Partial<ReleaseSubmoduleFacts> = {}): ReleaseSubmoduleFacts => ({
  path: 'core',
  url: 'github.com/acme/core',
  pinned: PIN,
  repoId: coreId,
  repoName: 'core',
  latestTag: { name: 'v1.8.0', sha: 'f'.repeat(40) },
  containsTag: 'v1.7.2',
  state: 'behind',
  ...over,
});
const facts = (submodules?: ReleaseSubmoduleFacts[]): ReleaseFacts =>
  ReleaseFactsSchema.parse({
    headSha: HEAD,
    ahead: 3,
    lastTag: { name: 'v1.3.0', sha: 'b'.repeat(40) },
    existingTags: ['v1.3.0'],
    commits: [{ sha: 'd'.repeat(40), subject: 'feat: one', breakingFooter: false }],
    changedTotal: 4,
    components: [
      { name: 'runner', changedCount: 17, contentAtHead: file('0.1.62'), contentAtTag: file('0.1.62') },
    ],
    changelog: '## [Unreleased]\n\n### Added\n\n- One.\n\n## [1.3.0] - 2026-10-20\n',
    ...(submodules ? { submodules } : {}),
  });

const q2 = async (sql: string, params: unknown[] = []) => (await q(sql, params)) as Rows;
const proposal = async () =>
  (await q2(`SELECT * FROM release_proposals WHERE repo_id=$1 ORDER BY created_at DESC`, [w.repoId]))[0];
const shipItem = async () =>
  (await q2(`SELECT * FROM desk_items WHERE subkind='ship_release' AND data->>'repoId'=$1`, [w.repoId]))[0];
const commands = () => q2(`SELECT * FROM runner_commands WHERE type='release.ship' ORDER BY created_at`);
const eventCount = async (type: string) =>
  Number((await q2(`SELECT count(*)::int AS n FROM events WHERE type=$1`, [type]))[0].n);

const storeFacts = (f: ReleaseFacts) =>
  q(
    `INSERT INTO repo_release_facts (project_repo_id, request_id, trigger, state, head_sha, facts, requested_at, updated_at)
     VALUES ($1, gen_random_uuid(), 'manual', 'ready', $2, $3::jsonb, now(), now())
     ON CONFLICT (project_repo_id) DO UPDATE SET state='ready', head_sha=$2, facts=$3::jsonb`,
    [w.repoId, HEAD, JSON.stringify(f)],
  );

async function propose(submodules?: ReleaseSubmoduleFacts[]) {
  await storeFacts(facts(submodules));
  await reconcileReleaseProposal(w.t.app.ctx, w.repoId, 'manual');
  return shipItem();
}

const approve = (itemId: string) =>
  w.t.req('POST', `/api/desk/${itemId}/resolve`, {
    cookie: w.owner.cookie,
    body: {
      resolution: 'approved',
      release: { version: '1.4.0', components: [{ name: 'runner', level: 'patch' }], factsHeadSha: HEAD },
    },
  });

beforeEach(async () => {
  await freshState();
  await q(`TRUNCATE release_proposals, release_ships, repo_release_facts`);
  await q(`TRUNCATE runner_commands CASCADE`);
  await q(`UPDATE project_repos SET component_rules=$2::jsonb WHERE id=$1`, [
    w.repoId,
    JSON.stringify([
      {
        name: 'runner',
        paths: ['apps/runner/**'],
        versionFile: 'apps/runner/src/version.ts',
        pattern: "RUNNER_VERSION = '(.*)'",
      },
    ]),
  ]);
  await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
  await q(
    `INSERT INTO workstation_capabilities (workstation_id, capabilities, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (workstation_id) DO UPDATE SET capabilities=$2`,
    [w.workstationId, [RELEASE_SHIP_CAPABILITY, RELEASE_FACTS_CAPABILITY]],
  );
});

describe('submodule pointer gate on approve (start ship)', () => {
  it('refuses a behind pointer with the submodule, pinned commit and latest tag; nothing is queued or stored', async () => {
    const item = await propose([sub()]);
    const approved = await eventCount('ReleaseApproved');
    const res = await approve(item.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('release_submodule_behind');
    expect(res.body.error.message).toContain(
      'core: behind - pinned abc1234 (contains 1.7.2), latest release 1.8.0',
    );
    expect(res.body.error.message).toContain(
      'Bump the submodule core to v1.8.0 in toy and refresh the release.',
    );
    expect(await commands()).toHaveLength(0);
    expect(await eventCount('ReleaseApproved')).toBe(approved);
    expect((await proposal()).state).toBe('proposed');
    expect((await shipItem()).status).toBe('open');
  });

  it('refuses a pointer that is not on a release tag', async () => {
    const item = await propose([sub({ state: 'not_on_release_tag', containsTag: 'v1.8.0' })]);
    const res = await approve(item.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('release_submodule_behind');
    expect(res.body.error.message).toContain('not on a release tag');
    expect(await commands()).toHaveLength(0);
  });

  it.each([
    ['pinned', [sub({ state: 'pinned', latestTag: { name: 'v1.8.0', sha: PIN }, containsTag: 'v1.8.0' })]],
    [
      'not checked',
      [sub({ state: 'not_checked', repoId: undefined, reason: 'points outside this project' })],
    ],
    ['unknown', [sub({ state: 'unknown', reason: 'no clone of core on this workstation' })]],
    ['facts without the field', undefined],
  ])('ships as before when the pointer is %s', async (_label, subs) => {
    const item = await propose(subs);
    await ok(approve(item.id));
    expect(await commands()).toHaveLength(1);
  });

  it('shows the submodule lines on the item view, and none for a repository without submodules', async () => {
    const item = await propose([sub()]);
    const rel = await releaseViewFor(w.t.app.ctx.pool, item);
    expect(rel?.submodules).toHaveLength(1);
    expect(rel?.submodules?.[0]).toMatchObject({ path: 'core', state: 'behind', pinned: PIN });
    await storeFacts(facts());
    const plain = await releaseViewFor(w.t.app.ctx.pool, item);
    expect(plain && 'submodules' in plain).toBe(false);
  });

  it('turns pinned into behind when the pointed repository released a newer version after the read', async () => {
    const item = await propose([
      sub({ state: 'pinned', latestTag: { name: 'v1.8.0', sha: PIN }, containsTag: 'v1.8.0' }),
    ]);
    await q(
      `INSERT INTO release_ships (id, org_id, project_id, repo_id, version, tag, release_date, payload, status, tag_name, created_at, updated_at)
       SELECT gen_random_uuid(), org_id, id, $2, '1.9.0', 'v1.9.0', now(), '{}'::jsonb, 'committed', 'v1.9.0', now(), now()
         FROM projects WHERE id=$1`,
      [w.projectId, coreId],
    );
    const res = await approve(item.id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('latest release 1.9.0');
    expect(res.body.error.message).toContain('Bump the submodule core to v1.9.0');
    expect(await commands()).toHaveLength(0);
  });
});

describe('submodule pointer gate on Retry', () => {
  async function failedAt(step: string) {
    const item = await propose();
    await ok(approve(item.id));
    const id = (await proposal()).id;
    await applyReleaseShipResult(
      w.t.app.ctx,
      w.workstationId,
      { shipId: id },
      true,
      { ok: false, step, error: 'it went wrong', components: [], notices: [] },
      undefined,
    );
    return (await q2(`SELECT * FROM desk_items WHERE subkind='release_failed' ORDER BY created_at`))[0];
  }
  const retry = (alertId: string) =>
    w.t.req('POST', `/api/desk/${alertId}/resolve`, {
      cookie: w.owner.cookie,
      body: { resolution: 'approved' },
    });

  it('refuses Retry of a stopped ship while the current facts show a behind pointer; a refresh to pinned clears it', async () => {
    const alert = await failedAt('push');
    await storeFacts(facts([sub()]));
    const res = await retry(alert.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('release_submodule_behind');
    expect(await commands()).toHaveLength(1);
    await storeFacts(
      facts([sub({ state: 'pinned', latestTag: { name: 'v1.8.0', sha: PIN }, containsTag: 'v1.8.0' })]),
    );
    await ok(retry(alert.id));
    expect(await commands()).toHaveLength(2);
  });
});

describe('release facts request', () => {
  it("sends the project's other repositories for the submodule check", async () => {
    await q(`UPDATE project_repos SET working_branch='develop', main_branch='main' WHERE id=$1`, [w.repoId]);
    const out = await requestReleaseFacts(w.t.app.ctx, w.repoId, 'manual', { userId: w.owner.id });
    expect(out.queued).toBe(true);
    const cmd = (await q2(`SELECT * FROM runner_commands WHERE type='repo.release_facts'`))[0];
    expect(cmd.payload.projectRepos).toEqual([
      { repoId: coreId, name: 'core', remoteUrlNormalized: 'github.com/acme/core' },
    ]);
  });
});
