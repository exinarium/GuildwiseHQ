import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyDeployRisk, FIX_BUDGETS, maskText, topFrames } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agentView, candidateCards } from '../src/dispatcher/candidates.ts';
import { reportServerError, platformPass, platformScan } from '../src/platform-team/detectors.ts';
import { drainBugs, reportBug } from '../src/platform-team/intake.ts';
import { startPause } from '../src/platform-team/pause.ts';
import { overBudget, platformFixBudget } from '../src/platform-team/stop-loss.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, markOnline, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let root: { id: string; cookie: string; email: string };
let releaseDir: string;
let ctx: World['t']['app']['ctx'];
let orgId: string;
let platformProjectId: string;
let toyId: string;

beforeAll(async () => {
  releaseDir = mkdtempSync(join(tmpdir(), 'aom-release-'));
  for (const v of ['0.1.20', '0.1.24']) writeFileSync(join(releaseDir, `aom-runner-${v}.tgz`), `fake ${v}`);
  w = await createWorld({
    env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_RUNNER_RELEASE_DIR: releaseDir },
  });
  ctx = w.t.app.ctx;
  r = await w.connectRunner({ capabilities: ['runner-pin:1'] });
  root = await w.t.superAdminSession();
  orgId = w.owner.id;
  toyId = w.projectId;
  const p = await ok<any>(
    w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key: 'PLT', name: 'Platform' } }),
    201,
  );
  platformProjectId = p.project.id;
  await addRepo(platformProjectId);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  rmSync(releaseDir, { recursive: true, force: true });
  await closeAdminPool();
});
beforeEach(async () => {
  await freshState();
  await q(
    `TRUNCATE platform_pauses, platform_bugs, platform_bug_hits, platform_deploy_audit, platform_deploy_approvals,
       platform_diag_grants, platform_diag_access, workstation_runner_pins, runner_errors, runner_error_workstations,
       workstation_role_blocks RESTART IDENTITY CASCADE`,
  );
  await q(`DELETE FROM platform_settings WHERE key IN ('platform.team','runners.version_pin')`);
  await q(`DELETE FROM events WHERE type LIKE 'Platform%'`).catch(() => undefined);
  ctx.services.dispatcher.cooldown.clear();
});

/** A project needs the toy repository (the vault gate offers repo-less cards to nobody) and a workstation that holds it. */
async function addRepo(projectId: string) {
  await ok(
    w.t.req('POST', `/api/projects/${projectId}/repos`, {
      cookie: w.owner.cookie,
      body: { name: 'toy', remoteUrl: 'https://github.com/acme/toy.git' },
    }),
    201,
  );
  await markOnline(w.t, w.workstationId, { repoIds: (await q('SELECT id FROM project_repos')).map((x) => x.id) });
}
async function newProject(key: string): Promise<string> {
  const p = await ok<any>(
    w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key, name: key } }),
    201,
  );
  await addRepo(p.project.id);
  return p.project.id;
}

const api = (method: string, url: string, body?: unknown, cookie = w.owner.cookie) =>
  w.t.req(method, url, { cookie, body });
const designate = () =>
  ok<any>(w.t.req('PUT', '/api/platform/team', { cookie: root.cookie, body: { orgId, projectId: platformProjectId } }));
const eventsOf = async (type: string) =>
  (await q('SELECT payload FROM events WHERE type=$1 ORDER BY seq', [type])).map((e) => e.payload);
const bugRows = () => q('SELECT * FROM platform_bugs ORDER BY created_at');
const platformCards = () => q(`SELECT * FROM cards WHERE project_id=$1 ORDER BY number`, [platformProjectId]);
const deskItems = (subkind?: string) =>
  q(`SELECT * FROM desk_items WHERE org_id=$1 ${subkind ? 'AND subkind=$2' : ''} ORDER BY created_at`, [
    orgId,
    ...(subkind ? [subkind] : []),
  ]);

