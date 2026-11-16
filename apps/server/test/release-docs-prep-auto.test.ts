import { RELEASE_DOCS_PREP_CAPABILITY, RELEASE_FACTS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadReleaseReadiness, releaseDocsPrepAutoStart } from '../src/release/docs-prep-auto.ts';
import { keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import {
  advance,
  type DeliveryWorld,
  deliveryWorld,
  healthyRun,
  parseFixture,
  setWeekday,
} from './helpers/delivery.ts';
import { addMember } from './helpers/members.ts';
import { freshState } from './helpers/shifts.ts';
import { markOnline, ok } from './helpers/world.ts';

/**
 * Release prep starts by itself when the release is ready on the test site: the release head is live and healthy on
 * the test copy (`local`), and what the live site (`production`) requires holds, release window and freeze aside.
 */
const HEAD = 'abc1234def5678abc1234def5678abc1234def56';
const NEXT = '2222222def5678abc1234def5678abc1234def56';
let d: DeliveryWorld;
type Rows = [any, ...any[]];
const q2 = async (sql: string, params: unknown[] = []) => (await q(sql, params)) as Rows;
const ctx = () => d.w.t.app.ctx;
const base = () => `/api/projects/${d.w.projectId}/release-docs-prep`;
const owner = (method: string, u: string, body?: unknown, cookie = d.w.owner.cookie) =>
  d.w.t.req(method, u, { cookie, body });
const runs = () =>
  q2(`SELECT * FROM release_docs_prep_runs WHERE project_id=$1 ORDER BY started_at`, [d.w.projectId]);
const pass = () => releaseDocsPrepAutoStart(ctx(), { force: true });
const project = async () => (await q2('SELECT * FROM projects WHERE id=$1', [d.w.projectId]))[0];

/** The live site's gate (fixture) needs the test copy healthy for 30 minutes and a passed regression run. */
const RECIPE = parseFixture();
for (const e of RECIPE.environments)
  if (e.name === 'production')
    (e as { gate: unknown }).gate = {
      requires: [{ envHealthy: 'local', sameCommit: true, forMinutes: 30 }],
      freeze: true,
    };

beforeAll(async () => {
  d = await deliveryWorld();
  await keepOnline(d.w);
  await setWeekday(d);
  const o = await d.observe(RECIPE, { commit: '9999999aaaaaaa' });
  await ok(d.approve(o.hash));
});
afterAll(async () => {
  await d.w.t.close();
  await closeAdminPool();
});

const REAL = [{ sha: '3'.repeat(40), subject: 'feat: something new', breakingFooter: false }];
const MACHINERY = [
  {
    sha: '4'.repeat(40),
    subject: 'docs(release): prepare the release documentation for release/1.5.0',
    breakingFooter: false,
  },
  { sha: '5'.repeat(40), subject: 'chore(release): 1.5.0', breakingFooter: false },
];

/** Facts for the release branch at `sha`; by default with one real change since the last release. */
async function setHead(sha: string, commits: unknown[] = REAL, at: Date = ctx().clock.now()) {
  const facts = {
    headSha: sha,
    ahead: commits.length,
    lastTag: { name: 'v1.4.0', sha: '6'.repeat(40) },
    commits,
  };
  await q(
    `INSERT INTO repo_release_facts (project_repo_id, request_id, trigger, state, head_sha, facts, requested_at, updated_at)
     VALUES ($1, gen_random_uuid(), 'manual', 'ready', $2, $4::jsonb, $3, $3)
     ON CONFLICT (project_repo_id) DO UPDATE SET state='ready', message=NULL, head_sha=$2, facts=$4::jsonb, requested_at=$3, updated_at=$3`,
    [d.w.repoId, sha, at, JSON.stringify(facts)],
  );
}

/** A published release 1.5.0 of the repository at `at`. */
async function published(at: Date) {
  await q(
    `INSERT INTO release_ships (id, org_id, project_id, repo_id, version, tag, tag_name, release_date, payload, status,
                                commit_sha, published_at, created_at, updated_at)
     SELECT gen_random_uuid(), org_id, id, $2, '1.5.0', 'v1.5.0', 'v1.5.0', '2026-11-15', '{}'::jsonb, 'published',
            $3, $4, $4, $4 FROM projects WHERE id=$1`,
    [d.w.projectId, d.w.repoId, '5'.repeat(40), at],
  );
}

const settings = (body: Record<string, unknown>, cookie?: string) =>
  owner(
    'PUT',
    `${base()}/settings`,
    { enabled: true, steps: { changelog: false, guide: false, help: false }, ...body },
    cookie,
  );

beforeEach(async () => {
  await freshState();
  await q(`TRUNCATE release_proposals, release_ships, repo_release_facts, release_docs_prep_runs CASCADE`);
  await q(`TRUNCATE runner_commands CASCADE`);
  await q(`DELETE FROM deploy_runs WHERE project_id=$1`, [d.w.projectId]);
  await q(
    `UPDATE projects SET release_docs_prep='{"enabled": false, "steps": {}}'::jsonb, working_branch='release/1.5.0' WHERE id=$1`,
    [d.w.projectId],
  );
  await q(`UPDATE project_repos SET main_branch='main', working_branch=NULL WHERE id=$1`, [d.w.repoId]);
  await markOnline(d.w.t, d.w.workstationId, { repoIds: [d.w.repoId] });
  await q(
    `INSERT INTO workstation_capabilities (workstation_id, capabilities, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (workstation_id) DO UPDATE SET capabilities=$2`,
    [d.w.workstationId, [RELEASE_DOCS_PREP_CAPABILITY]],
  );
  await setHead(HEAD);
});

describe('the auto-start setting', () => {
  it('is off by default; the owner turns it on; a member gets 403; a save without it keeps it', async () => {
    expect((await owner('GET', `${base()}/settings`)).body.autoStart).toBe(false);
    expect((await settings({ autoStart: true })).body.autoStart).toBe(true);
    expect((await settings({})).body.autoStart).toBe(true);
    const m = await addMember(d.w);
    expect((await settings({ autoStart: false }, m.cookie)).status).toBe(403);
    expect((await owner('GET', `${base()}/settings`)).body.autoStart).toBe(true);
    expect((await settings({ autoStart: false })).body.autoStart).toBe(false);
  });
});

describe('release readiness', () => {
  it('not deployed, then deployed but the live requirement waits, then ready', async () => {
    let r = await loadReleaseReadiness(ctx().pool, await project(), ctx().clock.now());
    expect(r.ready).toBe(false);
    expect(r.reasons[0]).toContain('head abc1234 is not on local yet (nothing deployed yet)');
    await healthyRun(d, 'local', HEAD, 5);
    r = await loadReleaseReadiness(ctx().pool, await project(), ctx().clock.now());
    expect(r.ready).toBe(false);
    expect(r.reasons[0]).toContain('not ready to go out on production');
    await advance(d, 30 * 60_000);
    r = await loadReleaseReadiness(ctx().pool, await project(), ctx().clock.now());
    expect(r.ready).toBe(true);
    expect(r.key).toBe(`${d.w.repoId}@${HEAD}`);
  });
});

describe('the automatic start', () => {
  const ready = async () => {
    await healthyRun(d, 'local', HEAD, 45);
  };

  it('off by default: a ready release starts nothing', async () => {
    await settings({});
    await ready();
    await pass();
    expect(await runs()).toHaveLength(0);
  });

  it('on and ready: exactly one automatic run by the system, its first step dispatched; repeated passes add none', async () => {
    await settings({ autoStart: true });
    await ready();
    await Promise.all([pass(), pass()]);
    await pass();
    const all = await runs();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ trigger: 'auto', started_by: null, ready_key: `${d.w.repoId}@${HEAD}` });
    expect(all[0].heads).toEqual({ [d.w.repoId]: HEAD });
    const ev = (
      await q2(`SELECT actor_kind FROM events WHERE type='ReleaseDocsPrepStarted' ORDER BY seq DESC LIMIT 1`)
    )[0];
    expect(ev.actor_kind).toBe('system');
    expect(await q2(`SELECT * FROM runner_commands WHERE type='release.docs_prep'`)).toHaveLength(1);
    const view = (await owner('GET', `${base()}/runs/latest`)).body;
    expect(view).toMatchObject({ trigger: 'auto', startedBy: null, startedByName: null });
    const item = ((await owner('GET', '/api/release-docs-prep')).body as any[]).find(
      (o) => o.projectId === d.w.projectId,
    );
    expect(item).toMatchObject({ autoStart: true, readiness: { ready: true }, autoStartBlocked: null });
  });

  it('a second automatic run for the same release and head is refused by the database', async () => {
    await settings({ autoStart: true });
    await ready();
    await pass();
    const [run] = await runs();
    await expect(
      q(
        `INSERT INTO release_docs_prep_runs (id, org_id, project_id, release_branch, status, steps, trigger, started_at, updated_at, ready_key)
         SELECT gen_random_uuid(), org_id, project_id, release_branch, 'failed', steps, 'auto', now(), now(), ready_key
           FROM release_docs_prep_runs WHERE id=$1`,
        [run.id],
      ),
    ).rejects.toThrow(/release_docs_prep_one_auto/);
  });

  it('a manual start before ready, or a skip, stops a later automatic start', async () => {
    await settings({ autoStart: true });
    expect((await owner('POST', `${base()}/runs`)).status).toBe(202);
    await ready();
    await pass();
    expect((await runs()).map((r) => r.trigger)).toEqual(['manual']);
    await q(`TRUNCATE release_docs_prep_runs CASCADE`);
    expect((await owner('POST', `${base()}/skip`)).status).toBe(204);
    await pass();
    expect((await runs()).map((r) => r.trigger)).toEqual(['skip']);
  });

  it('a new head is not ready until deployed, and starts no run for the old head', async () => {
    await settings({ autoStart: true });
    await ready();
    await setHead(NEXT);
    await pass();
    expect(await runs()).toHaveLength(0);
    const item = ((await owner('GET', '/api/release-docs-prep')).body as any[]).find(
      (o) => o.projectId === d.w.projectId,
    );
    expect(item.readiness.ready).toBe(false);
    expect(item.readiness.reasons[0]).toContain('head 2222222 is not on local yet (it runs abc1234)');
  });

  it('a missing requirement starts nothing and the overview shows the manual start sentence', async () => {
    await settings({ autoStart: true });
    await q(`DELETE FROM workstation_repos WHERE project_repo_id=$1`, [d.w.repoId]);
    await ready();
    await pass();
    expect(await runs()).toHaveLength(0);
    const item = ((await owner('GET', '/api/release-docs-prep')).body as any[]).find(
      (o) => o.projectId === d.w.projectId,
    );
    expect(item.autoStartBlocked).toMatch(
      /^No workstation has .+ yet\. Wait for the clone to finish, then try again\.$/,
    );
  });
});

