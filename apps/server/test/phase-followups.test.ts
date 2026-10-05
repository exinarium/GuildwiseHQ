import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { phasePass } from '../src/dispatcher/phases.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, type Member } from './helpers/members.ts';
import { pipeline, testFail } from './helpers/pipeline.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let member: Member;
let local: any;
let remote: any;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner();
  member = await addMember(w, 'mgr');
  local = await ok<any>(
    owner('POST', `/api/projects/${w.projectId}/deploy-targets`, {
      name: 'local',
      kind: 'local_docker',
      appUrl: 'http://localhost:4601',
      notes: 'docker compose up -d',
    }),
    201,
  );
  remote = await ok<any>(
    owner('POST', `/api/projects/${w.projectId}/deploy-targets`, {
      name: 'staging',
      kind: 'remote_ssh',
      workstationId: member.workstationId,
      host: 'stg.example',
      appUrl: 'https://stg.example',
    }),
    201,
  );
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

function owner(method: string, url: string, body?: unknown) {
  return w.t.req(method, url, { cookie: w.owner.cookie, body });
}
const scope = () => ({ orgId: w.owner.id, projectId: w.projectId, audience: 'project' as const });
const SYSTEM = { kind: 'system' as const, id: null };
const dispatcher = () => w.t.app.ctx.services.dispatcher;
const phaseRow = async (id: string) => (await q('SELECT * FROM phases WHERE id=$1', [id]))[0]!;
const followups = async (id: string) =>
  q('SELECT * FROM phase_followups WHERE phase_id=$1 ORDER BY position', [id]);

/** A completed phase (one merged card) with a template report waiting for the manager's approval (no BA hired). */
async function awaitingApproval(name: string, list: unknown[]) {
  const phase = await ok<any>(
    owner('POST', `/api/projects/${w.projectId}/phases`, { name, followups: list }),
    201,
  );
  const card = await w.card({ title: `${name} card`, specify: false });
  await ok(owner('PUT', `/api/cards/${card.id}/phase`, { phaseId: phase.id }));
  await seed(w, [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'CardFinalized',
        payload: {
          cardId: card.id,
          action: 'merge',
          resultRef: { mergeCommit: 'abc1234567' },
          toStage: 'done',
        },
      },
      actor: SYSTEM,
      scope: scope(),
    },
  ]);
  await dispatcher().runPass(); // completion, then the fallback report
  const row = await phaseRow(phase.id);
  expect(row.status).toBe('awaiting_approval');
  return { phase, card, itemId: row.report_desk_item_id as string };
}
const approve = (itemId: string) =>
  ok(owner('POST', `/api/desk/${itemId}/resolve`, { resolution: 'approved' }));
const completeRequest = (id: string, status: 'done' | 'failed', summary: string) =>
  seed(w, [
    {
      streamId: streamId.thread(id),
      event: { type: 'DevOpsRequestCompleted', payload: { requestId: id, status, summary } },
      actor: SYSTEM,
      scope: { orgId: w.owner.id, projectId: null, audience: 'org' as const },
    },
  ]);
const requestsOf = async (followupId: string) =>
  q(
    `SELECT r.* FROM devops_requests r JOIN phase_followups f ON r.id = ANY(f.devops_request_ids) WHERE f.id=$1 ORDER BY r.created_at`,
    [followupId],
  );

