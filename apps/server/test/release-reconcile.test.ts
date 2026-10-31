import { type ReleaseFacts, ReleaseFactsSchema } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileReleaseProposal } from '../src/release/reconcile.ts';
import { addMember } from './helpers/members.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const HEAD = 'a'.repeat(40);
const file = (v: string) => `export const RUNNER_VERSION = '${v}';\n`;
const CHANGELOG = (unreleased: string) =>
  `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n## [1.3.0] - 2026-10-20\n\n### Added\n\n- Old.\n`;

const facts = (over: Partial<ReleaseFacts> = {}): ReleaseFacts =>
  ReleaseFactsSchema.parse({
    headSha: HEAD,
    ahead: 3,
    lastTag: { name: 'v1.3.0', sha: 'b'.repeat(40) },
    existingTags: ['v1.3.0'],
    commits: [],
    changedTotal: 4,
    components: [{ name: 'runner', changedCount: 17, contentAtHead: file('0.1.63'), contentAtTag: file('0.1.62') }],
    changelog: CHANGELOG('### Added\n\n- One.\n- Two.\n- Three.\n\n'),
    ...over,
  });

async function setFacts(f: ReleaseFacts) {
  await q(
    `INSERT INTO repo_release_facts (project_repo_id, request_id, trigger, state, head_sha, facts, requested_at, updated_at)
     VALUES ($1, gen_random_uuid(), 'manual', 'ready', $2, $3::jsonb, now(), now())
     ON CONFLICT (project_repo_id) DO UPDATE SET state='ready', head_sha=$2, facts=$3::jsonb, updated_at=now()`,
    [w.repoId, f.headSha, JSON.stringify(f)],
  );
}

const reconcile = (t: 'release_pr' | 'ahead' | 'manual') => reconcileReleaseProposal(w.t.app.ctx, w.repoId, t);
type Rows = [any, ...any[]]; // the tests assert the length where it matters
const proposals = async () =>
  (await q(`SELECT * FROM release_proposals WHERE repo_id=$1 ORDER BY created_at`, [w.repoId])) as Rows;
const shipItems = async () =>
  (await q(`SELECT * FROM desk_items WHERE subkind='ship_release' AND data->>'repoId'=$1`, [w.repoId])) as Rows;
const eventCount = async (type: string) =>
  Number(((await q(`SELECT count(*)::int AS n FROM events WHERE type=$1`, [type])) as Rows)[0].n);

beforeEach(async () => {
  await freshState();
  await q(`TRUNCATE release_proposals, repo_release_facts`);
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
});

describe('release proposal reconcile (docs/ARCHITECTURE.md 28b)', () => {
  it('creates exactly one desk item and one ReleaseProposed for repeated results', async () => {
    const before = await eventCount('ReleaseProposed');
    await setFacts(facts());
    await reconcile('release_pr');
    await reconcile('release_pr');
    await reconcile('manual');
    await reconcile('ahead');
    expect(await proposals()).toHaveLength(1);
    expect(await shipItems()).toHaveLength(1);
    expect(await eventCount('ReleaseProposed')).toBe(before + 1);
    const [p] = await proposals();
    expect(p).toMatchObject({ state: 'proposed', recommended_version: '1.4.0', recommended_level: 'minor' });
  });

  it('the partial unique index rejects a second live proposal for a repository', async () => {
    await setFacts(facts());
    await reconcile('manual');
    const [p] = await proposals();
    await expect(
      q(
        `INSERT INTO release_proposals (id, org_id, project_id, repo_id, desk_item_id, state, trigger, recommended_version,
                                        recommended_level, reason, head_sha, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, gen_random_uuid(), 'proposed', 'manual', '1.4.0', 'minor', 'r', $4, now(), now())`,
        [p.org_id, p.project_id, p.repo_id, HEAD],
      ),
    ).rejects.toThrow(/release_proposals_one_live/);
  });

  it('closes the proposal and dismisses the item when nothing is ahead any more', async () => {
    await setFacts(facts());
    await reconcile('manual');
    await setFacts(facts({ ahead: 0 }));
    await reconcile('ahead');
    const [p] = await proposals();
    expect(p).toMatchObject({ state: 'closed', closed_reason: 'nothing_to_release' });
    const [item] = await shipItems();
    expect(item.status).toBe('dismissed');
  });

  it('does not re-propose on the ahead trigger after a dismissal while the last tag is unchanged', async () => {
    await setFacts(facts());
    await reconcile('manual');
    const [item] = await shipItems();
    await ok(w.t.req('POST', `/api/desk/${item.id}/dismiss`, { cookie: w.owner.cookie, body: {} }));
    expect((await proposals())[0]).toMatchObject({ state: 'dismissed' });
    await reconcile('ahead');
    expect(await proposals()).toHaveLength(1);
    // An explicit request (Prepare release) does propose again.
    await reconcile('manual');
    expect(await proposals()).toHaveLength(2);
    // A new tag also allows the heartbeat to propose again.
    await q(`UPDATE release_proposals SET state='dismissed' WHERE state='proposed'`);
    await setFacts(facts({ lastTag: { name: 'v1.4.0', sha: 'c'.repeat(40) }, existingTags: ['v1.3.0', 'v1.4.0'] }));
    await reconcile('ahead');
    expect((await proposals()).filter((x) => x.state === 'proposed')).toHaveLength(1);
  });

  it('keeps an approved proposal live until its tag appears (no second item meanwhile), then closes it as released', async () => {
    await setFacts(facts());
    await reconcile('manual');
    const [item] = await shipItems();
    await ok(
      w.t.req('POST', `/api/desk/${item.id}/resolve`, {
        cookie: w.owner.cookie,
        body: {
          resolution: 'approved',
          release: { version: '1.4.0', components: [], factsHeadSha: HEAD },
        },
      }),
    );
    expect((await proposals())[0]).toMatchObject({ state: 'approved', version: '1.4.0' });
    // Never tagged: still one live proposal and no second item, whatever the trigger.
    await reconcile('manual');
    await reconcile('ahead');
    expect(await proposals()).toHaveLength(1);
    expect(await shipItems()).toHaveLength(1);
    // The tag appears: released.
    await setFacts(facts({ lastTag: { name: 'v1.4.0', sha: 'c'.repeat(40) }, existingTags: ['v1.3.0', 'v1.4.0'] }));
    await reconcile('ahead');
    expect((await proposals())[0]).toMatchObject({ state: 'released', closed_reason: 'released' });
  });
});