/** A card of the affected project (TOY) that the loop breaker holds back: 3 failed shifts in an episode. */
async function loopingCard(projectId = toyId, title = 'Looping card') {
  const card = await w.card({ title, projectId });
  await q(
    `UPDATE cards SET retry_failures=3, retry_episode_id=gen_random_uuid(), retry_after=now() + interval '10 minutes' WHERE id=$1`,
    [card.id],
  );
  return (await q('SELECT * FROM cards WHERE id=$1', [card.id]))[0]!;
}

describe('designating the platform team (super admin)', () => {
  it('is for the super admin only; the project keeps its decisions at project level', async () => {
    expect((await api('PUT', '/api/platform/team', { orgId, projectId: platformProjectId })).status).toBe(404);
    expect((await api('GET', '/api/platform/team')).status).toBe(404);
    const s = await designate();
    expect(s).toMatchObject({ orgId, projectId: platformProjectId, projectKey: 'PLT' });
    expect(
      (await q('SELECT decisions_project_only FROM projects WHERE id=$1', [platformProjectId]))[0]
        ?.decisions_project_only,
    ).toBe(true);
    expect((await eventsOf('PlatformTeamDesignated')).at(-1)).toMatchObject({ orgId, projectId: platformProjectId });
    // the audit log names the super admin
    expect(
      (await q(`SELECT action FROM platform_audit_log WHERE action='PlatformTeamDesignated'`)).length,
    ).toBeGreaterThan(0);
  });

  it('refuses a project of another organisation and clears the designation', async () => {
    const other = await w.t.userSession(uniqueEmail('other'));
    const op = await ok<any>(
      w.t.req('POST', '/api/projects', { cookie: other.cookie, body: { key: 'OTH', name: 'Other' } }),
      201,
    );
    const bad = await w.t.req('PUT', '/api/platform/team', {
      cookie: root.cookie,
      body: { orgId, projectId: op.project.id },
    });
    expect(bad.status).toBe(400);
    await designate();
    const cleared = await ok<any>(
      w.t.req('PUT', '/api/platform/team', { cookie: root.cookie, body: { orgId: null } }),
    );
    expect(cleared.orgId).toBeNull();
  });
});

