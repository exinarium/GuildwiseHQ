import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepSubworkflows } from '../src/commands/subworkflows.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import {
  designed,
  handoffEv,
  hireLeanTeam,
  leanAttach,
  leanPipeline,
  planned,
  resetLean,
  SHA1,
  SHA2,
  verdict,
} from './helpers/lean.ts';
import { cardRow } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, fullFields, ok, type World } from './helpers/world.ts';

// Regression: the owner approval after the review (large or high-risk cards / every card) keeps working on code v7,
// with the design gate on and off.

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof leanPipeline>;
beforeAll(async () => {
  w = await createWorld({
    env: { AOM_FIRST_RUN_HIRE_CAP: 'false' },
    project: { workflowKey: 'code' },
    lean: true,
    designGate: true,
    integrationTests: 'off',
  });
  r = await w.connectRunner();
  p = leanPipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const call = (method: string, url: string, body?: unknown, status = 200, cookie = w.owner.cookie) =>
  ok<any>(w.t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) }), status);

async function team(gate: boolean) {
  await freshState();
  await resetLean();
  w.t.app.ctx.services.dispatcher.cooldown.clear();
  await q(`UPDATE projects SET design_gate=$2, owner_approval_policy='large_or_high_risk' WHERE id=$1`, [
    w.projectId,
    gate,
  ]);
  await hireLeanTeam(w);
}

/** A v7 card through Planning, design (and the gate when it is on), waiting in Build. */
async function cardInBuild(title: string) {
  const card = await w.card({ title, fields: fullFields({ affectedAreas: 'apps/web/src/components/' }) });
  expect(card.workflowVersion).toBe(7);
  await p.run('Pia', planned());
  await p.run('Arc', designed(card.ref));
  const row = await cardRow(card.id);
  if (row.stage === 'design_gate') {
    await sweepSubworkflows(w.t.app.ctx);
    await call('POST', `/api/cards/${card.id}/approval/approve`, {});
  }
  expect((await cardRow(card.id)).stage).toBe('build');
  return card;
}

async function reviewed(title: string, sha: string, paths?: string[]) {
  const card = await cardInBuild(title);
  await p.runAt('Bea', handoffEv(), leanAttach(sha, paths), sha);
  await p.runAt('Pre', verdict('approve'), {}, sha);
  await p.runAt('Rex', verdict('approve'), {}, sha);
  return card;
}

describe.each([false, true])('owner approval on code v7 (design gate %s)', (gate) => {
  it('large_or_high_risk approves a small low-risk card automatically', async () => {
    await team(gate);
    const card = await reviewed('auto', SHA1);
    expect(await cardRow(card.id)).toMatchObject({
      stage: 'test_deploy',
      owner_approval_required: false,
      owner_approval_reason: 'auto_small',
    });
  });

  it('always asks the owner for every card', async () => {
    await team(gate);
    await call('PUT', `/api/projects/${w.projectId}/owner-approval`, { policy: 'always' });
    const card = await reviewed('always', SHA2);
    expect(await cardRow(card.id)).toMatchObject({
      stage: 'owner_approval',
      owner_approval_required: true,
      owner_approval_reason: 'policy_always',
    });
  });

  it('a high-risk diff asks the owner after its second review approval', async () => {
    await team(gate);
    const card = await reviewed('risky', SHA1, ['apps/server/src/billing/plan.ts']);
    await p.runAt('Rex', verdict('approve'), {}, SHA1);
    expect(await cardRow(card.id)).toMatchObject({
      stage: 'owner_approval',
      owner_approval_required: true,
      high_risk: true,
    });
  });
});
