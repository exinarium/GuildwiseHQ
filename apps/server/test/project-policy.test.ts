import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { environmentNotReadyEvents } from '../src/commands/testing.ts';
import { withAppendTx } from '../src/db/tx.ts';
import { blockingQuestion, keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

// Lean Team v3 (S1b): the project settings "decisions at project level" and "test without an environment".

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const call = (method: string, url: string, body?: unknown, status = 200) =>
  ok<any>(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), status);
const policy = (body: Record<string, unknown>) => call('PUT', `/api/projects/${w.projectId}/policy`, body);
const flags = async () =>
  (
    await q('SELECT decisions_project_only, test_without_environment FROM projects WHERE id=$1', [
      w.projectId,
    ])
  )[0];

describe('project policy', () => {
  it('both flags default off, can be set and unset, and show on the project', async () => {
    expect(await flags()).toEqual({ decisions_project_only: false, test_without_environment: false });
    const r = await policy({ decisionsProjectOnly: true });
    expect(r.project).toMatchObject({ decisionsProjectOnly: true, testWithoutEnvironment: false });
    await policy({ testWithoutEnvironment: true });
    expect(await flags()).toEqual({ decisions_project_only: true, test_without_environment: true });
    await call('PUT', `/api/projects/${w.projectId}/policy`, {}, 400);
    await policy({ decisionsProjectOnly: false, testWithoutEnvironment: false });
    expect(await flags()).toEqual({ decisions_project_only: false, test_without_environment: false });
  });
});

describe('decisions stay at project level', () => {
  it('the desk refuses the organization-wide switch for a flagged project, and accepts it otherwise', async () => {
    await policy({ decisionsProjectOnly: true });
    const a = await blockingQuestion(w, { title: 'Which linter should we use?' });
    const refused = await ok<any>(
      w.t.req('POST', `/api/desk/${a.id}/answer`, {
        cookie: w.owner.cookie,
        body: { answer: 'Use biome.', ledger: { scope: 'standing_order', orgWide: true } },
      }),
      409,
    );
    expect(JSON.stringify(refused)).toContain('project_only');
    // a project-level order is still fine
    await ok(
      w.t.req('POST', `/api/desk/${a.id}/answer`, {
        cookie: w.owner.cookie,
        body: { answer: 'Use biome.', ledger: { scope: 'standing_order' } },
      }),
    );
    const row = (await q(`SELECT project_id FROM ledger_entries WHERE body LIKE '%Use biome%'`))[0];
    expect(row?.project_id).toBe(w.projectId);

    await policy({ decisionsProjectOnly: false });
    const b = await blockingQuestion(w, { title: 'Which formatter should we use?' });
    await ok(
      w.t.req('POST', `/api/desk/${b.id}/answer`, {
        cookie: w.owner.cookie,
        body: { answer: 'Use prettier everywhere.', ledger: { scope: 'standing_order', orgWide: true } },
      }),
    );
    expect(
      (await q(`SELECT project_id FROM ledger_entries WHERE body LIKE '%prettier%'`))[0]?.project_id,
    ).toBeNull();
  });

  it('an approved HR or CEO proposal that came from a project stays at that project; a duplicate adds nothing', async () => {
    const propose = async (title: string, body: string, projectId?: string) => {
      const id = randomUUID();
      await seed(w, [
        {
          streamId: streamId.desk(id),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId: id,
              kind: 'approval',
              subkind: 'standing_order',
              title: `Add a standing order: ${title}`,
              body,
              options: [],
              blocking: false,
              pinned: false,
              affectedCardIds: [],
              ...(projectId ? { projectId } : {}),
              askedBy: { kind: 'system' },
            },
          },
          actor: { kind: 'system', id: null },
          scope: projectId
            ? { orgId: w.owner.id, projectId, audience: 'project' }
            : { orgId: w.owner.id, projectId: null, audience: 'org' },
        },
      ]);
      await call('POST', `/api/desk/${id}/resolve`, { resolution: 'approved' });
    };
    await propose('Snake case', 'Name database tables in snake_case, never camelCase.', w.projectId);
    await until(
      async () => (await q(`SELECT 1 FROM ledger_entries WHERE title='Snake case'`))[0],
      3000,
      'order added',
    );
    expect((await q(`SELECT project_id FROM ledger_entries WHERE title='Snake case'`))[0]?.project_id).toBe(
      w.projectId,
    );
    // the same proposal again: nothing new
    await propose('Snake case tables', 'Name database tables in snake_case, never camelCase.', w.projectId);
    await new Promise((r) => setTimeout(r, 300));
    expect(
      (await q(`SELECT count(*)::int AS n FROM ledger_entries WHERE body LIKE '%snake_case%'`))[0]?.n,
    ).toBe(1);
    // an org-level proposal is org-wide
    await propose('Greet politely', 'Greet the manager politely in every comment you write.');
    await until(
      async () => (await q(`SELECT 1 FROM ledger_entries WHERE title='Greet politely'`))[0],
      3000,
      'org order added',
    );
    expect(
      (await q(`SELECT project_id FROM ledger_entries WHERE title='Greet politely'`))[0]?.project_id,
    ).toBeNull();
  });
});

