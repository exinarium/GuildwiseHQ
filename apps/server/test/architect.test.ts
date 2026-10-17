import { randomUUID } from 'node:crypto';
import { CardDetailResponseSchema } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, DIFF_SMALL, eventsOfType, pipeline } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, fullFields, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const cookie = () => w.owner.cookie;
const SHORT = { context: 'why', requirements: 'what' };
const REPORT = 'docs/investigations/TOY-1-report.md';
const design = (over: Record<string, unknown> = {}, outcomeId = 'handoff') => ({
  kind: 'outcome',
  outcomeId,
  note: 'designed',
  data: {
    reportPath: REPORT,
    summary: 'Build it in module X.',
    location: 'repo',
    commit: 'abc1234',
    ...over,
  },
});
/** The BA's finalize report: no action (an agent never chooses it); `none` only to test the legacy value. */
const finalized = (action?: string) => ({
  kind: 'outcome',
  outcomeId: 'finalized',
  note: 'ok',
  data: action ? { action } : {},
});
const patch = (id: string, body: Record<string, unknown>) =>
  w.t.req('PATCH', `/api/cards/${id}`, { cookie: cookie(), body });
const desk = () => ok<any>(w.t.req('GET', '/api/desk', { cookie: cookie() }));
const setArchitect = (body: Record<string, unknown>) =>
  w.t.req('PUT', `/api/projects/${w.projectId}/architect-settings`, {
    cookie: cookie(),
    body: {
      designStep: false,
      mergeMainFirst: true,
      investigationPath: 'docs/investigations',
      investigationLocation: 'repo',
      ...body,
    },
  });

async function team(opts: { architect?: boolean } = {}) {
  await freshState();
  await q(`UPDATE project_repos SET main_branch=NULL, working_branch=NULL WHERE id=$1`, [w.repoId]);
  await q(
    `UPDATE projects SET design_step=false, merge_main_first=true, investigation_path='docs/investigations',
            investigation_location='repo' WHERE id=$1`,
    [w.projectId],
  );
  await w.hire('Bea', 'builder', 'junior');
  await w.hire('Rex', 'reviewer', 'senior');
  await w.hire('Tess', 'tester', 'junior');
  await w.hire('Ben', 'ba', 'senior');
  if (opts.architect !== false) await w.hire('Aria', 'architect', 'senior');
}

/**
 * The next shift.start for an agent whose card still exists: dispatching is eager, so the frames of earlier tests'
 * cards (truncated since) can still be waiting in the fake runner's list.
 */
async function next(agentName: string) {
  for (;;) {
    const start = await p.next(agentName);
    if ((await q('SELECT 1 FROM cards WHERE id=$1', [start.brief.card.id])).length > 0) return start;
  }
}

/** An rpc from a running shift, answered by the server. */
async function rpc(shiftId: string, method: string, params: Record<string, unknown> = {}) {
  const rpcId = randomUUID();
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId, method, params });
  return r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 15_000, from);
}

describe('the design step is off unless the project opts in', () => {
  it('defaults: design step off, merge main first on, reports in docs/investigations in the repository', async () => {
    await team();
    const detail = await ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: cookie() }));
    expect(detail.project).toMatchObject({
      designStep: false,
      mergeMainFirst: true,
      investigationPath: 'docs/investigations',
      investigationLocation: 'repo',
    });
  });

  it('a new card goes straight to build; the project setting or the card turns the design on', async () => {
    await team();
    const a = await w.card({ title: 'plain' });
    expect(a).toMatchObject({ designNeeded: false, investigationOnly: false, stage: 'build' });
    expect(a.workflowVersion).toBe(5);
    // the card asks for it
    const b = await w.card({ title: 'asks', designNeeded: true });
    expect(b).toMatchObject({ designNeeded: true, stage: 'investigate', status: 'queued' });
    // the project asks for it; the card can still opt out
    await ok(setArchitect({ designStep: true }));
    const c = await w.card({ title: 'project default' });
    expect(c).toMatchObject({ designNeeded: true, stage: 'investigate' });
    const d = await w.card({ title: 'opt out', designNeeded: false });
    expect(d).toMatchObject({ designNeeded: false, stage: 'build' });
  });

  it('only the project owner or an organization manager changes the architect settings', async () => {
    await team();
    const detail = await ok<any>(
      setArchitect({ investigationPath: 'design/reports', investigationLocation: 'repo' }),
    );
    expect(detail.project).toMatchObject({ investigationPath: 'design/reports' });
    // paths must be relative folders
    expect((await setArchitect({ investigationPath: '../etc' })).status).toBe(400);
    expect((await setArchitect({ investigationPath: '/abs' })).status).toBe(400);
    expect((await setArchitect({ investigationPath: 'vault:x' })).status).toBe(400);
    const anon = await w.t.req('PUT', `/api/projects/${w.projectId}/architect-settings`, {
      body: {
        designStep: true,
        mergeMainFirst: true,
        investigationPath: 'docs/investigations',
        investigationLocation: 'repo',
      },
    });
    expect(anon.status).toBe(401);
  });

  it('the Design board column shows only when the step is on or a card is in it', async () => {
    await team();
    const cols = async () =>
      (
        await ok<any>(w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: cookie() }))
      ).columns.map((c: any) => c.name);
    expect(await cols()).not.toContain('Design');
    await w.card({ title: 'one', designNeeded: true });
    expect(await cols()).toContain('Design');
    await freshState();
    expect(await cols()).not.toContain('Design');
    await ok(setArchitect({ designStep: true }));
    expect(await cols()).toContain('Design');
  });
});