describe('Ship release approval (resolveShipReleaseIn)', () => {
  let itemId: string;
  const approve = (release: Record<string, unknown>, cookie = w.owner.cookie) =>
    w.t.req('POST', `/api/desk/${itemId}/resolve`, { cookie, body: { resolution: 'approved', release } });

  beforeEach(async () => {
    await setFacts(facts());
    await reconcile('manual');
    itemId = (await shipItems())[0].id;
  });

  it('refuses a member who is not the owner', async () => {
    const m = await addMember(w, 'shipper');
    const r = await approve({ version: '1.4.0', components: [], factsHeadSha: HEAD }, m.cookie);
    expect(r.status).toBe(403);
    expect((await proposals())[0].state).toBe('proposed');
  });

  it('409 proposal_changed when the working branch moved', async () => {
    const r = await approve({ version: '1.4.0', components: [], factsHeadSha: 'f'.repeat(40) });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('proposal_changed');
  });

  it('400 invalid_version for non-semver, equal and lower versions', async () => {
    for (const version of ['next', '1.3.0', '1.2.9']) {
      const r = await approve({ version, components: [], factsHeadSha: HEAD });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toContain('invalid_version');
    }
    expect((await proposals())[0].state).toBe('proposed');
  });

  it('400 for an unknown component', async () => {
    const r = await approve({
      version: '1.4.0',
      components: [{ name: 'nope', level: 'patch' }],
      factsHeadSha: HEAD,
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('unknown_component');
  });

  it('records ReleaseApproved with server-recomputed bumps and queues nothing', async () => {
    const queued = async () =>
      Number(((await q(`SELECT count(*)::int AS n FROM runner_commands`)) as Rows)[0].n);
    const cmdsBefore = await queued();
    const before = await eventCount('ReleaseApproved');
    const r = await approve({ version: '1.4.0', components: [{ name: 'runner', level: 'minor' }], factsHeadSha: HEAD });
    expect(r.status).toBe(200);
    expect(await eventCount('ReleaseApproved')).toBe(before + 1);
    const [p] = await proposals();
    expect(p).toMatchObject({ state: 'approved', version: '1.4.0', notes_source: 'changelog' });
    // The tag has runner 0.1.62 and head already 0.1.63: the bump is computed from the tagged version.
    expect(JSON.stringify(p.components)).toContain('runner');
    expect(await queued()).toBe(cmdsBefore);
  });

  it('409 proposal_closed once the proposal is no longer open', async () => {
    await q(`UPDATE release_proposals SET state='dismissed'`);
    const r = await approve({ version: '1.4.0', components: [], factsHeadSha: HEAD });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('proposal_closed');
  });
});