describe('bug intake', () => {
  it('records bugs but raises nothing without a platform team; files them once one is designated', async () => {
    const out = await reportBug(ctx, {
      source: 'server_5xx',
      signature: '5xx:GET /x:Error:aaa',
      title: 'GET /x fails',
      description: 'boom',
      diagnostics: { summary: 'boom' },
    });
    expect(out).toMatchObject({ occurrences: 1, cardId: null });
    expect(await platformCards()).toHaveLength(0);
    expect(await deskItems()).toHaveLength(0);
    await designate();
    expect(await drainBugs(ctx)).toBe(1);
    const cards = await platformCards();
    expect(cards).toHaveLength(1);
    expect((await bugRows())[0]?.card_id).toBe(cards[0]?.id);
  });

  it('files one card per signature, with a counter, routed to the platform architect', async () => {
    await designate();
    await w.hire('Arch', 'architect', 'senior');
    await w.hire('Bea', 'builder', 'junior');
    const rep = {
      source: 'server_5xx' as const,
      signature: '5xx:GET /y:TypeError:bbb',
      title: 'GET /y fails with TypeError',
      description: 'x is undefined',
      diagnostics: { summary: 'x is undefined', topFrames: [{ fn: 'handler', file: 'y.ts' }] },
    };
    const a = await reportBug(ctx, rep);
    const b = await reportBug(ctx, rep);
    const c = await reportBug(ctx, rep);
    expect(a.cardId).toBeTruthy();
    expect(b.cardId).toBe(a.cardId);
    expect(c.occurrences).toBe(3);
    const cards = await platformCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ card_type: 'bug', status: 'queued', stage: expect.stringMatching(/investigate/) });
    // one desk item on the platform organisation's desk (not the super admin's: they have none)
    expect(await deskItems('platform_bug')).toHaveLength(1);
    // the architect takes it, the builder does not
    await markOnline(w.t, w.workstationId);
    const made = await ctx.services.dispatcher.runPass();
    const claimed = made.find((m) => m.cardId === cards[0]?.id);
    expect(claimed).toBeTruthy();
    expect((await q('SELECT name FROM agents WHERE id=$1', [claimed?.agentId]))[0]?.name).toBe('Arch');
  });

  it('dedupes runner errors by signature (new signature, then the counter growing)', async () => {
    await designate();
    const err = (over: Record<string, unknown> = {}) => ({
      signature: 'TypeError:doThing (aom-runner.mjs):abcdef0123',
      message: 'cannot read x',
      stack: 'TypeError: cannot read x\n    at doThing (/home/u/runner/aom-runner.mjs:1:1)\n    at run (/home/u/runner/main.mjs:5:2)',
      version: '0.1.24',
      context: 'shift.card',
      ...over,
    });
    r.send('runner.error', err());
    await r.barrier();
    await platformScan(ctx);
    expect(await platformCards()).toHaveLength(1);
    expect((await bugRows())[0]).toMatchObject({ occurrences: 1, source: 'runner_error' });
    r.send('runner.error', err());
    r.send('runner.error', err());
    await r.barrier();
    await platformScan(ctx);
    await platformScan(ctx); // scanning again counts nothing twice
    expect(await platformCards()).toHaveLength(1);
    expect((await bugRows())[0]).toMatchObject({ occurrences: 3 });
    expect((await q('SELECT bug_card_id FROM runner_errors'))[0]?.bug_card_id).toBe((await platformCards())[0]?.id);
    r.send('runner.error', err({ signature: 'Error:other:0000000001', message: 'other', stack: undefined }));
    await r.barrier();
    await platformScan(ctx);
    expect(await platformCards()).toHaveLength(2);
    // sanitised: function and file name only, no directory
    const diag = (await bugRows())[0]?.diagnostics;
    expect(JSON.stringify(diag)).not.toContain('/home/u');
    expect(diag.topFrames[0]).toEqual({ fn: 'doThing', file: 'aom-runner.mjs' });
  });

  it('dedupes server 5xx by route plus error signature, sanitised, and never throws', async () => {
    await designate();
    const req = (route: string) => ({ method: 'POST', routeOptions: { url: route } }) as never;
    const boom = () => {
      const e = new TypeError("cannot read 'secret' of undefined (token=abc123456789 user pieter@example.com)");
      e.stack = `TypeError: x\n    at handler (/srv/app/routes/foo.ts:10:5)\n    at run (/srv/app/lib/run.ts:2:1)`;
      return e;
    };
    reportServerError(ctx, req('/api/foo/:id'), boom());
    reportServerError(ctx, req('/api/foo/:id'), boom());
    reportServerError(ctx, req('/api/bar'), boom());
    await platformScan(ctx); // flushes the aggregated 5xx hits
    const bugs = await bugRows();
    expect(bugs).toHaveLength(2);
    expect(bugs.find((b) => b.signature.includes('/api/foo/:id'))?.occurrences).toBe(2);
    const text = JSON.stringify(bugs.map((b) => b.diagnostics));
    expect(text).not.toContain('abc123456789');
    expect(text).not.toContain('pieter@example.com');
    expect(text).not.toContain('/srv/app');
    expect(() => reportServerError(ctx, null as never, undefined)).not.toThrow();
  });

  it('files a loop bug once per card episode, and counts a second card at the same stage', async () => {
    await designate();
    const a = await loopingCard(toyId, 'Loop A');
    await platformScan(ctx);
    await platformScan(ctx);
    let bugs = await bugRows();
    expect(bugs).toHaveLength(1);
    expect(bugs[0]).toMatchObject({ source: 'loop', occurrences: 1, severity: 'critical' });
    const b = await loopingCard(toyId, 'Loop B');
    await platformScan(ctx);
    bugs = await bugRows();
    expect(bugs).toHaveLength(1);
    expect(bugs[0]?.occurrences).toBe(2);
    expect(await platformCards()).toHaveLength(1);
    // the card carries no client detail: not the ref, not the title
    const body = JSON.stringify((await platformCards())[0]?.fields) + JSON.stringify(bugs[0]?.diagnostics);
    expect(body).not.toContain(a.ref);
    expect(body).not.toContain('Loop A');
    expect(bugs[0]?.extended).toMatchObject({ cardRef: expect.any(String) });
    expect(b.id).not.toBe(a.id);
  });

  it('files a rejection storm once per hour, scoped to the workstation', async () => {
    await designate();
    const agent = await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'Storm' });
    for (let i = 0; i < 8; i++)
      await q(
        `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, stage, status, outcome, rejection_reason, runtime, model, started_at, ended_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'card', 'build', 'ended', 'rejected', 'worktree_failed', 'mock', 'mock', now(), now())`,
        [orgId, agent.id ?? agent.agent?.id, w.workstationId, card.id],
      );
    await platformScan(ctx);
    await platformScan(ctx);
    const bugs = await bugRows();
    expect(bugs).toHaveLength(1);
    expect(bugs[0]).toMatchObject({ source: 'rejection_storm', occurrences: 1, severity: 'critical' });
    expect(bugs[0]?.scope.workstationId).toBe(w.workstationId);
  });

  it('files a role smoke-test failure once per role and version', async () => {
    await designate();
    r.send('role.smoke', { runnerVersion: '0.1.24', results: [{ roleKey: 'builder', ok: false, detail: 'handoff failed' }] });
    await r.barrier();
    await platformScan(ctx);
    await platformScan(ctx);
    const bugs = await bugRows();
    expect(bugs).toHaveLength(1);
    expect(bugs[0]).toMatchObject({ source: 'role_smoke', occurrences: 1, severity: 'degraded' });
    // degraded: no scope, so nothing is paused
    expect(await q('SELECT 1 FROM platform_pauses')).toHaveLength(0);
  });

  it('rate-limits new cards per hour; the rest is recorded and filed later', async () => {
    await designate();
    for (let i = 0; i < 15; i++)
      await reportBug(ctx, {
        source: 'server_5xx',
        signature: `5xx:GET /r${i}:Error:${i}`,
        title: `GET /r${i} fails`,
        description: 'x',
        diagnostics: {},
      });
    expect(await platformCards()).toHaveLength(12);
    expect(await bugRows()).toHaveLength(15);
    // an hour later the rest is filed
    w.t.clock.advance(61 * 60_000);
    try {
      expect(await drainBugs(ctx)).toBe(3);
      expect(await platformCards()).toHaveLength(15);
    } finally {
      w.t.clock.setOffset(0);
    }
  });
});