describe('desk notice: the design step on with no architect hired', () => {
  it('raises one notice per project, none when an architect exists', async () => {
    await team({ architect: false });
    await q(`DELETE FROM desk_items WHERE subkind='no_architect'`);
    await ok(setArchitect({ designStep: true }));
    await ok(setArchitect({ designStep: true }));
    const items = (await desk()).items.filter((i: any) => i.subkind === 'no_architect');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'alert', blocking: false });
    expect(items[0].title).toContain('no architect');
    // an architect is hired: switching the step on again raises nothing new
    await q(`DELETE FROM desk_items WHERE subkind='no_architect'`);
    await w.hire('Aria', 'architect', 'senior');
    await ok(setArchitect({ designStep: false }));
    await ok(setArchitect({ designStep: true }));
    expect((await desk()).items.filter((i: any) => i.subkind === 'no_architect')).toHaveLength(0);
    await ok(setArchitect({ designStep: false }));
  });

  it('a card waiting in the design stage says an architect must be hired', async () => {
    await team({ architect: false });
    const card = await w.card({ designNeeded: true });
    const board = await ok<any>(w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: cookie() }));
    const entry = board.columns.flatMap((c: any) => c.cards).find((c: any) => c.id === card.id);
    expect(entry.workability).toMatchObject({
      ok: false,
      level: 'blocked',
      hire: { roleKey: 'architect', seniority: 'senior' },
    });
    expect(entry.workability.reason).toMatch(/no architect is hired/i);
  });
});