describe('nothing runs before the manager approves', () => {
  it('rejecting the follow-ups cancels them and asks DevOps for nothing', async () => {
    const { phase, itemId } = await awaitingApproval('Rejected', [
      { kind: 'deploy', targetId: local.id },
      { kind: 'regression' },
    ]);
    await dispatcher().runPass();
    const asked = () =>
      q('SELECT count(*)::int AS n FROM devops_requests WHERE requested_by_name LIKE $1', [
        `Phase ${phase.ref} %`,
      ]);
    expect((await asked())[0]?.n).toBe(0);
    expect((await followups(phase.id)).map((f) => f.status)).toEqual(['pending', 'pending']);
    await ok(owner('POST', `/api/desk/${itemId}/resolve`, { resolution: 'rejected', note: 'not now' }));
    await dispatcher().runPass();
    expect((await phaseRow(phase.id)).status).toBe('followups_rejected');
    expect((await followups(phase.id)).map((f) => f.status)).toEqual(['cancelled', 'cancelled']);
    expect((await asked())[0]?.n).toBe(0);
    expect(
      (
        await q(
          "SELECT count(*)::int AS n FROM ba_tasks WHERE phase_id=$1 AND kind IN ('followups_brief','followups_report')",
          [phase.id],
        )
      )[0]?.n,
    ).toBe(0);
  });

  it('the approval snapshots the list the manager saw, including edits made while deciding', async () => {
    const { phase, itemId } = await awaitingApproval('Edited while deciding', [{ kind: 'regression' }]);
    await ok(
      owner('PUT', `/api/phases/${phase.id}/followups`, {
        followups: [{ kind: 'regression' }, { kind: 'custom', instruction: 'Tell the team' }],
      }),
    );
    // the open item is still the same approval (the list stayed non-empty)
    expect((await phaseRow(phase.id)).report_desk_item_id).toBe(itemId);
    await approve(itemId);
    const approved = (
      await q(`SELECT payload FROM events WHERE type='PhaseFollowupsApproved' AND payload->>'phaseId'=$1`, [
        phase.id,
      ])
    )[0]!;
    expect(approved.payload.followups.map((f: any) => f.kind)).toEqual(['regression', 'custom']);
    const frozen = await owner('PUT', `/api/phases/${phase.id}/followups`, { followups: [] });
    expect(frozen.body.error.code).toBe('followups_frozen');
    // keep this phase from running into the later tests of the file
    await q(`UPDATE phases SET status='cancelled' WHERE id=$1`, [phase.id]);
  });

  it('removing the last follow-up while the item is open turns it into an acknowledge notice (and back)', async () => {
    const { phase, itemId } = await awaitingApproval('Shape change', [{ kind: 'regression' }]);
    await ok(owner('PUT', `/api/phases/${phase.id}/followups`, { followups: [] }));
    const row = await phaseRow(phase.id);
    expect(row.report_desk_item_id).not.toBe(itemId);
    expect((await q('SELECT status FROM desk_items WHERE id=$1', [itemId]))[0]?.status).toBe('dismissed');
    expect((await q('SELECT kind FROM desk_items WHERE id=$1', [row.report_desk_item_id]))[0]?.kind).toBe(
      'alert',
    );
    expect(row.status).toBe('awaiting_approval');
    await ok(owner('PUT', `/api/phases/${phase.id}/followups`, { followups: [{ kind: 'regression' }] }));
    const again = await phaseRow(phase.id);
    expect((await q('SELECT kind FROM desk_items WHERE id=$1', [again.report_desk_item_id]))[0]?.kind).toBe(
      'approval',
    );
  });
});