describe('scoped pauses', () => {
  async function bugAt(project = toyId) {
    const card = await loopingCard(project, 'Looping');
    await platformScan(ctx);
    return card;
  }
  const pauses = () => q('SELECT * FROM platform_pauses ORDER BY created_at');

  it('a critical bug pauses exactly its scope; the dispatcher skips that and nothing else', async () => {
    await designate();
    await w.hire('Bea', 'builder', 'junior');
    await markOnline(w.t, w.workstationId, {
      repoIds: (await q('SELECT id FROM project_repos')).map((x) => x.id),
    });
    const stuck = await bugAt();
    const list = await pauses();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      project_id: toyId,
      stage_id: stuck.stage,
      source: 'auto',
      severity: 'critical',
      resumed_at: null,
    });
    expect(list[0]?.workflow_key).toBeTruthy();
    expect(list[0]?.bug_card_id).toBe((await platformCards())[0]?.id);
    // a new card at the paused stage of the paused project is not offered...
    const agentRow = (await q(`SELECT * FROM agents WHERE name='Bea'`))[0]!;
    const view = agentView(agentRow, ['shell', 'edit', 'web']);
    const paused = await w.card({ title: 'Held by the pause' });
    const offered = async () => (await candidateCards(ctx.pool, view, ctx.clock.now())).map((c) => c.id);
    expect(await offered()).not.toContain(paused.id);
    // ...a card of another project is (same workflow, same stage)
    const free = await w.card({ title: 'Free', projectId: await newProject(`OK${Math.floor(Math.random() * 90 + 10)}`) });
    expect(await offered()).toContain(free.id);
    // the platform project's own cards are never held, whatever the scope
    const own = await w.card({ title: 'Platform work', projectId: platformProjectId });
    expect(await offered()).toContain(own.id);
    // every pause is told to the platform organisation's desk
    expect(await deskItems('platform_pause')).toHaveLength(1);
    expect((await eventsOf('PlatformPauseStarted'))[0]).toMatchObject({ source: 'auto', severity: 'critical' });
  });

  it('resumes by itself when the linked bug card is done, and tells the desk', async () => {
    await designate();
    await bugAt();
    const bugCard = (await platformCards())[0]!;
    expect(await pauses()).toHaveLength(1);
    await platformPass(ctx, { force: true });
    expect((await pauses())[0]?.resumed_at).toBeNull();
    await q(`UPDATE cards SET status='done' WHERE id=$1`, [bugCard.id]);
    await platformPass(ctx, { force: true });
    const after = (await pauses())[0]!;
    expect(after.resumed_at).not.toBeNull();
    expect(after.resumed_by).toBe('fix');
    expect((await eventsOf('PlatformPauseEnded'))[0]).toMatchObject({ by: 'fix' });
    expect((await bugRows())[0]?.status).toBe('fixed');
    expect(await deskItems('platform_pause')).toHaveLength(2); // paused + resumed
  });

  it('a manual pause and resume from the platform API; repeated pauses of one scope coalesce', async () => {
    await designate();
    const body = { projectId: toyId, reason: 'Bad deploy of the board' };
    const made = await ok<any>(api('POST', '/api/platform-team/pauses', body));
    expect(made.created).toBe(true);
    expect((await pauses())[0]).toMatchObject({ source: 'manual', project_id: toyId });
    const again = await ok<any>(api('POST', '/api/platform-team/pauses', body));
    expect(again.pauseId).toBe(made.pauseId);
    await ok(api('POST', `/api/platform-team/pauses/${made.pauseId}/resume`, { reason: 'fixed by hand' }));
    expect((await pauses())[0]).toMatchObject({ resumed_by: 'manual' });
    await ok(api('POST', '/api/platform-team/pauses', body));
    const items = await deskItems('platform_pause');
    // paused twice -> one open "Paused" item with a counter, one "Resumed" item
    expect(items.filter((i) => i.title.startsWith('Paused')).length).toBe(1);
    expect(items.find((i) => i.title.startsWith('Paused'))?.repeat_count).toBe(2);
    // visible to the people of the affected project
    const mine = await ok<any>(api('GET', '/api/platform-team/my-pauses'));
    expect(mine.pauses).toHaveLength(1);
    expect(mine.pauses[0]).toMatchObject({ projectKey: 'TOY' });
  });

  it('the platform project itself is never paused: not by hand, not by its own bug', async () => {
    await designate();
    const refused = await api('POST', '/api/platform-team/pauses', {
      projectId: platformProjectId,
      reason: 'try to stop the fix flow',
    });
    expect(refused.status).toBe(409);
    expect(await startPause(ctx, { scope: { projectId: platformProjectId }, reason: 'auto', source: 'auto' })).toBeNull();
    // a loop inside the platform project is a bug like any other, but its scope is not paused
    await loopingCard(platformProjectId, 'Platform loop');
    await platformScan(ctx);
    expect((await bugRows())[0]).toMatchObject({ severity: 'critical' });
    expect(await pauses()).toHaveLength(0);
    // a workstation-wide pause still lets the platform project's cards through
    await w.hire('Bea', 'builder', 'junior');
    await markOnline(w.t, w.workstationId);
    await ok(api('POST', '/api/platform-team/pauses', { workstationId: w.workstationId, reason: 'runner crashes' }));
    const view = agentView((await q(`SELECT * FROM agents WHERE name='Bea'`))[0]!, ['shell', 'edit', 'web']);
    const toy = await w.card({ title: 'On the paused workstation' });
    const own = await w.card({ title: 'Platform fix', projectId: platformProjectId });
    const ids = (await candidateCards(ctx.pool, view, ctx.clock.now())).map((c) => c.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(toy.id);
  });
});