describe('specify: required fields along the card route', () => {
  it('a build card still needs the full field set', async () => {
    await team();
    const draft = await w.card({ title: 'draft', fields: SHORT, specify: false });
    const res = await w.t.req('POST', `/api/cards/${draft.id}/specify`, { cookie: cookie() });
    expect(res.status).toBe(422);
    expect(res.body.error.details.missing).toEqual(
      expect.arrayContaining(['acceptanceCriteria', 'affectedAreas', 'constraints', 'testPlan']),
    );
  });

  it('an investigation-only card needs only the short set and goes to investigate', async () => {
    await team();
    const card = await w.card({ title: 'compare', investigationOnly: true, fields: SHORT });
    expect(card).toMatchObject({
      investigationOnly: true,
      designNeeded: true,
      stage: 'investigate',
      status: 'queued',
    });
    const missing = await w.card({
      title: 'thin',
      investigationOnly: true,
      fields: { context: 'x' },
      specify: true,
    });
    expect(missing.status).toBe('draft');
  });

  it('refuses investigation-only without design, and a flag the workflow cannot hold', async () => {
    await team();
    const body = {
      projectId: w.projectId,
      title: 'x',
      cardType: 'feature',
      fields: SHORT,
      investigationOnly: true,
      designNeeded: false,
    };
    const res = await w.t.req('POST', '/api/cards', { cookie: cookie(), body });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('investigation_needs_design');
  });

  it('the flags can be changed on a draft or a card waiting to be investigated, and are locked after', async () => {
    await team();
    const d = await w.card({ title: 'later', specify: false, fields: SHORT });
    expect((await patch(d.id, { designNeeded: true })).status).toBe(200);
    expect((await patch(d.id, { investigationOnly: true, designNeeded: false })).status).toBe(400);
    expect((await patch(d.id, { investigationOnly: true })).status).toBe(200);
    expect(await cardRow(d.id)).toMatchObject({ investigation_only: true, design_needed: true });
    // a card already in build cannot be turned into a design card
    const b = await w.card({ title: 'in build' });
    const res = await patch(b.id, { designNeeded: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('design_locked');
  });
});

describe('the architect shift', () => {
  it('claims investigate, creates the worktree, hands the design to the builder with the report', async () => {
    await team();
    const card = await w.card({ title: 'Add greeting', designNeeded: true });
    const start = await next('Aria');
    expect(start.brief.shift).toMatchObject({ stage: 'investigate' });
    expect(start.brief.shift.outcomes.map((o: any) => o.id)).toEqual(['handoff']);
    expect(start.worktree).toMatchObject({ mode: 'create' });
    expect(start.agent.permissions.readOrgRepos).toBe(true);
    expect(start.brief.investigation).toMatchObject({
      reportPath: `docs/investigations/${card.ref}-add-greeting.md`,
      location: 'repo',
      folder: 'docs/investigations',
      investigationOnly: false,
    });
    await p.startShift(r, start);
    const res = await p.report(
      r,
      start.shiftId,
      design({ reportPath: start.brief.investigation!.reportPath }),
    );
    expect(res).toMatchObject({ accepted: true });
    r.ended(start.shiftId, 'reported');
    await until(async () => (await cardRow(card.id)).stage === 'build', 3000, 'card moved to build');
    expect((await cardRow(card.id)).investigation).toMatchObject({
      reportPath: start.brief.investigation!.reportPath,
      location: 'repo',
      summary: 'Build it in module X.',
    });
    const events = (await eventsOfType('InvestigationReported')).filter((e) => e.cardId === card.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ commit: 'abc1234', investigationOnly: false });

    // the builder reuses the architect's worktree and reads the report
    const build = await next('Bea');
    expect(build.worktree).toMatchObject({ mode: 'reuse' });
    expect(build.brief.investigation!.report).toMatchObject({
      reportPath: start.brief.investigation!.reportPath,
      summary: 'Build it in module X.',
    });
    expect(build.brief.handoffs.map((h: any) => h.stage)).toContain('investigate');

    // the card shows the report with a link on the forge
    const dto = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: cookie() }));
    expect(dto.card.investigation).toMatchObject({ location: 'repo', commit: 'abc1234' });
    expect(dto.card.investigation.url).toMatch(/^https:\/\/github\.com\/acme\/toy\/blob\//);
  });

  it('refuses `report` on a build card and `handoff` on an investigation-only card', async () => {
    await team();
    await w.card({ title: 'build card', designNeeded: true });
    // an outcome that does not exist in this stage is the runner's job; the server still refuses a guarded one
    const only = await w.card({ title: 'only card', investigationOnly: true, fields: SHORT });
    const start = await next('Aria');
    expect(start.brief.card.ref).toBeDefined();
    const first = start.brief.card.id === only.id ? 'only' : 'build';
    await p.startShift(r, start);
    if (first === 'only') {
      expect(start.brief.shift.outcomes.map((o: any) => o.id)).toEqual(['report']);
      const bad = await p.report(r, start.shiftId, design());
      expect(bad.accepted).toBe(false);
      expect(bad.error).toMatch(/does not apply.*investigation-only.*allowed outcomes: report/);
    } else {
      expect(start.brief.shift.outcomes.map((o: any) => o.id)).toEqual(['handoff']);
      const bad = await p.report(r, start.shiftId, design({}, 'report'));
      expect(bad.accepted).toBe(false);
      expect(bad.error).toMatch(/does not apply.*allowed outcomes: handoff/);
    }
  });

  it('the report path in the brief follows the card, then the project, then the default', async () => {
    await team();
    // a vault: card path needs a vault
    if ((await q(`SELECT 1 FROM vaults WHERE kind='org'`)).length === 0)
      await ok(
        w.t.req('POST', '/api/vaults', {
          cookie: cookie(),
          body: { kind: 'org', remoteUrl: 'git@example.test:srv/work.git' },
        }),
        201,
      );
    await ok(setArchitect({ investigationPath: 'design/notes', investigationLocation: 'repo' }));
    const a = await w.card({ title: 'Project path', designNeeded: true });
    const b = await w.card({
      title: 'Card path',
      designNeeded: true,
      fields: fullFields({ reportPath: 'docs/special/answer.md' }),
    });
    const c = await w.card({
      title: 'In the vault',
      designNeeded: true,
      fields: fullFields({ reportPath: 'vault:research' }),
    });
    const seen = new Map<string, any>();
    for (let i = 0; i < 3; i++) {
      const s = await next('Aria');
      seen.set(s.brief.card.id, s.brief.investigation);
      await p.startShift(r, s);
      await p.report(
        r,
        s.shiftId,
        design({ reportPath: s.brief.investigation!.reportPath, location: s.brief.investigation!.location }),
      );
      r.ended(s.shiftId, 'reported');
      await until(
        async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [s.shiftId, 'ended']))[0],
        3000,
      );
    }
    expect(seen.get(a.id)).toMatchObject({
      reportPath: `design/notes/${a.ref}-project-path.md`,
      location: 'repo',
    });
    expect(seen.get(b.id)).toMatchObject({ reportPath: 'docs/special/answer.md', location: 'repo' });
    expect(seen.get(c.id)).toMatchObject({
      reportPath: `research/${c.ref}-in-the-vault.md`,
      location: 'vault',
    });
  });

  it('an outcome into build refuses a card whose build fields are missing', async () => {
    await team();
    const card = await w.card({ title: 'thin', investigationOnly: true, fields: SHORT });
    expect((await patch(card.id, { investigationOnly: false })).status).toBe(200);
    const start = await next('Aria');
    await p.startShift(r, start);
    const res = await p.report(r, start.shiftId, design());
    expect(res.accepted).toBe(false);
    expect(res.error).toMatch(/required fields are missing.*acceptanceCriteria/);
  });
});

