import { type Gate, GateSchema } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectGateFacts, evaluateEnvGate } from '../src/delivery/gate.ts';
import { releaseDecision, requestDeployRun } from '../src/delivery/runs.ts';
import { keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import {
  advance,
  type DeliveryWorld,
  deliveryWorld,
  healthyRun,
  mergeLanded,
  parseFixture,
  passedRegression,
  setWeekday,
} from './helpers/delivery.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { ok } from './helpers/world.ts';

/**
 * The delivery gate verifies the commit (pre-production review S1): an automated requester deploys only a commit the project
 * merged, a phase gate rests on the phase's real merge commit, a test run that names no commit vouches only for the latest
 * merge, `auto` never lets an untrusted CEO wake release production, and `ci` fails closed.
 */
const MERGED = 'abc1234def5678abc1234def5678abc1234def56';
const OLDER = '1111111def5678abc1234def5678abc1234def56';
const NEVER_MERGED = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
let d: DeliveryWorld;
let r: FakeRunner;

beforeAll(async () => {
  d = await deliveryWorld();
  r = await d.w.connectRunner({ capabilities: ['ceo:1', 'delivery:1'] });
  await keepOnline(d.w);
  await setWeekday(d);
  await mergeLanded(d, OLDER);
  await mergeLanded(d, MERGED);
  await advance(d, 5 * 60_000);
  const o = await d.observe(parseFixture(), { commit: '9999999aaaaaaa' });
  await ok(d.approve(o.hash));
  await ok(
    d.w.t.req('PUT', `/api/projects/${d.w.projectId}/delivery/mode`, {
      cookie: d.w.owner.cookie,
      body: { mode: 'recipe' },
    }),
  );
});
afterAll(async () => {
  r.close();
  await d.w.t.close();
  await closeAdminPool();
});

const ctx = () => d.w.t.app.ctx;
const ceo = { kind: 'ceo', id: 'ceo-1', name: 'Ada', provenance: 'order', untrusted: false } as const;
const ownerReq = () => ({ kind: 'owner', id: d.w.owner.id, name: 'Owner', provenance: 'session' }) as const;
const ask = (
  env: string,
  commit: string | undefined,
  requester: Parameters<typeof requestDeployRun>[1]['requester'],
) =>
  requestDeployRun(ctx(), {
    projectId: d.w.projectId,
    env,
    commit,
    trigger: 'request',
    requester,
  });

describe('an explicit commit from an automated requester', () => {
  it('is refused unless the project merged it', async () => {
    for (const requester of [ceo, { kind: 'devops', id: 'dv', name: 'DevOps' } as const]) {
      const res = await ask('local', NEVER_MERGED, requester);
      expect(res.runs[0]).toMatchObject({ status: 'refused', refusal: 'commit_not_allowed' });
    }
    const trig = await ask('local', NEVER_MERGED, {
      kind: 'trigger',
      id: null,
      name: 'x',
      provenance: 'trigger',
    });
    expect(trig.runs[0]).toMatchObject({ status: 'refused', refusal: 'commit_not_allowed' });
    expect(
      await q(`SELECT 1 FROM deploy_runs WHERE commit=$1 AND status NOT IN ('refused')`, [NEVER_MERGED]),
    ).toEqual([]);
  });

  it('is allowed for the latest merge and for an older CardFinalized merge; a human may choose any commit', async () => {
    expect((await ask('local', MERGED, ceo)).runs[0]!.status).toBe('queued');
    await q(`UPDATE deploy_runs SET status='cancelled' WHERE status IN ('queued','running')`);
    expect((await ask('local', OLDER.slice(0, 10), ceo)).runs[0]!.status).toBe('queued');
    await q(`UPDATE deploy_runs SET status='cancelled' WHERE status IN ('queued','running')`);
    expect((await ask('local', NEVER_MERGED, ownerReq())).runs[0]!.status).toBe('queued');
    await q(`UPDATE deploy_runs SET status='cancelled' WHERE status IN ('queued','running')`);
  });

  it('is allowed when it is the commit an envHealthy requirement points at', async () => {
    const promoted = 'cafebabecafebabecafebabecafebabecafebabe';
    await healthyRun(d, 'local', promoted, 45);
    const res = await ask('production', promoted, ceo);
    expect(res.runs[0]!.refusal).not.toBe('commit_not_allowed');
  });
});

describe('commit-less test runs and the gate', () => {
  it('a regression run that names no commit vouches only for the latest merge', async () => {
    await passedRegression(d, 1);
    const base = {
      orgId: d.orgId,
      projectId: d.w.projectId,
      env: parseFixture().environments[1]!,
      production: true,
    };
    const now = ctx().clock.now();
    await healthyRun(d, 'local', OLDER, 45);
    const old = await evaluateEnvGate(ctx().pool, { ...base, commit: OLDER, now });
    expect(old.missing.join(' ')).toContain('regression checks passed');
    await healthyRun(d, 'local', MERGED, 45);
    const latest = await evaluateEnvGate(ctx().pool, { ...base, commit: MERGED, now });
    expect(latest.satisfied).toBe(true);
  });

  it('ci with no CI facts fails closed', async () => {
    const gate = GateSchema.parse({ requires: [{ checksPassed: 'ci' }] }) as Gate;
    const v = await evaluateEnvGate(ctx().pool, {
      orgId: d.orgId,
      projectId: d.w.projectId,
      env: { gate },
      production: false,
      commit: MERGED,
      now: ctx().clock.now(),
    });
    expect(v.satisfied).toBe(false);
    expect(v.missing[0]).toContain('CI results are not collected');
  });
});

describe('phaseDone rests on the phase merge commit', () => {
  it('never on the requested commit', async () => {
    const phase = await ok<any>(
      d.w.t.req('POST', `/api/projects/${d.w.projectId}/phases`, {
        cookie: d.w.owner.cookie,
        body: { name: 'Phase one', followups: [] },
      }),
      201,
    );
    const phaseMerge = 'f00dfeedf00dfeedf00dfeedf00dfeedf00dfeed';
    const card = await d.w.card({ title: 'In the phase', specify: false });
    await ok(
      d.w.t.req('PUT', `/api/cards/${card.id}/phase`, {
        cookie: d.w.owner.cookie,
        body: { phaseId: phase.id },
      }),
    );
    await mergeLanded(d, phaseMerge, card.id);
    await q(`UPDATE phases SET completed_at=$2 WHERE id=$1`, [phase.id, ctx().clock.now()]);
    const facts = await collectGateFacts(ctx().pool, {
      orgId: d.orgId,
      projectId: d.w.projectId,
      commit: NEVER_MERGED,
      now: ctx().clock.now(),
    });
    expect(facts.phaseDoneCommits).toEqual([{ id: phase.id, commit: phaseMerge }]);
    const gate = { gate: { requires: [{ phaseDone: true }] } } as never;
    const run = (commit: string) =>
      evaluateEnvGate(ctx().pool, {
        orgId: d.orgId,
        projectId: d.w.projectId,
        env: gate,
        production: false,
        commit,
        now: ctx().clock.now(),
      });
    expect((await run(NEVER_MERGED)).satisfied).toBe(false);
    expect((await run(phaseMerge)).satisfied).toBe(true);
  });
});

describe('releasedBy auto', () => {
  it('does not release production for a CEO from an untrusted wake; it still does elsewhere', () => {
    const env = { releasedBy: 'auto' } as const;
    const wake = { ...ceo, provenance: 'wake', untrusted: true } as const;
    expect(releaseDecision(env, wake, true)).toEqual({ release: false, waitingFor: 'owner' });
    expect(releaseDecision(env, wake, false)).toMatchObject({ release: true });
    expect(releaseDecision(env, { ...wake, untrusted: false }, true)).toMatchObject({ release: true });
    expect(releaseDecision(env, { kind: 'trigger', id: null, provenance: 'trigger' }, true)).toMatchObject({
      release: true,
    });
  });
});
