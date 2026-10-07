import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatRestructurePlan,
  migrateRestructure,
  planRestructure,
  RESTRUCTURE_MIGRATION,
} from '../src/data-migrations/index.ts';
import { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { buildProjectors, PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { buildLegacyFeeds, type LegacyFeeds } from './fixtures/legacy-feeds.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember, type Member } from './helpers/members.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * `restructure-2026-10` against a realistic legacy fixture (test/fixtures/legacy-feeds.ts): feed project, interests that
 * own feed schedules, an unadopted feed schedule, a research-only interest, taste rules, scans with ratings and
 * transcripts, a guest and a vault.
 */
let w: World;
let guest: Member;
let f: LegacyFeeds;
let vaultId: string;
let scoutId: string;
const ctx = () => w.t.app.ctx;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
// A store with no hooks, like the one the boot migration uses (the site's vault hook is not running then).
const env = () => ({
  pool: ctx().pool,
  store: new PgEventStore(ctx().pool, buildProjectors(), ctx().clock),
  clock: ctx().clock,
  log: () => {},
});
const byName = async (name: string) =>
  (await q('SELECT * FROM interests WHERE name=$1', [name]))[0] as Record<string, any>;

const OPERATIONAL: Record<string, string[]> = {
  users: ['last_login_at', 'last_org_id'],
  workstations: ['connected', 'last_seen_at', 'runtimes', 'hostname', 'platform', 'runner_version'],
  cards: ['lease_expires_at'],
  shifts: ['progress_tail', 'accepted_at'],
  card_transitions: ['id'],
  card_activity: ['id'],
};
async function snapshot(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of PROJECTION_TABLES) {
    const drop = (OPERATIONAL[table] ?? []).map((c) => ` - '${c}'`).join('');
    out[table] = (await q(`SELECT (to_jsonb(t)${drop})::text AS j FROM "${table}" t`))
      .map((r) => r.j as string)
      .sort();
  }
  return out;
}

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  guest = await addMember(w, 'guest');
  f = await buildLegacyFeeds({
    pool: ctx().pool,
    store: ctx().store,
    orgId: (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string,
    ownerId: w.owner.id,
    guestId: guest.id,
  });
  await w.hire('Sid', 'scout', 'junior', { allowedProjectIds: [f.newsId], focusProjectIds: [f.newsId] });
  scoutId = (await q(`SELECT id FROM agents WHERE name='Sid'`))[0]?.id as string;
  vaultId = (
    await ok<any>(
      owner('POST', '/api/vaults', { kind: 'personal', remoteUrl: 'git@example.test:srv/personal.git' }),
      201,
    )
  ).id;
  await q(
    `INSERT INTO workstation_vaults (workstation_id, vault_id, local_path) VALUES ($1,$2,'/vaults/p')`,
    [w.workstationId, vaultId],
  );
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('restructure-2026-10: feed projects become interests', () => {
  it('starts as the legacy shape: a visible feed project, feed schedules, interests without a backing project', async () => {
    const list = await ok<any>(owner('GET', '/api/projects'));
    expect(list.projects.map((p: any) => p.key)).toContain('NEWS');
    expect((await q(`SELECT count(*)::int AS n FROM schedules WHERE kind='feed'`))[0]?.n).toBe(3);
    expect((await q('SELECT count(*)::int AS n FROM interests WHERE project_id IS NULL'))[0]?.n).toBe(3);
    expect((await q('SELECT count(*)::int AS n FROM interest_runs'))[0]?.n).toBe(0);
  });

  it('a dry run reports the plan and writes nothing', async () => {
    const before = (await q('SELECT count(*)::int AS n FROM events'))[0]?.n;
    const r = await migrateRestructure(env(), { dryRun: true });
    expect(r.dryRun).toBe(true);
    const org = r.plan.orgs.find((o) => o.projects.length > 0);
    const news = org?.projects[0];
    expect(news).toMatchObject({
      key: 'NEWS',
      interests: ['Reloading', 'Optics'],
      unlinkedSchedules: ['Shotgun news'],
      schedulesToRemove: 3,
      cards: 4,
      digestItems: 5,
      ratedItems: 3,
      transcripts: 2,
      folder: { from: 'projects/news', to: 'interests/reloading', vault: true },
    });
    expect(org?.researchOnly).toEqual(['Powders']);
    const text = formatRestructurePlan(r.plan);
    expect(text).toContain('feed project NEWS');
    expect(text).toContain('interest "Optics" (gets a new backing project)');
    expect(text).toContain('feed schedule "Shotgun news" becomes an interest');
    expect((await q('SELECT count(*)::int AS n FROM events'))[0]?.n).toBe(before);
    expect((await planRestructure(ctx().pool)).alreadyDone).toBe(false);
  });

  it('migrates: the feed project is hidden and backs its first interest, the others get their own', async () => {
    const r = await migrateRestructure(env());
    expect(r.dryRun).toBe(false);
    const rep = r.orgs.find((o) => o.feedProjects > 0);
    expect(rep).toMatchObject({
      feedProjects: 1,
      interests: 4,
      newProjects: 3,
      schedulesRemoved: 3,
      transcriptsCopied: 4,
      vaultMoves: 1,
      warnings: [],
    });
    const news = (await q('SELECT * FROM projects WHERE id=$1', [f.newsId]))[0];
    expect(news).toMatchObject({
      kind: 'interest',
      vault_dir: 'interests/reloading',
      name: 'Reloading',
      key: 'NEWS',
    });
    expect((await ok<any>(owner('GET', '/api/projects'))).projects.map((p: any) => p.key)).not.toContain(
      'NEWS',
    );
    const reloading = await byName('Reloading');
    expect(reloading).toMatchObject({
      project_id: f.newsId,
      slug: 'reloading',
      domain: 'personal',
      archived_at: null,
    });
    for (const name of ['Optics', 'Shotgun news'.replace('Shotgun news', 'Shotguns'), 'Powders']) {
      const i = await byName(name);
      expect(i.project_id, name).toBeTruthy();
      expect(i.project_id).not.toBe(f.newsId);
      const p = (await q('SELECT * FROM projects WHERE id=$1', [i.project_id]))[0];
      expect(p).toMatchObject({ kind: 'interest', workflow_key: 'feed', vault_dir: `interests/${i.slug}` });
    }
    expect(
      (
        await q('SELECT count(*)::int AS n FROM interests WHERE project_id IS NULL AND archived_at IS NULL')
      )[0]?.n,
    ).toBe(0);
  });

  it('keeps the settings of each interest and turns the unadopted schedule into an interest', async () => {
    const rel = await byName('Reloading');
    expect(rel).toMatchObject({
      status: 'active',
      sub_category: 'shooting/reloading',
      kinds: ['article', 'video', 'podcast'],
      delivery: { mode: 'immediate' },
      scan: { cron: '0 7 * * *', maxItems: 5, manual: false },
      agents: { scout: scoutId },
    });
    expect(rel.next_scan_at).not.toBeNull();
    const opt = await byName('Optics');
    expect(opt).toMatchObject({ status: 'paused', next_scan_at: null, scan: { maxItems: 8 } });
    const shot = await byName('Shotguns');
    expect(shot).toMatchObject({
      status: 'active',
      description: 'Waterfowl loads only',
      preferred_sites: ['https://shotguns.example.test'],
      scan: { windowHours: 48, maxItems: 6, manual: false },
    });
    expect(shot.next_scan_at).not.toBeNull();
    const pow = await byName('Powders');
    expect(pow).toMatchObject({ status: 'active', scan: { manual: true }, next_scan_at: null });
    // nothing runs by itself yet that was not scheduled before: no feed schedule is left
    expect((await q(`SELECT count(*)::int AS n FROM schedules WHERE kind='feed'`))[0]?.n).toBe(0);
  });

  it('links the history through cards.interest_id and builds the run log from it', async () => {
    const rel = await byName('Reloading');
    const opt = await byName('Optics');
    const shot = await byName('Shotguns');
    const owned = async (cardId: string) =>
      (await q('SELECT interest_id FROM cards WHERE id=$1', [cardId]))[0]?.interest_id;
    expect(await owned(f.cards.reloading)).toBe(rel.id);
    expect(await owned(f.cards.manual)).toBe(rel.id); // an untagged feed card goes to the first interest
    expect(await owned(f.cards.optics)).toBe(opt.id);
    expect(await owned(f.cards.shotguns)).toBe(shot.id); // the unadopted schedule's cards
    expect(await owned(f.cards.research)).toBe(rel.id); // the research card keeps its tag (an external note)
    const runs = await q(
      `SELECT i.name, r.kind, r.trigger, r.status, r.published FROM interest_runs r JOIN interests i ON i.id = r.interest_id ORDER BY i.name, r.started_at`,
    );
    expect(runs).toEqual([
      { name: 'Optics', kind: 'scan', trigger: 'migrated', status: 'nothing', published: 0 },
      { name: 'Reloading', kind: 'scan', trigger: 'migrated', status: 'published', published: 3 },
      { name: 'Reloading', kind: 'scan', trigger: 'migrated', status: 'queued', published: null },
      { name: 'Shotguns', kind: 'scan', trigger: 'migrated', status: 'published', published: 2 },
    ]);
    const log = await ok<any>(owner('GET', `/api/interests/${rel.id}/runs`));
    expect(log.runs.map((r: any) => r.trigger)).toEqual(['migrated', 'migrated']);
    const done = log.runs.find((r: any) => r.status === 'published');
    expect(done.ratings).toEqual({ useful: 1, irrelevant: 1, boring: 0, unrated: 1 });
    // the digest items and ratings are untouched, and the running list is whole
    expect(
      (await q('SELECT count(*)::int AS n FROM digest_items WHERE delivered_at IS NOT NULL'))[0]?.n,
    ).toBe(5);
    const digest = await ok<any>(owner('GET', `/api/interests/${rel.id}/digest`));
    expect(digest.items).toHaveLength(3);
    const detail = await ok<any>(owner('GET', `/api/interests/${rel.id}`));
    expect(detail.interest.stats.ratings).toEqual({ useful: 1, irrelevant: 1, boring: 0, unrated: 1 });
  });

  it('copies the seen-list, the transcripts and the members to each new backing project', async () => {
    const opt = await byName('Optics');
    const shot = await byName('Shotguns');
    for (const i of [opt, shot]) {
      expect(
        (await q('SELECT count(*)::int AS n FROM feed_seen WHERE project_id=$1', [i.project_id]))[0]?.n,
      ).toBe(5);
      expect(
        (await q('SELECT count(*)::int AS n FROM transcripts WHERE project_id=$1', [i.project_id]))[0]?.n,
      ).toBe(2);
      const members = (
        await q(`SELECT user_id FROM project_members WHERE project_id=$1 AND status='active'`, [i.project_id])
      ).map((m) => m.user_id);
      expect(members).toEqual(expect.arrayContaining([w.owner.id, guest.id]));
    }
    expect((await q('SELECT count(*)::int AS n FROM feed_seen WHERE project_id=$1', [f.newsId]))[0]?.n).toBe(
      5,
    );
    expect(
      (await q('SELECT count(*)::int AS n FROM transcripts WHERE project_id=$1', [f.newsId]))[0]?.n,
    ).toBe(2);
    // the guest sees the interests; a stranger does not
    const seen = await ok<any>(w.t.req('GET', '/api/interests', { cookie: guest.cookie }));
    expect(seen.interests.map((i: any) => i.name).sort()).toEqual(['Optics', 'Reloading', 'Shotguns']);
  });

  it('turns the project taste rules into the rules of each interest', async () => {
    expect(await byName('Reloading')).toMatchObject({
      taste_rules: ['Prefer primary sources', 'Skip beginner tutorials'],
      taste_version: 4,
    });
    expect((await byName('Optics')).taste_rules).toEqual([
      'Prefer primary sources',
      'Skip optics reviews of one product',
    ]);
    expect((await byName('Shotguns')).taste_rules).toEqual(['Prefer primary sources']);
  });

  it('queues the folder move first, then INTEREST.md and taste.md writes, with the imported rating lines for new folders', async () => {
    const cmds = await q<{ type: string; payload: any }>(
      'SELECT type, payload FROM runner_commands ORDER BY id',
    );
    const mine = cmds.filter((c) => c.type === 'vault.move' || c.type === 'vault.write');
    const moves = mine.filter((c) => c.type === 'vault.move');
    expect(moves).toHaveLength(1);
    expect(moves[0]?.payload).toMatchObject({
      vaultId,
      from: 'projects/news',
      to: 'interests/reloading',
      push: true,
    });
    // the move comes before every write into the new folders
    const firstWrite = mine.findIndex(
      (c) => c.type === 'vault.write' && c.payload.path.startsWith('interests/'),
    );
    expect(mine.findIndex((c) => c.type === 'vault.move')).toBeLessThan(firstWrite);
    const writes = mine.filter((c) => c.type === 'vault.write').map((c) => c.payload);
    expect(
      writes.some((p) => p.path === 'interests/reloading/INTEREST.md' && p.section.id === 'interest'),
    ).toBe(true);
    const seed = writes.find((p) => p.path === 'interests/reloading/taste.md' && p.section.id === 'seed');
    expect(seed.section.version).toBe(4);
    expect(seed.content).toContain('- Rule: Skip beginner tutorials');
    const imported = writes.find(
      (p) => p.path === 'interests/optics/taste.md' && p.section.id === 'imported',
    );
    expect(imported.content).toContain('Prefer articles like');
    expect(imported.content).toContain('Skip articles like');
    // the first interest keeps its own taste.md (it moves with the folder): no imported section for it
    expect(writes.some((p) => p.path === 'interests/reloading/taste.md' && p.section.id === 'imported')).toBe(
      false,
    );
  });

  it('posts one desk report for the Owner and records itself', async () => {
    const report = (
      await q(`SELECT title, body, kind, subkind FROM desk_items WHERE subkind='restructure_migrated'`)
    )[0];
    expect(report).toMatchObject({ kind: 'alert', title: 'Feed projects became interests' });
    expect(report?.body).toContain('1 feed project became 4 interests');
    expect(report?.body).toContain('3 feed schedules were removed');
    const done = (await q('SELECT summary FROM data_migrations WHERE name=$1', [RESTRUCTURE_MIGRATION]))[0];
    expect(done).toBeTruthy();
    expect((await planRestructure(ctx().pool)).alreadyDone).toBe(true);
  });

  it('is idempotent: running it again changes nothing', async () => {
    const events = (await q('SELECT count(*)::int AS n FROM events'))[0]?.n;
    const cmds = (await q('SELECT count(*)::int AS n FROM runner_commands'))[0]?.n;
    const r = await migrateRestructure(env());
    expect(r.orgs.every((o) => o.feedProjects === 0 && o.interests === 0)).toBe(true);
    expect(r.plan.orgs).toEqual([]);
    expect((await q('SELECT count(*)::int AS n FROM events'))[0]?.n).toBe(events);
    expect((await q('SELECT count(*)::int AS n FROM runner_commands'))[0]?.n).toBe(cmds);
  });

  it('a rebuild of the projections reproduces the migrated database exactly', async () => {
    const before = await snapshot();
    expect(before.interest_runs?.length).toBe(4);
    await rebuildProjections(ctx().pool, ctx().store);
    expect(await snapshot()).toEqual(before);
    // the operational tables survive too
    expect((await q('SELECT count(*)::int AS n FROM transcripts'))[0]?.n).toBe(6);
  });

  it('the migrated interests work: a run goes to the right backing project and is dispatched like any other', async () => {
    const opt = await byName('Optics');
    const run = await ok<any>(owner('POST', `/api/interests/${opt.id}/run`, {}), 201);
    const c = (
      await q('SELECT project_id, interest_id, origin, scheduled FROM cards WHERE id=$1', [run.cardId])
    )[0];
    expect(c).toMatchObject({
      project_id: opt.project_id,
      interest_id: opt.id,
      origin: 'interest',
      scheduled: true,
    });
    // history stays whole next to the new run
    const log = await ok<any>(owner('GET', `/api/interests/${opt.id}/runs`));
    expect(log.runs.map((r: any) => r.trigger)).toEqual(['manual', 'migrated']);
    // the old manual feed card is still queued: it counts as the run in progress, and the numbers continue after it
    const rel = await byName('Reloading');
    const busy = await owner('POST', `/api/interests/${rel.id}/run`, {});
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatchObject({ code: 'run_in_progress', details: { ref: 'NEWS-3' } });
    await ok(owner('POST', '/api/cards/NEWS-3/cancel', { reason: 'old run' }));
    const next = await ok<any>(owner('POST', `/api/interests/${rel.id}/run`, {}), 201);
    expect(next.ref).toBe('NEWS-5');
    expect((await owner('GET', `/api/board?projectId=${f.newsId}`)).status).toBe(409);
    // the old addresses lead to the interest page: the project key resolves through the interests list
    const list = await ok<any>(owner('GET', '/api/interests'));
    expect(list.interests.find((i: any) => i.projectKey === 'NEWS')?.name).toBe('Reloading');
  });
});