describe('investigation-only cards: record, then finalize', () => {
  async function investigated(location: 'repo' | 'vault' = 'repo') {
    await team();
    const card = await w.card({ title: 'Which queue?', investigationOnly: true, fields: SHORT });
    const start = await next('Aria');
    await p.startShift(r, start);
    const path = location === 'vault' ? `projects/toy/docs/investigations/${card.ref}.md` : REPORT;
    const res = await p.report(
      r,
      start.shiftId,
      design(
        { reportPath: path, location, ...(location === 'vault' ? { commit: undefined } : {}) },
        'report',
      ),
    );
    expect(res.error ?? '').toBe('');
    expect(res).toMatchObject({ accepted: true });
    r.ended(start.shiftId, 'reported');
    await until(async () => (await cardRow(card.id)).stage === 'finalize', 3000, 'card in finalize');
    return card;
  }

  it('the report goes to the BA at Finalize; finalizing is refused until the result is recorded', async () => {
    const card = await investigated();
    const fin = await next('Ben');
    expect(fin.brief.shift).toMatchObject({ stage: 'finalize' });
    expect(fin.brief.card.investigationOnly).toBe(true);
    expect(fin.brief.investigation!.report).toMatchObject({ reportPath: REPORT, location: 'repo' });
    await p.startShift(r, fin);
    const refused = await p.report(r, fin.shiftId, finalized());
    expect(refused.accepted).toBe(false);
    expect(refused.error).toMatch(/aom investigation record/);

    // recording writes a ledger entry (a feature entry by default) tagged with the card
    const rec = await rpc(fin.shiftId, 'investigation.record', {
      title: 'Queue choice',
      summary: 'Use the outbox.',
    });
    expect(rec.ok).toBe(true);
    const entry = (await q(`SELECT * FROM ledger_entries WHERE card_id=$1`, [card.id]))[0]!;
    expect(entry).toMatchObject({ scope: 'feature', title: 'Queue choice', project_id: w.projectId });
    expect(entry.tags).toEqual(expect.arrayContaining(['investigation', card.ref]));
    expect(entry.body).toContain('Use the outbox.');
    expect(entry.body).toContain(REPORT);
    // the second call replaces the first (one live entry per card), as a decision this time
    const again = await rpc(fin.shiftId, 'investigation.record', {
      title: 'Queue choice (final)',
      summary: 'Outbox it is.',
      decision: true,
    });
    expect(again.ok).toBe(true);
    const live = await q(
      `SELECT scope, title FROM ledger_entries WHERE card_id=$1 AND superseded_by IS NULL`,
      [card.id],
    );
    expect(live).toEqual([{ scope: 'decision', title: 'Queue choice (final)' }]);

    // now the BA may finalize with the card's completion action: the runner merges the report commit
    const from = r.received.length;
    const ok1 = await p.report(r, fin.shiftId, finalized());
    expect(ok1.accepted).toBe(true);
    r.ended(fin.shiftId, 'reported');
    const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 15_000, from);
    expect(cmd.payload).toMatchObject({ cardId: card.id, action: 'merge' });
  });

  it('`none` is refused for a report in the repository, and for a card that is not investigation-only', async () => {
    const card = await investigated('repo');
    const fin = await next('Ben');
    await p.startShift(r, fin);
    await rpc(fin.shiftId, 'investigation.record', { title: 't', summary: 's' });
    const refused = await p.report(r, fin.shiftId, finalized('none'));
    expect(refused.accepted).toBe(false);
    expect(refused.error).toMatch(/in the repository.*must be merged/);
    expect((await cardRow(card.id)).status).not.toBe('done');
  });

  it('a report in the vault is finalized without a git step (the server derives it): no git step, the card is done', async () => {
    const card = await investigated('vault');
    const fin = await next('Ben');
    await p.startShift(r, fin);
    await rpc(fin.shiftId, 'investigation.record', { title: 'Vault answer', summary: 'See the report.' });
    const from = r.received.length;
    const res = await p.report(r, fin.shiftId, finalized());
    expect(res.accepted).toBe(true);
    r.ended(fin.shiftId, 'reported');
    await until(async () => (await cardRow(card.id)).status === 'done', 3000, 'card done');
    const done = (await eventsOfType('CardFinalized')).filter((e) => e.cardId === card.id);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ action: 'none', toStage: 'done' });
    await r.barrier();
    expect(r.received.slice(from).some((f) => f.type === 'command' && f.command === 'finalize.execute')).toBe(
      false,
    );
    // the worktree is given back; nothing else is queued
    const cmd = await r.waitFor('command', (f) => f.command === 'worktree.remove', 15_000, from);
    expect(cmd.payload).toMatchObject({ deleteBranch: false });
    // the card page shows the card's own completion action, never `none` (it is no completion action), and still parses
    const dto = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: cookie() }));
    expect(dto.testing.finalize.action).not.toBe('none');
    expect(CardDetailResponseSchema.safeParse(dto).success).toBe(true);
    // and no full suite follows an investigation
    expect(
      await q(`SELECT 1 FROM cards WHERE parent_card_id=$1 AND origin='full_suite'`, [card.id]),
    ).toHaveLength(0);
  });

  it('`none` is refused on an ordinary card', async () => {
    await team();
    const card = await w.card({ title: 'ordinary' });
    await q(`UPDATE cards SET stage='finalize', status='queued' WHERE id=$1`, [card.id]);
    const fin = await next('Ben');
    await p.startShift(r, fin);
    const res = await p.report(r, fin.shiftId, finalized('none'));
    expect(res.accepted).toBe(false);
    expect(res.error).toMatch(/only an investigation-only card/);
  });

  it('recording is refused for a card that is not investigation-only', async () => {
    await team();
    const card = await w.card({ title: 'ordinary' });
    await q(`UPDATE cards SET stage='finalize', status='queued' WHERE id=$1`, [card.id]);
    const fin = await next('Ben');
    await p.startShift(r, fin);
    const rec = await rpc(fin.shiftId, 'investigation.record', { title: 't', summary: 's' });
    expect(rec.ok).toBe(false);
    expect(rec.error).toMatch(/not an investigation-only card/);
  });

  it('PROJECT.md gets the investigations section when the project has a vault', async () => {
    if ((await q(`SELECT 1 FROM vaults WHERE kind='org'`)).length === 0)
      await ok(
        w.t.req('POST', '/api/vaults', {
          cookie: cookie(),
          body: { kind: 'org', remoteUrl: 'git@example.test:srv/work.git' },
        }),
        201,
      );
    const card = await investigated('vault');
    const fin = await next('Ben');
    await p.startShift(r, fin);
    const from = r.received.length;
    const rec = await rpc(fin.shiftId, 'investigation.record', {
      title: 'Recorded',
      summary: 'Summary line.',
    });
    expect(rec.ok).toBe(true);
    const cmd = await r.waitFor(
      'command',
      (f) => f.command === 'vault.write' && (f.payload as any).section?.id === 'investigations',
      15_000,
      from,
    );
    const payload = cmd.payload as any;
    expect(payload).toMatchObject({ mode: 'section', section: { id: 'investigations' } });
    expect(payload.path).toMatch(/PROJECT\.md$/);
    expect(payload.content).toContain('## Investigations');
    expect(payload.content).toContain(card.ref);
    expect(payload.content).toContain('Recorded');
    expect(payload.content).toContain('Summary line.');
  });
});