describe('after a release has shipped', () => {
  const ready = async () => {
    await healthyRun(d, 'local', HEAD, 45);
  };
  const shippedFacts = (commits: unknown[]) =>
    setHead(HEAD, commits).then(() =>
      q(
        `UPDATE repo_release_facts SET facts = jsonb_set(facts, '{lastTag}', $2::jsonb) WHERE project_repo_id=$1`,
        [d.w.repoId, JSON.stringify({ name: 'v1.5.0', sha: '7'.repeat(40) })],
      ),
    );

  it('starts no automatic run when the release commit or a prep docs commit is the new head', async () => {
    await settings({ autoStart: true });
    await ready();
    await published(new Date(ctx().clock.now().getTime() - 60_000));
    await shippedFacts([MACHINERY[1]]);
    await pass();
    expect(await runs()).toHaveLength(0);
    await shippedFacts(MACHINERY);
    await pass();
    expect(await runs()).toHaveLength(0);
  });

  it('facts older than the publish: no start, and the facts are asked for again', async () => {
    await settings({ autoStart: true });
    await ready();
    await q(`UPDATE workstation_capabilities SET capabilities=$2 WHERE workstation_id=$1`, [
      d.w.workstationId,
      [RELEASE_DOCS_PREP_CAPABILITY, RELEASE_FACTS_CAPABILITY],
    ]);
    await setHead(HEAD, REAL, new Date(ctx().clock.now().getTime() - 120_000));
    await published(new Date(ctx().clock.now().getTime() - 60_000));
    await pass();
    expect(await runs()).toHaveLength(0);
    const [f] = await q2(`SELECT trigger FROM repo_release_facts WHERE project_repo_id=$1`, [d.w.repoId]);
    expect(f.trigger).toBe('release');
  });

  it('stale facts: passes a minute apart ask once while the read is out or failing, and again after five minutes', async () => {
    const factsCommands = async () =>
      (
        await q2(
          `SELECT count(*)::int AS n FROM runner_commands WHERE workstation_id=$1 AND type='repo.release_facts'`,
          [d.w.workstationId],
        )
      )[0].n;
    await settings({ autoStart: true });
    await ready();
    await q(`UPDATE workstation_capabilities SET capabilities=$2 WHERE workstation_id=$1`, [
      d.w.workstationId,
      [RELEASE_DOCS_PREP_CAPABILITY, RELEASE_FACTS_CAPABILITY],
    ]);
    await setHead(HEAD, REAL, new Date(ctx().clock.now().getTime() - 120_000));
    await published(new Date(ctx().clock.now().getTime() - 60_000));
    await pass();
    expect(await factsCommands()).toBe(1);
    const [first] = await q2(`SELECT request_id FROM repo_release_facts WHERE project_repo_id=$1`, [
      d.w.repoId,
    ]);
    await advance(d, 60_000);
    await pass();
    expect(await factsCommands()).toBe(1);
    // the read still out keeps its request, so its answer is not dropped
    const [still] = await q2(`SELECT request_id FROM repo_release_facts WHERE project_repo_id=$1`, [
      d.w.repoId,
    ]);
    expect(still.request_id).toBe(first.request_id);
    // a failed read is not fetched again on the next pass either
    await q(`UPDATE repo_release_facts SET message='fetch failed', updated_at=$2 WHERE project_repo_id=$1`, [
      d.w.repoId,
      ctx().clock.now(),
    ]);
    await advance(d, 60_000);
    await pass();
    expect(await factsCommands()).toBe(1);
    await advance(d, 5 * 60_000);
    await pass();
    expect(await factsCommands()).toBe(2);
    expect(await runs()).toHaveLength(0);
  });

  it('a manual start with nothing since the release is refused; with a real change it starts', async () => {
    await settings({});
    await published(new Date(ctx().clock.now().getTime() - 60_000));
    await shippedFacts(MACHINERY);
    const refused = await owner('POST', `${base()}/runs`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('nothing_since_release');
    await shippedFacts([...REAL, ...MACHINERY]);
    expect((await owner('POST', `${base()}/runs`)).status).toBe(202);
  });

  it('after a new-cycle automatic run exists, a newer head starts no second automatic run', async () => {
    await settings({ autoStart: true });
    await published(new Date(ctx().clock.now().getTime() - 60_000));
    await ready();
    await shippedFacts(REAL);
    await pass();
    expect(await runs()).toHaveLength(1);
    await q(`UPDATE release_docs_prep_runs SET status='failed'`);
    await setHead(NEXT);
    await healthyRun(d, 'local', NEXT, 45);
    await pass();
    expect(await runs()).toHaveLength(1);
  });
});
