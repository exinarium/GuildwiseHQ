import {
  RELEASE_PUBLISH_CAPABILITY,
  RELEASE_SHIP_CAPABILITY,
  type ReleaseFacts,
  ReleaseFactsSchema,
} from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyReleasePublishResult, releaseChecks } from '../src/release/publish.ts';
import { reconcileReleaseProposal } from '../src/release/reconcile.ts';
import { applyReleaseShipResult } from '../src/release/ship.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember } from './helpers/members.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, markOnline, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

type Rows = [any, ...any[]];
const HEAD = 'a'.repeat(40);
const R = 'c'.repeat(40);
const M = 'd'.repeat(40);
const facts = (): ReleaseFacts =>
  ReleaseFactsSchema.parse({
    headSha: HEAD,
    ahead: 3,
    lastTag: { name: 'v1.3.0', sha: 'b'.repeat(40) },
    existingTags: ['v1.3.0'],
    changedTotal: 4,
    components: [],
    changelog: '## [Unreleased]\n\n### Added\n\n- One.\n\n## [1.3.0] - 2026-10-20\n',
  });

const q2 = async (sql: string, params: unknown[] = []) => (await q(sql, params)) as Rows;
const proposal = async () =>
  (await q2(`SELECT * FROM release_proposals WHERE repo_id=$1 ORDER BY created_at DESC`, [w.repoId]))[0];
const ship = async () => (await q2(`SELECT * FROM release_ships WHERE repo_id=$1`, [w.repoId]))[0];
const publishCmds = () =>
  q2(`SELECT * FROM runner_commands WHERE type='release.publish' ORDER BY created_at`);
const shipCmds = () => q2(`SELECT * FROM runner_commands WHERE type='release.ship' ORDER BY created_at`);
const eventCount = async (type: string) =>
  Number((await q2(`SELECT count(*)::int AS n FROM events WHERE type=$1`, [type]))[0].n);

async function workstation(caps: string[]) {
  await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
  await q(
    `INSERT INTO workstation_capabilities (workstation_id, capabilities, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (workstation_id) DO UPDATE SET capabilities=$2`,
    [w.workstationId, caps],
  );
}

/** Proposal approved and the release commit reported: the ship is `committed`. */
async function committed() {
  await q(
    `INSERT INTO repo_release_facts (project_repo_id, request_id, trigger, state, head_sha, facts, requested_at, updated_at)
     VALUES ($1, gen_random_uuid(), 'manual', 'ready', $2, $3::jsonb, now(), now())
     ON CONFLICT (project_repo_id) DO UPDATE SET state='ready', head_sha=$2, facts=$3::jsonb`,
    [w.repoId, HEAD, JSON.stringify(facts())],
  );
  await reconcileReleaseProposal(w.t.app.ctx, w.repoId, 'manual');
  const item = (
    await q2(`SELECT * FROM desk_items WHERE subkind='ship_release' AND data->>'repoId'=$1`, [w.repoId])
  )[0];
  await ok(
    w.t.req('POST', `/api/desk/${item.id}/resolve`, {
      cookie: w.owner.cookie,
      body: { resolution: 'approved', release: { version: '1.4.0', components: [], factsHeadSha: HEAD } },
    }),
  );
  const id = (await proposal()).id;
  await applyReleaseShipResult(
    w.t.app.ctx,
    w.workstationId,
    { shipId: id },
    true,
    { ok: true, step: 'push', commit: R, components: [], notices: [] },
    undefined,
  );
  return id as string;
}

beforeEach(async () => {
  await freshState();
  await q(`TRUNCATE release_proposals, release_ships, repo_release_facts`);
  await q(`TRUNCATE runner_commands CASCADE`);
  await q(`UPDATE project_repos SET component_rules='[]'::jsonb, release_name=NULL WHERE id=$1`, [w.repoId]);
  await workstation([RELEASE_SHIP_CAPABILITY, RELEASE_PUBLISH_CAPABILITY]);
});