describe('dependencies hold back the investigate stage', () => {
  it('a card with an open dependency is not investigated until the dependency is done', async () => {
    await team();
    await q('DELETE FROM agents WHERE name=$1', ['Bea']); // nobody builds the dependency
    const dep = await w.card({ title: 'dependency' });
    const card = await w.card({ title: 'waits', designNeeded: true, dependencies: [dep.id] });
    await r.barrier();
    const before = r.of('shift.start').length;
    await p.dispatcher().run();
    await r.barrier();
    expect(
      r
        .of('shift.start')
        .slice(before)
        .filter((s) => s.agent.name === 'Aria'),
    ).toHaveLength(0);
    // done (or cancelled) dependencies let it go
    await ok(
      w.t.req('POST', `/api/cards/${dep.id}/cancel`, { cookie: cookie(), body: { reason: 'not needed' } }),
    );
    const start = await next('Aria');
    expect(start.brief.card.id).toBe(card.id);
  });
});

describe('merge the latest main first: what the claim asks the runner for', () => {
  const setBranches = (main: string | null, working: string | null) =>
    q(`UPDATE project_repos SET main_branch=$2, working_branch=$3 WHERE id=$1`, [w.repoId, main, working]);

  it('syncMain is computed on the first worktree creation when main differs from the working branch', async () => {
    await team();
    await setBranches('main', 'work');
    const card = await w.card({ title: 'syncs', designNeeded: true });
    const start = await next('Aria');
    expect(start.prepare).toMatchObject({
      rebase: false,
      syncMain: { mainBranch: 'main', workingBranch: 'work' },
    });
    expect(start.worktree).toMatchObject({ mode: 'create', baseBranch: 'work', mainBranch: 'main' });
    expect(start.orgId).toBeDefined();
    await p.startShift(r, start);
    await p.report(r, start.shiftId, design());
    r.ended(start.shiftId, 'reported');
    await until(async () => (await cardRow(card.id)).stage === 'build', 3000);
    // later stages reuse the worktree: never again
    const build = await next('Bea');
    expect(build.worktree).toMatchObject({ mode: 'reuse' });
    expect(build.prepare.syncMain).toBeUndefined();
  });

  it('build asks for it when the design step is skipped (the build creates the worktree)', async () => {
    await team();
    await setBranches('main', 'work');
    await w.card({ title: 'no design' });
    const start = await next('Bea');
    expect(start.prepare.syncMain).toEqual({ mainBranch: 'main', workingBranch: 'work' });
  });

  it('is off when the project or the card says no, and when main is the working branch', async () => {
    await team();
    await setBranches('main', 'work');
    await q('UPDATE projects SET merge_main_first=false WHERE id=$1', [w.projectId]);
    await w.card({ title: 'project says no' });
    expect((await next('Bea')).prepare.syncMain).toBeUndefined();

    await team();
    await setBranches('main', 'work');
    await w.card({ title: 'card says no', mergeMainFirst: false });
    expect((await next('Bea')).prepare.syncMain).toBeUndefined();

    await team();
    await setBranches('main', 'work');
    await q('UPDATE projects SET merge_main_first=false WHERE id=$1', [w.projectId]);
    await w.card({ title: 'card says yes', mergeMainFirst: true });
    expect((await next('Bea')).prepare.syncMain).toBeDefined();

    await team();
    await setBranches('main', 'main');
    await w.card({ title: 'same branch' });
    expect((await next('Bea')).prepare.syncMain).toBeUndefined();
  });

  it('an unset main branch is sent without a name: the runner resolves origin/HEAD', async () => {
    await team();
    await setBranches(null, 'work');
    await w.card({ title: 'unknown main' });
    expect((await next('Bea')).prepare.syncMain).toEqual({ workingBranch: 'work' });
  });

  it('shift.started records what the runner did: a card note and event; a skipped conflict also reaches the desk', async () => {
    await team();
    await setBranches('main', 'work');
    const card = await w.card({ title: 'conflicts' });
    const start = await next('Bea');
    r.accepted(start.shiftId);
    r.send('shift.started', {
      shiftId: start.shiftId,
      worktree: {
        path: '/work/x',
        branchName: start.worktree?.branchName ?? 'x',
        baseBranch: 'work',
        created: true,
        headSha: 'abc123',
      },
      syncMain: { result: 'skipped_conflict', files: ['README.md'] },
    });
    await until(async () => (await eventsOfType('CardMainSynced')).length > 0, 3000, 'CardMainSynced');
    const ev = (await eventsOfType('CardMainSynced')).at(-1);
    expect(ev).toMatchObject({
      cardId: card.id,
      result: 'skipped_conflict',
      files: ['README.md'],
      mainBranch: 'main',
    });
    expect((await cardRow(card.id)).main_sync).toMatchObject({
      result: 'skipped_conflict',
      files: ['README.md'],
    });
    const notice = (await desk()).items.find((i: any) => i.subkind === 'main_merge_skipped');
    expect(notice).toMatchObject({ kind: 'alert', blocking: false });
    expect(notice.body).toContain('README.md');
    const dto = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: cookie() }));
    expect(dto.card.mainSync).toMatchObject({ result: 'skipped_conflict', files: ['README.md'] });
    // a merge into the working branch leaves a thread note only
    const msgs = await q(`SELECT body FROM thread_messages WHERE thread_id=$1`, [card.id]);
    expect(msgs.map((m) => m.body).join('\n')).toContain('not merged');
  });
});