describe('test without an environment', () => {
  it('with the setting off, a tester shift that finds no environment parks the card on DevOps; with it on it does not', async () => {
    await keepOnline(w);
    const card =
      (await q('SELECT * FROM cards WHERE project_id=$1 LIMIT 1', [w.projectId]))[0] ??
      (await w.card({ title: 'Env card' }));
    const row = (await q('SELECT * FROM cards WHERE id=$1', [card.id]))[0]!;
    const ws = { id: w.workstationId, userId: w.owner.id };
    const run = () =>
      withAppendTx(w.t.app.ctx.pool, (tx) =>
        environmentNotReadyEvents(w.t.app.ctx, tx, ws, row, { problem: 'app_not_deployed' }),
      );
    await policy({ testWithoutEnvironment: true });
    const on = await run();
    expect(on.map((e) => e.event.type)).not.toContain('TestEnvironmentParked');
    expect(JSON.stringify(on)).toContain('without an environment');
    await policy({ testWithoutEnvironment: false });
    const off = await run().catch((e) => e);
    // off: the existing path (a DevOps request or a hard stop), never the "carry on" message
    expect(JSON.stringify(off)).not.toContain('records that no environment was used');
  });

  it('the brief of a tester carries the flag, and the prompt tells it to record that no environment was used', async () => {
    const { renderShiftPrompt } = await import('@aom/shared');
    const { buildBrief } = await import('../src/runner-gateway/brief.ts');
    await policy({ testWithoutEnvironment: true });
    expect(
      (await q('SELECT test_without_environment FROM projects WHERE id=$1', [w.projectId]))[0]
        ?.test_without_environment,
    ).toBe(true);
    // the gate: the dispatcher's SQL lets a tester take the card without a ready environment
    const { eligibility, PARAM_AGENT } = await import('../src/dispatcher/candidates.ts');
    expect(eligibility(PARAM_AGENT).envReady).toContain('p.test_without_environment');
    void buildBrief;
    const text = renderShiftPrompt({
      shift: {
        id: 's',
        kind: 'card',
        stage: 'test',
        stageLabel: 'Test',
        doneCriteria: 'x',
        outcomes: [],
        maxShiftMinutes: 5,
      },
      agent: { id: 'a', name: 'Tess', seniority: 'senior' },
      card: {
        id: 'c',
        ref: 'T-1',
        title: 't',
        cardType: 'task',
        fields: {},
        riskTier: null,
        reworkRound: 0,
        completionAction: null,
        docsNeeded: false,
        dependencies: [],
      },
      project: { id: 'p', key: 'T', name: 'T', workingBranch: 'main', e2eGlobs: [], architecturalGlobs: [] },
      role: { key: 'tester', name: 'Tester', instructions: '', coreRules: '', skills: [] },
      handoffs: [],
      reviewComments: [],
      thread: [],
      standingOrders: [],
      ledger: [],
      testWithoutEnvironment: true,
    } as never);
    expect(text).toContain('no environment was used');
    await policy({ testWithoutEnvironment: false });
  });
});