describe('pure pieces', () => {
  it('classifies high-risk diffs from path globs (auth/secrets, data/migrations, tenancy/billing)', () => {
    expect(classifyDeployRisk(['apps/web/src/pages/Board.tsx', 'docs/USER-GUIDE.md']).high).toBe(false);
    expect(classifyDeployRisk(['apps/server/src/auth/sessions.ts']).categories).toEqual(['auth_permissions_secrets']);
    expect(classifyDeployRisk(['apps/server/src/commands/target-secrets.ts']).high).toBe(true);
    expect(classifyDeployRisk(['apps/server/migrations/2200_x.sql']).categories).toEqual(['data_migrations']);
    expect(classifyDeployRisk(['apps/server/src/billing/engine.ts']).categories).toEqual(['tenancy_billing']);
    const mixed = classifyDeployRisk(['apps/server/src/authz/scope.ts', 'apps/server/migrations/1.sql', 'a.ts']);
    expect(mixed.categories.sort()).toEqual(['auth_permissions_secrets', 'data_migrations']);
    expect(mixed.paths).toEqual(['apps/server/src/authz/scope.ts', 'apps/server/migrations/1.sql']);
    // sandbox, policy and deploy code is not on the list
    expect(classifyDeployRisk(['apps/runner/src/adapters/claude-policy.ts', 'deploy/prod.sh']).high).toBe(false);
    // windows separators and leading ./ are normalised
    expect(classifyDeployRisk(['.\\apps\\server\\src\\auth\\x.ts'].map((p) => p.replaceAll('\\', '/'))).high).toBe(true);
  });

  it('fix budgets by size: small 2/2/10, medium 3/2/15, large 4/2/25; each extension adds a budget', () => {
    expect(FIX_BUDGETS).toEqual({
      small: { reworkRounds: 2, reviews: 2, shifts: 10 },
      medium: { reworkRounds: 3, reviews: 2, shifts: 15 },
      large: { reworkRounds: 4, reviews: 2, shifts: 25 },
    });
    expect(platformFixBudget({ fixSize: 'small' })).toEqual({ reworkRounds: 2, reviews: 2, shifts: 10 });
    expect(platformFixBudget({ fixSize: 'small', budgetExtra: 1 })).toEqual({ reworkRounds: 4, reviews: 4, shifts: 20 });
    expect(overBudget({ reworkRounds: 3, reviews: 0, shifts: 4 }, platformFixBudget({ fixSize: 'small' }))).toHaveLength(1);
    expect(overBudget({ reworkRounds: 2, reviews: 2, shifts: 10 }, platformFixBudget({ fixSize: 'small' }))).toHaveLength(0);
  });

  it('masks paths, secrets and e-mail addresses; keeps function plus file name of frames', () => {
    expect(maskText('open /home/user/src/x/y.ts with token=abc123 for a@b.co')).not.toMatch(/pieter|abc123|a@b\.co/);
    expect(topFrames('E: x\n    at fn (/a/b/c.ts:1:2)\n    at /d/e.ts:3:4')).toEqual([
      { fn: 'fn', file: 'c.ts' },
      { fn: '(anonymous)', file: 'e.ts' },
    ]);
  });
});

void until;