describe('the architect reads the whole organization (read-only), others do not', () => {
  it('sends org repositories of active projects to the architect only, never its own repo or interest/archived/removed ones', async () => {
    await team();
    const mk = async (key: string, url: string) => {
      const proj = await ok<any>(
        w.t.req('POST', '/api/projects', { cookie: cookie(), body: { key, name: key } }),
        201,
      );
      const added = await ok<any>(
        w.t.req('POST', `/api/projects/${proj.project.id}/repos`, {
          cookie: cookie(),
          body: { name: key.toLowerCase(), remoteUrl: url },
        }),
        201,
      );
      return { id: proj.project.id as string, repoId: added.repos[0].id as string };
    };
    const api = await mk('API', 'https://github.com/acme/api.git');
    const web = await mk('WEB', 'https://github.com/acme/web.git');
    const old = await mk('OLD', 'https://github.com/acme/old.git');
    await ok(w.t.req('POST', `/api/projects/${old.id}/archive`, { cookie: cookie() }));
    // a second repository of API that is removed again
    const extra = await ok<any>(
      w.t.req('POST', `/api/projects/${api.id}/repos`, {
        cookie: cookie(),
        body: { name: 'gone', remoteUrl: 'https://github.com/acme/gone.git' },
      }),
      201,
    );
    const goneId = extra.repos.find((x: any) => x.name === 'gone').id;
    await ok(w.t.req('DELETE', `/api/projects/${api.id}/repos/${goneId}`, { cookie: cookie() }));
    await q(`UPDATE projects SET kind='interest' WHERE id=$1`, [web.id]);
    const live = await mk('LIVE', 'https://github.com/acme/live.git');

    await w.card({ title: 'reads', designNeeded: true });
    const arch = await next('Aria');
    const orgNames = arch.readRepos?.filter((x: any) => x.kind === 'org').map((x: any) => x.name) ?? [];
    expect(orgNames.sort()).toEqual(['api', 'live']);
    expect(arch.readRepos?.some((x: any) => x.repoId === w.repoId)).toBe(false); // its own repo is its worktree
    expect(arch.readRepos?.every((x: any) => x.kind === 'org' || x.kind === 'reference')).toBe(true);
    expect(live.repoId).toBeDefined();
    await p.startShift(r, arch);
    await p.report(r, arch.shiftId, design());
    r.ended(arch.shiftId, 'reported');
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [arch.shiftId, 'ended']))[0],
      3000,
    );

    const build = await next('Bea');
    expect(build.readRepos?.some((x: any) => x.kind === 'org') ?? false).toBe(false);
    expect(build.agent.permissions.readOrgRepos).toBe(false);
  });

  it('the architect role is senior only, reads the organization and writes only documentation', async () => {
    await team();
    const roles = await ok<any>(w.t.req('GET', '/api/roles', { cookie: cookie() }));
    const def = roles.roles.find((x: any) => x.definition.key === 'architect').definition;
    expect(def).toMatchObject({
      seniorityLevels: ['senior'],
      defaultModel: { model: 'opus', effort: 'high' },
      claimableStages: [
        { workflowKey: '*', stageId: 'investigate*' },
        { workflowKey: 'code-v6', stageId: 'planning' },
      ],
    });
    expect(def.permissions).toMatchObject({
      readOrgRepos: true,
      mayCommit: true,
      writableGlobs: ['docs/**', '**/*.md'],
    });
    expect(def.permissions.deniedShellPatterns).toEqual(
      expect.arrayContaining(['git push*', 'git fetch*', 'git pull*', 'git remote*', 'git rebase*']),
    );
    // a junior architect cannot be hired
    const res = await w.t.req('POST', '/api/agents', {
      cookie: cookie(),
      body: {
        name: 'Jun',
        roleKey: 'architect',
        seniority: 'junior',
        workstationId: w.workstationId,
        runtime: 'mock',
        model: 'mock',
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('a chat with the architect', () => {
  it('reads the organization (read-only) and carries the organization id; a builder chat does not', async () => {
    await team();
    const other = await ok<any>(
      w.t.req('POST', '/api/projects', { cookie: cookie(), body: { key: 'CHT', name: 'Chat other' } }),
      201,
    );
    await ok(
      w.t.req('POST', `/api/projects/${other.project.id}/repos`, {
        cookie: cookie(),
        body: { name: 'chatrepo', remoteUrl: 'https://github.com/acme/chatrepo.git' },
      }),
      201,
    );
    const agents = (await ok<any>(w.t.req('GET', '/api/agents', { cookie: cookie() }))).agents as any[];
    const ask = async (name: string) => {
      const agent = agents.find((x) => x.name === name);
      const chat = (
        await ok<any>(
          w.t.req('POST', '/api/chats', {
            cookie: cookie(),
            body: { agentId: agent.id, projectId: w.projectId },
          }),
          201,
        )
      ).chat;
      const from = r.received.length;
      const b = await Browser.open(w.baseUrl, cookie());
      await b.hello();
      b.send({ type: 'chat.send', threadId: chat.threadId, body: 'compare', clientMsgId: randomUUID() });
      const start = await r.waitFor('chat.start', (f) => f.threadId === chat.threadId, 15_000, from);
      b.close();
      return start;
    };
    const arch = await ask('Aria');
    const kinds = (arch.context.readRepos ?? []).map((x) => `${x.kind}:${x.name}`);
    expect(kinds).toContain('org:chatrepo');
    expect(kinds.some((k) => k.startsWith('project:'))).toBe(true);
    expect(arch.context.orgId).toBeDefined();
    const builder = await ask('Bea');
    expect((builder.context.readRepos ?? []).some((x) => x.kind === 'org')).toBe(false);
  });
});

describe('workflow v1 cards keep running', () => {
  it('a card on code v1 finishes on v1 (no investigate stage)', async () => {
    await team();
    const card = await w.card({ title: 'old card' });
    const v1 = await q(`SELECT id FROM workflow_versions WHERE org_id IS NULL AND key='code' AND version=1`);
    await q('UPDATE cards SET workflow_version_id=$2, stage=$3 WHERE id=$1', [card.id, v1[0]!.id, 'build']);
    const start = await next('Bea');
    expect(start.brief.shift.stage).toBe('build');
    await p.startShift(r, start);
    expect(
      await p.report(
        r,
        start.shiftId,
        { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} },
        DIFF_SMALL,
      ),
    ).toMatchObject({ accepted: true });
  });
});