const done = {
  ok: true,
  stage: 'done',
  land: { mode: 'merge', mergeSha: M, by: 'guildwise' },
  tag: { name: 'v1.4.0', target: M, state: 'created', url: 'https://github.com/o/r/tree/v1.4.0' },
  release: { state: 'created', url: 'https://github.com/o/r/releases/tag/v1.4.0', latest: true },
};

describe('release.publish on the server', () => {
  it('queues release.publish right after the release commit, with the title from the project name', async () => {
    await committed();
    const cmds = await publishCmds();
    expect(cmds).toHaveLength(1);
    const project = (await q2(`SELECT name FROM projects WHERE id=$1`, [w.projectId]))[0];
    expect(cmds[0].payload).toMatchObject({
      version: '1.4.0',
      tag: 'v1.4.0',
      releaseCommitSha: R,
      title: `${project.name} 1.4.0`,
      land: { mode: 'merge' },
    });
    expect((await ship()).status).toBe('committed');
  });

  it('ignores a release PR request that an earlier landed release already used', async () => {
    await q(
      `INSERT INTO release_ships (id, org_id, project_id, repo_id, version, tag, release_date, payload, status, merge_sha, pr_url, created_at, updated_at)
       SELECT gen_random_uuid(), org_id, id, $2, '1.3.0', 'v1.3.0', current_date, '{}'::jsonb, 'published', $3, 'https://github.com/o/r/pull/3', now(), now()
         FROM projects WHERE id=$1`,
      [w.projectId, w.repoId, M],
    );
    await q(
      `INSERT INTO repo_pr_requests (request_id, project_id, repo_id, workstation_id, head, base, state, url, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'develop', 'main', 'opened', 'https://github.com/o/r/pull/3', now(), now())`,
      [w.projectId, w.repoId, w.workstationId],
    );
    await committed();
    const cmds = await publishCmds();
    expect(cmds).toHaveLength(1);
    expect(JSON.stringify(cmds[0].payload.land)).not.toContain('/pull/3');
  });

  it('uses the release name setting for the title when it is set', async () => {
    await q(`UPDATE project_repos SET release_name='Guildwise HQ' WHERE id=$1`, [w.repoId]);
    await committed();
    expect((await publishCmds())[0].payload.title).toBe('Guildwise HQ 1.4.0');
  });

  it('without a capable workstation nothing is queued and the row says why', async () => {
    await workstation([RELEASE_SHIP_CAPABILITY]);
    await committed();
    expect(await publishCmds()).toHaveLength(0);
    expect((await ship()).step_message).toContain('up-to-date runner');
  });

  it('a waiting answer records the reason and no event or desk item', async () => {
    const id = await committed();
    const tagged = await eventCount('ReleaseTagged');
    await applyReleasePublishResult(
      w.t.app.ctx,
      w.workstationId,
      { shipId: id },
      true,
      {
        ok: true,
        stage: 'waiting',
        waiting: { reason: 'the release pull request is not merged yet', prState: 'open' },
      },
      undefined,
    );
    expect((await ship()).step_message).toContain('not merged yet');
    expect(await eventCount('ReleaseTagged')).toBe(tagged);
    expect(await q2(`SELECT * FROM desk_items WHERE subkind='release_published'`)).toHaveLength(0);
  });

  it('a done answer records land, tag and publish once, closes the proposal, and a repeat changes nothing', async () => {
    const id = await committed();
    await applyReleasePublishResult(w.t.app.ctx, w.workstationId, { shipId: id }, true, done, undefined);
    expect(await ship()).toMatchObject({
      status: 'published',
      merge_sha: M,
      tag_name: 'v1.4.0',
      release_state: 'created',
      release_url: 'https://github.com/o/r/releases/tag/v1.4.0',
    });
    expect(await proposal()).toMatchObject({ state: 'released', closed_reason: 'released' });
    const alerts = await q2(`SELECT * FROM desk_items WHERE subkind='release_published'`);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toContain('Release page created');
    await applyReleasePublishResult(w.t.app.ctx, w.workstationId, { shipId: id }, true, done, undefined);
    expect(await q2(`SELECT * FROM desk_items WHERE subkind='release_published'`)).toHaveLength(1);
    expect(await eventCount('ReleasePublished')).toBe(1);
    expect(await eventCount('ReleaseTagged')).toBe(1);
  });

  it('a forge without release pages publishes with the tag and says no release page was created', async () => {
    const id = await committed();
    await applyReleasePublishResult(
      w.t.app.ctx,
      w.workstationId,
      { shipId: id },
      true,
      {
        ...done,
        release: {
          state: 'none',
          url: null,
          message: 'Tag v1.4.0 was pushed. No release page was created: Plain git has no release pages.',
        },
      },
      undefined,
    );
    expect((await ship()).release_state).toBe('none');
    expect((await q2(`SELECT * FROM desk_items WHERE subkind='release_published'`))[0].body).toContain(
      'No release page was created',
    );
  });

  it('a failed tag push puts a release_failed alert on the desk; Retry sends release.publish, never release.ship', async () => {
    const id = await committed();
    const ships = (await shipCmds()).length;
    await applyReleasePublishResult(
      w.t.app.ctx,
      w.workstationId,
      { shipId: id },
      true,
      {
        ok: false,
        stage: 'failed',
        failedStep: 'tag',
        error: 'pushing v1.4.0 failed: tags are locked',
        land: done.land,
      },
      undefined,
    );
    expect(await ship()).toMatchObject({ status: 'failed', step: 'tag', merge_sha: M });
    const alert = (await q2(`SELECT * FROM desk_items WHERE subkind='release_failed'`))[0];
    expect(alert.body).toContain('tags are locked');
    const before = (await publishCmds()).length;
    // not the owner: refused
    const m = await addMember(w, 'bystander');
    const other = await w.t.req('POST', `/api/desk/${alert.id}/resolve`, {
      cookie: m.cookie,
      body: { resolution: 'approved' },
    });
    expect(other.status).toBe(403);
    await ok(
      w.t.req('POST', `/api/desk/${alert.id}/resolve`, {
        cookie: w.owner.cookie,
        body: { resolution: 'approved' },
      }),
    );
    expect(await eventCount('ReleasePublishRetried')).toBe(1);
    expect(await eventCount('ReleaseShipStarted')).toBe(1);
    expect((await publishCmds()).length).toBe(before + 1);
    expect((await shipCmds()).length).toBe(ships);
    expect((await ship()).status).toBe('committed');
  });

  it('a release that is not approved, or still committing, never gets release.publish from the check pass', async () => {
    await q(`TRUNCATE runner_commands CASCADE`);
    await releaseChecks(w.t.app.ctx);
    expect(await publishCmds()).toHaveLength(0);
    const id = await committed();
    await q(`TRUNCATE runner_commands CASCADE`);
    await q(`UPDATE release_ships SET status='committing', publish_checked_at=NULL WHERE id=$1`, [id]);
    await releaseChecks(w.t.app.ctx);
    expect(await publishCmds()).toHaveLength(0);
    await q(`UPDATE release_ships SET status='committed', publish_checked_at=NULL WHERE id=$1`, [id]);
    await q(`UPDATE release_proposals SET state='proposed' WHERE id=$1`, [id]);
    await releaseChecks(w.t.app.ctx);
    expect(await publishCmds()).toHaveLength(0);
  });

  it('a facts read that shows the tag does not close an approved proposal whose ship is not published', async () => {
    const id = await committed();
    await q(`UPDATE release_ships SET status='tagged' WHERE id=$1`, [id]);
    await q(
      `UPDATE repo_release_facts SET facts = jsonb_set(facts, '{existingTags}', '["v1.3.0","v1.4.0"]'::jsonb) WHERE project_repo_id=$1`,
      [w.repoId],
    );
    await reconcileReleaseProposal(w.t.app.ctx, w.repoId, 'manual');
    expect((await proposal()).state).toBe('approved');
  });
});