describe('running the follow-ups in order (no BA: template briefs)', () => {
  it('deploy to the local stack fans out to every member workstation, then the regression is pinned and a custom item goes to DevOps', async () => {
    await w.hire('Tess', 'tester', 'junior');
    const { phase, card, itemId } = await awaitingApproval('Happy path', [
      { kind: 'deploy', targetId: local.id, note: 'careful with the db' },
      { kind: 'regression', targetId: local.id },
      { kind: 'custom', instruction: 'Post the release notes' },
    ]);
    await approve(itemId);
    expect((await phaseRow(phase.id)).status).toBe('running_followups');
    expect((await followups(phase.id)).map((f) => f.status)).toEqual(['queued', 'queued', 'queued']);
    await dispatcher().runPass(); // the briefing task finds no BA: template briefs
    const briefed = await followups(phase.id);
    expect(briefed.map((f) => [f.status, f.delegate])).toEqual([
      ['briefed', 'devops'],
      ['briefed', 'tester'],
      ['briefed', 'devops'],
    ]);
    expect(briefed[0]?.brief).toContain('local Docker stack');
    expect(briefed[0]?.brief).toContain('http://localhost:4601');
    expect(briefed[0]?.brief).toContain('docker compose up -d');
    expect(briefed[0]?.brief).toContain('careful with the db');
    expect(briefed[0]?.brief).toContain(card.title);
    expect(briefed[0]?.brief).toContain('aom devops-done');

    // follow-up 1 started on the next pass: one DevOps request per workstation of every member
    await phasePass(w.t.app.ctx);
    const f1 = (await followups(phase.id))[0]!;
    expect(f1.status).toBe('running');
    const reqs = await requestsOf(f1.id);
    expect(reqs).toHaveLength(2);
    expect(new Set(reqs.map((x) => x.workstation_id))).toEqual(
      new Set([w.workstationId, member.workstationId]),
    );
    expect(reqs[0]?.summary).toContain('local Docker stack');
    expect(reqs.map((x) => x.summary).join('\n')).toContain('mgr-box');
    expect(reqs.every((x) => x.card_id === null && x.requested_by_kind === 'system')).toBe(true);
    // the second follow-up waits while the first runs
    await phasePass(w.t.app.ctx);
    expect((await followups(phase.id))[1]?.status).toBe('briefed');

    // one workstation done: still running; both done: succeeded
    await completeRequest(reqs[0]?.id, 'done', 'deployed abc1234 on A');
    await phasePass(w.t.app.ctx);
    expect((await followups(phase.id))[0]?.status).toBe('running');
    await completeRequest(reqs[1]?.id, 'done', 'deployed abc1234 on B');
    await phasePass(w.t.app.ctx); // result of 1, start of 2 in the next pass
    const done1 = (await followups(phase.id))[0]!;
    expect(done1.status).toBe('succeeded');
    expect(done1.result_summary).toContain('deployed abc1234 on A');
    expect(done1.evidence.deployedWorkstationIds).toHaveLength(2);
    await phasePass(w.t.app.ctx);

    // follow-up 2: regression cards pinned to a workstation with a tester, against the deployed URL
    const f2 = (await followups(phase.id))[1]!;
    expect(f2.status).toBe('running');
    const cards = await q('SELECT * FROM cards WHERE id = ANY($1::uuid[])', [f2.regression_card_ids]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      origin: 'regression',
      card_type: 'regression',
      home_workstation_id: w.workstationId,
      phase_followup_id: f2.id,
      phase_id: null,
    });
    expect(cards[0]?.fields).toMatchObject({
      targetUrl: 'http://localhost:4601',
      deployTarget: 'local',
      platform: 'web',
    });
    expect(cards[0]?.fields.context).toContain('Run the full web regression suite');

    // it passes: follow-up 2 succeeded, follow-up 3 goes to DevOps
    await seed(w, [
      {
        streamId: streamId.card(cards[0]?.id),
        event: {
          type: 'FullSuitePassed',
          payload: {
            suiteCardId: cards[0]?.id,
            evidence: { summary: '12 passed', commands: [], outputExcerpt: '' },
            kind: 'regression',
            platform: 'web',
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    await phasePass(w.t.app.ctx);
    expect((await followups(phase.id))[1]).toMatchObject({ status: 'succeeded' });
    await phasePass(w.t.app.ctx);
    const f3 = (await followups(phase.id))[2]!;
    expect(f3.status).toBe('running');
    const r3 = await requestsOf(f3.id);
    expect(r3).toHaveLength(1);
    expect(r3[0]?.summary).toContain('Post the release notes');
    await completeRequest(r3[0]?.id, 'done', 'posted');
    await phasePass(w.t.app.ctx);
    expect((await phaseRow(phase.id)).status).toBe('reporting_results');

    // the results task finds no BA: template report, a calm notice
    await dispatcher().runPass();
    const finished = await phaseRow(phase.id);
    expect(finished.status).toBe('done');
    const item = (
      await q('SELECT kind, subkind, pinned, title, body FROM desk_items WHERE id=$1', [
        finished.results_desk_item_id,
      ])
    )[0]!;
    expect(item).toMatchObject({ kind: 'alert', subkind: 'phase_results', pinned: false });
    expect(item.title).toContain('3 succeeded');
    expect(item.body).toContain('Your BA was not available');
    await ok(
      owner('POST', `/api/desk/${finished.results_desk_item_id}/resolve`, { resolution: 'acknowledged' }),
    );
    // the phase thread tells the story
    const notes = (
      await q(`SELECT body FROM thread_messages WHERE thread_id=$1 ORDER BY created_at, event_seq`, [
        phase.id,
      ])
    ).map((m) => m.body);
    expect(notes.some((n) => n.startsWith('Follow-up 1 of 3'))).toBe(true);
    expect(notes.some((n) => n.includes('Follow-up 3 succeeded'))).toBe(true);
  });

  it('a failed deploy skips everything after it and the results notice is pinned', async () => {
    const { phase, itemId } = await awaitingApproval('Deploy fails', [
      { kind: 'deploy', targetId: remote.id },
      { kind: 'regression', targetId: remote.id },
      { kind: 'custom', instruction: 'Announce it' },
    ]);
    await approve(itemId);
    await dispatcher().runPass();
    await phasePass(w.t.app.ctx);
    const f1 = (await followups(phase.id))[0]!;
    const reqs = await requestsOf(f1.id);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.workstation_id).toBe(member.workstationId);
    expect(reqs[0]?.summary).toContain('stg.example');
    await completeRequest(reqs[0]?.id, 'failed', 'ssh: connection refused');
    await phasePass(w.t.app.ctx);
    await phasePass(w.t.app.ctx);
    const rows = await followups(phase.id);
    expect(rows.map((f) => f.status)).toEqual(['failed', 'skipped', 'skipped']);
    expect(rows[0]?.result_summary).toContain('connection refused');
    expect(rows[1]?.result_summary).toContain('follow-up 1 failed');
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM cards WHERE phase_followup_id IS NOT NULL AND phase_followup_id = $1',
          [rows[1]?.id],
        )
      )[0]?.n,
    ).toBe(0);
    await dispatcher().runPass();
    const finished = await phaseRow(phase.id);
    expect(finished.status).toBe('done_with_failures');
    const item = (
      await q('SELECT pinned, title FROM desk_items WHERE id=$1', [finished.results_desk_item_id])
    )[0]!;
    expect(item).toMatchObject({ pinned: true });
    expect(item.title).toContain('1 failed');
  });

  it('a failing regression run stops the rest and names the bug it filed', async () => {
    const t = pipeline(w, r);
    const { phase, itemId } = await awaitingApproval('Regression fails', [
      { kind: 'regression' },
      { kind: 'custom', instruction: 'Never runs' },
    ]);
    await approve(itemId);
    await dispatcher().runPass();
    await phasePass(w.t.app.ctx);
    const f1 = (await followups(phase.id))[0]!;
    expect(f1.status).toBe('running');
    await t.run('Tess', testFail('Regression bug', 'login broke'));
    await phasePass(w.t.app.ctx);
    const after = await followups(phase.id);
    expect(after[0]?.status).toBe('failed');
    expect(after[0]?.result_summary).toContain('Regression run failed');
    expect(after[0]?.evidence.bugRefs).toHaveLength(1);
    // the bug filed by the regression run joined the phase (A6)
    const bug = (
      await q(`SELECT * FROM cards WHERE card_type='bug' AND parent_card_id = ANY($1::uuid[])`, [
        f1.regression_card_ids,
      ])
    )[0]!;
    expect(bug).toMatchObject({ phase_id: phase.id, phase_assignment: 'confirmed' });
    await phasePass(w.t.app.ctx);
    expect((await followups(phase.id))[1]?.status).toBe('skipped');
    await dispatcher().runPass();
    expect((await phaseRow(phase.id)).status).toBe('done_with_failures');
  });

  it('a follow-up that cannot start fails at once with the reason', async () => {
    const { phase, itemId } = await awaitingApproval('Cannot start', [
      { kind: 'deploy', targetId: remote.id },
      { kind: 'custom', instruction: 'After' },
    ]);
    await approve(itemId);
    await dispatcher().runPass();
    await q(`UPDATE agents SET status='retired' WHERE workstation_id=$1 AND is_devops`, [
      member.workstationId,
    ]);
    await phasePass(w.t.app.ctx);
    const rows = await followups(phase.id);
    expect(rows.map((f) => f.status)).toEqual(['failed', 'briefed']);
    expect(rows[0]?.result_summary).toContain('no DevOps engineer');
    await q(`UPDATE agents SET status='active' WHERE workstation_id=$1 AND is_devops`, [
      member.workstationId,
    ]);
  });
});
