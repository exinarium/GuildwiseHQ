import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const OPERATIONAL: Record<string, string[]> = {
  users: ['last_login_at'],
  workstations: ['connected', 'last_seen_at', 'runtimes', 'hostname', 'platform', 'runner_version'],
  cards: ['lease_expires_at'],
  shifts: ['progress_tail', 'accepted_at'],
  card_transitions: ['id'],
  card_activity: ['id'],
  test_runs: ['id'],
};
async function snapshot() {
  const out: Record<string, string[]> = {};
  for (const table of PROJECTION_TABLES) {
    const drop = (OPERATIONAL[table] ?? []).map((c) => ` - '${c}'`).join('');
    out[table] = (await q(`SELECT (to_jsonb(t)${drop})::text AS j FROM "${table}" t`))
      .map((x) => x.j as string)
      .sort();
  }
  return out;
}

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const scope = () => ({ orgId: w.owner.id, projectId: w.projectId, audience: 'project' as const });
const SYSTEM = { kind: 'system' as const, id: null };
const by = { kind: 'user' as const, userId: '' };

describe('phase projections', () => {
  it('a rebuild from events equals the live state for every phase table', async () => {
    by.userId = w.owner.id;
    const ba = await w.hire('Ben', 'ba', 'senior');
    const target = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/deploy-targets`, {
        name: 'local',
        kind: 'local_docker',
        appUrl: 'http://localhost:4601',
      }),
      201,
    );
    await ok(
      owner('POST', `/api/projects/${w.projectId}/deploy-targets`, { name: 'tmp', kind: 'local_docker' }),
      201,
    );
    const tmp = (await q(`SELECT id FROM deploy_targets WHERE name='tmp'`))[0]!.id;
    await ok(owner('PATCH', `/api/deploy-targets/${tmp}`, { notes: 'x' }));
    await owner('DELETE', `/api/deploy-targets/${tmp}`);
    await ok(
      owner('PUT', `/api/projects/${w.projectId}/followup-defaults`, {
        followups: [{ kind: 'regression' }],
      }),
    );

    // phase A: the whole life, driven with events the dispatcher and the BA would append
    const a = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/phases`, {
        name: 'Alpha',
        followups: [
          { kind: 'deploy', targetId: target.id },
          { kind: 'regression', mock: { test: ['ok'] } },
          { kind: 'custom', instruction: '[ba] write notes' },
        ],
      }),
      201,
    );
    const card = await w.card({ title: 'In Alpha', specify: false });
    await ok(owner('PUT', `/api/cards/${card.id}/phase`, { phaseId: a.id }));
    const other = await w.card({ title: 'Wanders', specify: false });
    await ok(owner('PUT', `/api/cards/${other.id}/phase`, { phaseId: a.id }));
    await ok(owner('PUT', `/api/cards/${other.id}/phase`, { phaseId: null }));
    await ok(
      owner('PATCH', `/api/phases/${a.id}`, { description: 'renamed later', workingBranch: 'release/1' }),
    );

    const t1 = randomUUID();
    const t2 = randomUUID();
    const t3 = randomUUID();
    const t4 = randomUUID();
    const item = randomUUID();
    const results = randomUUID();
    const [f1, f2, f3] = a.followupDetails.map((f: any) => f.id);
    const shiftId = randomUUID();
    const phaseEv = (type: string, payload: Record<string, unknown>) => ({
      streamId: streamId.phase(a.id),
      event: { type, payload: { phaseId: a.id, ...payload } },
      actor: SYSTEM,
      scope: scope(),
    });
    const task = (id: string, type: string, payload: Record<string, unknown>) => ({
      streamId: streamId.baTask(id),
      event: { type, payload: { taskId: id, ...payload } },
      actor: SYSTEM,
      scope: scope(),
    });
    await seed(w, [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardFinalized',
          payload: {
            cardId: card.id,
            action: 'merge',
            resultRef: { mergeCommit: 'abc123' },
            toStage: 'done',
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      phaseEv('PhaseCompleted', {
        baTaskId: t1,
        cardOutcomes: [
          { cardId: card.id, ref: card.ref, title: card.title, outcome: 'finalized', action: 'merge' },
        ],
      }),
      task(t1, 'BaTaskQueued', {
        projectId: w.projectId,
        phaseId: a.id,
        kind: 'phase_report',
        preferredAgentId: ba.id,
      }),
      task(t1, 'BaTaskDispatched', { shiftId, agentId: ba.id, workstationId: w.workstationId }),
      task(t1, 'BaTaskRequeued', { reason: 'no_report' }),
      task(t1, 'BaTaskCompleted', { status: 'fallback', note: 'template report' }),
      {
        streamId: streamId.desk(item),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId: item,
            kind: 'approval',
            subkind: 'phase_done',
            title: 'Alpha done',
            projectId: w.projectId,
            askedBy: SYSTEM,
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      phaseEv('PhaseReportPosted', {
        deskItemId: item,
        report: 'All good',
        outstanding: [{ kind: 'other', text: 'check docs' }],
        by: { kind: 'system' },
      }),
      phaseEv('PhaseFollowupsApproved', {
        by,
        deskItemId: item,
        baTaskId: t2,
        followups: a.followupDetails.map((f: any) =>
          f.kind === 'deploy'
            ? { id: f.id, kind: 'deploy', targetId: target.id }
            : f.kind === 'regression'
              ? { id: f.id, kind: 'regression', platform: 'web', mock: { test: ['ok'] } }
              : { id: f.id, kind: 'custom', instruction: '[ba] write notes' },
        ),
      }),
      task(t2, 'BaTaskQueued', { projectId: w.projectId, phaseId: a.id, kind: 'followups_brief' }),
      phaseEv('PhaseFollowupBriefed', {
        followupId: f1,
        delegate: 'devops',
        brief: 'deploy it',
        by: { kind: 'system' },
      }),
      phaseEv('PhaseFollowupBriefed', {
        followupId: f2,
        delegate: 'tester',
        brief: 'run it',
        by: { kind: 'system' },
      }),
      phaseEv('PhaseFollowupBriefed', {
        followupId: f3,
        delegate: 'ba',
        brief: 'write',
        by: { kind: 'system' },
      }),
      task(t2, 'BaTaskCompleted', { status: 'done' }),
      phaseEv('PhaseFollowupStarted', { followupId: f1, delegate: 'devops', devopsRequestIds: [] }),
      phaseEv('PhaseFollowupFinished', {
        followupId: f1,
        status: 'succeeded',
        summary: 'deployed',
        evidence: { workstations: [] },
      }),
      phaseEv('PhaseFollowupStarted', { followupId: f2, delegate: 'tester', regressionCardIds: [other.id] }),
      phaseEv('PhaseFollowupFinished', { followupId: f2, status: 'failed', summary: 'suite failed' }),
      phaseEv('PhaseFollowupFinished', { followupId: f3, status: 'skipped', summary: 'skipped: 2 failed' }),
      phaseEv('PhaseFollowupsFinished', { status: 'done_with_failures', baTaskId: t3 }),
      task(t3, 'BaTaskQueued', { projectId: w.projectId, phaseId: a.id, kind: 'followups_report' }),
      {
        streamId: streamId.desk(results),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId: results,
            kind: 'alert',
            subkind: 'phase_results',
            title: 'Alpha results',
            projectId: w.projectId,
            askedBy: SYSTEM,
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      phaseEv('PhaseResultsReported', {
        deskItemId: results,
        report: 'one failure',
        finalStatus: 'done_with_failures',
        by: { kind: 'system' },
      }),
      task(t3, 'BaTaskCompleted', { status: 'done' }),
      task(t4, 'BaTaskQueued', {
        projectId: w.projectId,
        kind: 'followup_custom',
        followupId: f3,
        phaseId: a.id,
      }),
      task(t4, 'BaTaskCompleted', { status: 'cancelled' }),
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardMergeVerified',
          payload: { cardId: card.id, workingBranch: 'main', branchName: 'aom/x', branchDeleted: true },
        },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);

    // phase B: reopened; phase C: a proposal that is discarded; phase D: cancelled with the archive
    const b = await ok<any>(owner('POST', `/api/projects/${w.projectId}/phases`, { name: 'Beta' }), 201);
    await seed(w, [
      {
        streamId: streamId.phase(b.id),
        event: {
          type: 'PhaseCompleted',
          payload: { phaseId: b.id, baTaskId: randomUUID(), cardOutcomes: [] },
        },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    await ok(owner('POST', `/api/phases/${b.id}/reopen`, { reason: 'one more' }));
    await ok(
      owner('PUT', `/api/phases/${b.id}/followups`, { followups: [{ kind: 'custom', instruction: 'x' }] }),
    );

    const live = await snapshot();
    expect(live.phases?.length).toBe(2);
    expect(live.phase_followups?.length).toBeGreaterThanOrEqual(4);
    expect(live.ba_tasks?.length).toBe(4);
    expect(live.deploy_targets?.length).toBe(2);
    expect((await q(`SELECT status FROM phases WHERE id=$1`, [a.id]))[0]?.status).toBe('done_with_failures');
    expect(
      (
        await q('SELECT status FROM phase_followups WHERE id = ANY($1::uuid[]) ORDER BY position', [
          [f1, f2, f3],
        ])
      ).map((r) => r.status),
    ).toEqual(['succeeded', 'failed', 'skipped']);
    expect(
      (await q('SELECT merged_into_working_at FROM cards WHERE id=$1', [card.id]))[0]?.merged_into_working_at,
    ).not.toBeNull();

    await w.t.app.ctx.notifier.flush();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const after = await snapshot();
    for (const t of PROJECTION_TABLES) expect(after[t], t).toEqual(live[t]);
    expect(
      (await q('SELECT default_followups, next_phase_number FROM projects WHERE id=$1', [w.projectId]))[0],
    ).toMatchObject({
      next_phase_number: 3,
    });
  });
});
