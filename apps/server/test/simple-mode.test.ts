import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, DIFF_SMALL, hireTeam, pipeline, testPass } from './helpers/pipeline.ts';
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

const me = (cookie: string) => ok<any>(w.t.req('GET', '/api/auth/me', { cookie })).then((x) => x.user);

describe('expert mode for version control (per user, off by default)', () => {
  it('is off for everyone, including existing users, and each user turns it on for themselves only', async () => {
    const a = await w.t.userSession('expert-a@example.test');
    const b = await w.t.userSession('expert-b@example.test');
    expect((await me(a.cookie)).gitExpert).toBe(false);
    expect((await me(w.owner.cookie)).gitExpert).toBe(false);

    const on = await ok<any>(
      w.t.req('PUT', '/api/auth/git-expert', { cookie: a.cookie, body: { enabled: true } }),
    );
    expect(on.user.gitExpert).toBe(true);
    expect((await me(a.cookie)).gitExpert).toBe(true);
    expect((await me(b.cookie)).gitExpert).toBe(false);

    await ok(w.t.req('PUT', '/api/auth/git-expert', { cookie: a.cookie, body: { enabled: false } }));
    expect((await me(a.cookie)).gitExpert).toBe(false);
  });

  it('refuses bad input and anonymous callers, and survives a rebuild of the projections', async () => {
    const u = await w.t.userSession('expert-rebuild@example.test');
    expect(
      (await w.t.req('PUT', '/api/auth/git-expert', { cookie: u.cookie, body: { enabled: 'yes' } })).status,
    ).toBe(400);
    expect((await w.t.req('PUT', '/api/auth/git-expert', { body: { enabled: true } })).status).toBe(401);
    await ok(w.t.req('PUT', '/api/auth/git-expert', { cookie: u.cookie, body: { enabled: true } }));
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await me(u.cookie)).gitExpert).toBe(true);
  });
});

describe('how finished work lands (project default)', () => {
  const project = () => ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: w.owner.cookie }));
  const create = (body: Record<string, unknown>) =>
    ok<any>(
      w.t.req('POST', '/api/cards', {
        cookie: w.owner.cookie,
        body: {
          projectId: w.projectId,
          title: 'Landing',
          cardType: 'feature',
          fields: fullFields(),
          ...body,
        },
      }),
      201,
    );

  it('defaults to merge; a card without a completion action follows the project default, an explicit one wins', async () => {
    expect((await project()).project.defaultCompletion).toBe('merge');
    // Nothing is copied onto the card: it follows the project, whatever the project says later.
    const inheriting = (await create({})).card;
    expect(inheriting).toMatchObject({
      completionAction: null,
      effectiveCompletionAction: 'merge',
      completionActionSource: 'project',
    });

    await ok(
      w.t.req('PATCH', `/api/projects/${w.projectId}`, {
        cookie: w.owner.cookie,
        body: { defaultCompletion: 'pr' },
      }),
    );
    expect((await project()).project.defaultCompletion).toBe('pr');
    expect((await create({})).card).toMatchObject({
      completionAction: null,
      effectiveCompletionAction: 'pr',
    });
    const shown = await ok<any>(w.t.req('GET', `/api/cards/${inheriting.id}`, { cookie: w.owner.cookie }));
    expect(shown.card).toMatchObject({ completionAction: null, effectiveCompletionAction: 'pr' });
    expect((await create({ completionAction: 'merge' })).card).toMatchObject({
      completionAction: 'merge',
      effectiveCompletionAction: 'merge',
      completionActionSource: 'card',
    });
    // push_branch was retired (backlog #61): creating a card with it is refused
    const retired = await w.t.req('POST', '/api/cards', {
      cookie: w.owner.cookie,
      body: {
        projectId: w.projectId,
        title: 'Retired',
        cardType: 'feature',
        completionAction: 'push_branch',
      },
    });
    expect(retired.status).toBe(400);

    await ok(
      w.t.req('PATCH', `/api/projects/${w.projectId}`, {
        cookie: w.owner.cookie,
        body: { defaultCompletion: 'merge' },
      }),
    );
  });

  it('refuses a value that is not merge or pr', async () => {
    const res = await w.t.req('PATCH', `/api/projects/${w.projectId}`, {
      cookie: w.owner.cookie,
      body: { defaultCompletion: 'push_branch' },
    });
    expect(res.status).toBe(400);
  });

  it('a protected working branch turns the merge into a pull request and switches the project to pull requests', async () => {
    await freshState();
    await hireTeam(w, { reviewers: ['Rex', 'Ria'] });
    const card = await w.card();
    await p.run('Bea', { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} }, DIFF_SMALL);
    await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
    await p.run('Tess', testPass());
    const from = r.received.length;
    await ok(w.t.req('POST', `/api/cards/${card.id}/finalize`, { cookie: w.owner.cookie, body: {} }));
    const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 5000, from);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: {
        ok: true,
        action: 'pr',
        protectedBranch: true,
        pushedBranch: 'aom/x',
        prUrl: 'https://example.test/pr/9',
      },
    });
    await until(async () => (await cardRow(card.id)).status === 'done', 3000, 'card finalized');
    const done = await q('SELECT finalize_result FROM cards WHERE id=$1', [card.id]);
    expect(done[0]?.finalize_result).toMatchObject({ prUrl: 'https://example.test/pr/9' });
    const fin = await q(`SELECT payload FROM events WHERE type='CardFinalized' AND payload->>'cardId'=$1`, [
      card.id,
    ]);
    expect(fin[0]?.payload).toMatchObject({ action: 'pr' });
    expect((await project()).project.defaultCompletion).toBe('pr');
    const msgs = await q(`SELECT body FROM thread_messages WHERE body ILIKE '%is protected%'`);
    expect(msgs.length).toBeGreaterThan(0);
  });
});
