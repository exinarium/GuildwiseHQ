import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember, type Member } from './helpers/members.ts';
import { createWorld, ok, pairWorkstation, type World } from './helpers/world.ts';

let w: World;
let member: Member;
let localTarget: any;
let sshTarget: any;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  member = await addMember(w, 'mgr');
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const asMember = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: member.cookie, body });

const mkPhase = (name: string, extra: Record<string, unknown> = {}) =>
  ok<any>(owner('POST', `/api/projects/${w.projectId}/phases`, { name, ...extra }), 201);

describe('deploy targets', () => {
  it('a member adds a local Docker target and a remote host on a member workstation', async () => {
    localTarget = await ok<any>(
      asMember('POST', `/api/projects/${w.projectId}/deploy-targets`, {
        name: 'local',
        kind: 'local_docker',
        appUrl: 'http://localhost:4601',
        notes: 'docker compose up -d',
      }),
      201,
    );
    expect(localTarget).toMatchObject({ kind: 'local_docker', workstationId: null, host: null });
    sshTarget = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/deploy-targets`, {
        name: 'staging',
        kind: 'remote_ssh',
        workstationId: member.workstationId,
        host: 'stg.example',
        appUrl: 'https://stg.example',
      }),
      201,
    );
    expect(sshTarget.workstationName).toBeTruthy();
    const list = await ok<any>(asMember('GET', `/api/projects/${w.projectId}/deploy-targets`));
    expect(list.targets.map((t: any) => t.name)).toEqual(['local', 'staging']);
  });

  it('validates the shape: names, URL, host, workstation membership', async () => {
    const base = `/api/projects/${w.projectId}/deploy-targets`;
    expect((await owner('POST', base, { name: 'LOCAL', kind: 'local_docker' })).status).toBe(409);
    expect((await owner('POST', base, { name: 'x', kind: 'local_docker', appUrl: 'ftp://x' })).status).toBe(
      400,
    );
    expect(
      (
        await owner('POST', base, {
          name: 'x',
          kind: 'remote_ssh',
          host: '-oProxyCommand=x',
          workstationId: w.workstationId,
        })
      ).status,
    ).toBe(400);
    expect((await owner('POST', base, { name: 'x', kind: 'remote_ssh', host: 'h' })).status).toBe(422);
    expect(
      (await owner('POST', base, { name: 'x', kind: 'local_docker', workstationId: w.workstationId })).status,
    ).toBe(422);
    // a workstation of somebody who is not a member of the project
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    const other = await pairWorkstation(w.t, stranger, 'other-box');
    const r = await owner('POST', base, {
      name: 'x',
      kind: 'remote_ssh',
      host: 'h',
      workstationId: other.workstationId,
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('workstation_not_member');
  });

  it('a non-member cannot see or change targets', async () => {
    const stranger = await w.t.userSession(uniqueEmail('nosy'));
    expect(
      (await w.t.req('GET', `/api/projects/${w.projectId}/deploy-targets`, { cookie: stranger.cookie }))
        .status,
    ).toBe(404);
    expect(
      (
        await w.t.req('PATCH', `/api/deploy-targets/${localTarget.id}`, {
          cookie: stranger.cookie,
          body: { notes: 'x' },
        })
      ).status,
    ).toBe(404);
  });

  it('updates a target and refuses to remove one a pending follow-up uses', async () => {
    const patched = await ok<any>(
      owner('PATCH', `/api/deploy-targets/${localTarget.id}`, { notes: 'new notes' }),
    );
    expect(patched.notes).toBe('new notes');
    const p = await mkPhase('Uses local', { followups: [{ kind: 'deploy', targetId: localTarget.id }] });
    const r = await owner('DELETE', `/api/deploy-targets/${localTarget.id}`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('target_in_use');
    await ok(owner('PUT', `/api/phases/${p.id}/followups`, { followups: [] }));
    // still used by nothing now: a throwaway target can be removed
    const tmp = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/deploy-targets`, { name: 'tmp', kind: 'local_docker' }),
      201,
    );
    expect((await owner('DELETE', `/api/deploy-targets/${tmp.id}`)).status).toBe(204);
    expect(
      (await ok<any>(owner('GET', `/api/projects/${w.projectId}/deploy-targets`))).targets.map(
        (t: any) => t.name,
      ),
    ).not.toContain('tmp');
  });
});

describe('phases', () => {
  it('creates a phase with the project default follow-ups, a ref and a thread', async () => {
    await ok(
      owner('PUT', `/api/projects/${w.projectId}/followup-defaults`, {
        followups: [
          { kind: 'deploy', targetId: localTarget.id },
          { kind: 'regression', platform: 'web' },
        ],
      }),
    );
    expect(
      (await ok<any>(asMember('GET', `/api/projects/${w.projectId}/followup-defaults`))).followups.map(
        (f: any) => f.kind,
      ),
    ).toEqual(['deploy', 'regression']);
    const p = await mkPhase('Autosave', { description: 'Save as you type' });
    // P1 is the phase the deploy-target test made
    expect(p).toMatchObject({
      ref: 'TOY-P2',
      number: 2,
      name: 'Autosave',
      status: 'open',
      projectKey: 'TOY',
    });
    expect(p.followups.map((f: any) => f.label)).toEqual(['Deploy to local', 'Regression run (web)']);
    expect(p.followups.every((f: any) => f.status === 'pending')).toBe(true);
    expect(p.canEditFollowups).toBe(true);
    expect(p.createdBy.kind).toBe('user');
    expect((await q('SELECT kind FROM threads WHERE id=$1', [p.id]))[0]?.kind).toBe('phase');
    const byNumber = await ok<any>(owner('GET', '/api/phases/by-number/TOY/2'));
    expect(byNumber.id).toBe(p.id);
  });

  it('phase names are unique per project (case-insensitive), numbers count up', async () => {
    const r = await owner('POST', `/api/projects/${w.projectId}/phases`, { name: 'autosave' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('phase_name_taken');
    const p2 = await mkPhase('Second', { followups: [] });
    expect(p2.ref).toBe('TOY-P3');
    expect(p2.followups).toEqual([]);
    const list = await ok<any>(asMember('GET', `/api/projects/${w.projectId}/phases`));
    expect(list.phases.map((p: any) => p.ref).slice(0, 3)).toEqual(['TOY-P3', 'TOY-P2', 'TOY-P1']);
  });

  it('a member renames, describes and sets the working branch; a bad branch is refused', async () => {
    const p = await mkPhase('Rename me', { followups: [] });
    const patched = await ok<any>(
      asMember('PATCH', `/api/phases/${p.id}`, {
        name: 'Renamed',
        description: 'd',
        workingBranch: 'release/1',
      }),
    );
    expect(patched).toMatchObject({ name: 'Renamed', description: 'd', workingBranch: 'release/1' });
    expect((await asMember('PATCH', `/api/phases/${p.id}`, { workingBranch: '--evil' })).status).toBe(400);
    expect((await asMember('PATCH', `/api/phases/${p.id}`, { name: 'Autosave' })).status).toBe(409);
  });

  it('validates follow-ups: unknown target, mock scripts need AOM_MOCK_UI, more than ten', async () => {
    expect(
      (
        await owner('POST', `/api/projects/${w.projectId}/phases`, {
          name: 'Bad target',
          followups: [{ kind: 'deploy', targetId: randomUUID() }],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await owner('POST', `/api/projects/${w.projectId}/phases`, {
          name: 'Many',
          followups: Array.from({ length: 11 }, () => ({ kind: 'regression' })),
        })
      ).status,
    ).toBe(400);
    // the world runs with AOM_MOCK_UI: a mock script is accepted and kept
    const p = await mkPhase('Mocked', {
      followups: [{ kind: 'regression', mock: { test: ['fail'] } }],
    });
    expect(p.followupDetails[0].mock).toEqual({ test: ['fail'] });
  });

  it('editing the follow-up list keeps the ids of the items that stay, and freezes once the phase runs', async () => {
    const p = await mkPhase('Editable', { followups: [{ kind: 'regression' }] });
    const id = p.followupDetails[0].id;
    const edited = await ok<any>(
      owner('PUT', `/api/phases/${p.id}/followups`, {
        followups: [
          { id, kind: 'regression', platform: 'both' },
          { kind: 'custom', instruction: 'Tell the team' },
        ],
      }),
    );
    expect(edited.followupDetails.map((f: any) => f.kind)).toEqual(['regression', 'custom']);
    expect(edited.followupDetails[0].id).toBe(id);
    expect(edited.followupDetails[0].platform).toBe('both');
    await q(`UPDATE phases SET status='running_followups' WHERE id=$1`, [p.id]);
    const frozen = await owner('PUT', `/api/phases/${p.id}/followups`, { followups: [] });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.code).toBe('followups_frozen');
  });
});

describe('assigning cards', () => {
  let phase: any;
  let other: any;
  beforeAll(async () => {
    phase = await mkPhase('Assign here', { followups: [] });
    other = await mkPhase('Assign there', { followups: [] });
  });

  it('puts a card in a phase and moves it to another (one phase per card)', async () => {
    const c = await w.card({ title: 'A card', specify: false });
    const r = await ok<any>(asMember('PUT', `/api/cards/${c.id}/phase`, { phaseId: phase.id }));
    expect(r.phase).toMatchObject({ ref: phase.ref, assignment: 'confirmed' });
    expect(r.permissions.canSetPhase).toBe(true);
    const moved = await ok<any>(owner('PUT', `/api/cards/${c.id}/phase`, { phaseId: other.id }));
    expect(moved.phase.ref).toBe(other.ref);
    const detail = await ok<any>(owner('GET', `/api/phases/${phase.id}`));
    expect(detail.members).toEqual([]);
    const back = await ok<any>(owner('PUT', `/api/cards/${c.id}/phase`, { phaseId: null }));
    expect(back.phase).toBeNull();
    // the timeline records it
    expect(back.activity.map((a: any) => a.kind)).toContain('phase');
  });

  it('the board shows the chip and filters by phase or "none"', async () => {
    const a = await w.card({ title: 'In phase', specify: false });
    const b = await w.card({ title: 'No phase', specify: false });
    await ok(owner('PUT', `/api/cards/${a.id}/phase`, { phaseId: phase.id }));
    const all = await ok<any>(owner('GET', `/api/board?projectId=${w.projectId}`));
    const flat = (r: any) => r.columns.flatMap((c: any) => c.cards);
    expect(flat(all).find((c: any) => c.id === a.id).phase).toMatchObject({ ref: phase.ref });
    expect(flat(all).find((c: any) => c.id === b.id).phase).toBeNull();
    const only = await ok<any>(owner('GET', `/api/board?projectId=${w.projectId}&phaseId=${phase.id}`));
    expect(flat(only).map((c: any) => c.id)).toEqual([a.id]);
    const none = await ok<any>(owner('GET', `/api/board?projectId=${w.projectId}&phaseId=none`));
    expect(flat(none).map((c: any) => c.id)).toContain(b.id);
    expect(flat(none).map((c: any) => c.id)).not.toContain(a.id);
  });

  it('refuses a terminal card, a card of another project, suite cards, bug children and closed phases', async () => {
    const done = await w.card({ title: 'Finished', specify: false });
    await q(`UPDATE cards SET status='done', stage='done' WHERE id=$1`, [done.id]);
    const terminal = await owner('PUT', `/api/cards/${done.id}/phase`, { phaseId: phase.id });
    expect(terminal.status).toBe(409);
    expect(terminal.body.error.code).toBe('card_terminal');

    const proj2 = await ok<any>(owner('POST', '/api/projects', { key: 'OTH', name: 'Other' }), 201);
    const foreign = await ok<any>(
      owner('POST', '/api/cards', {
        projectId: proj2.project.id,
        title: 'Foreign',
        cardType: 'feature',
        fields: {},
      }),
      201,
    );
    const wrong = await owner('PUT', `/api/cards/${foreign.card.id}/phase`, { phaseId: phase.id });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('wrong_project');

    const suite = await w.card({ title: 'Suite', specify: false });
    await q(`UPDATE cards SET card_type='regression', origin='full_suite' WHERE id=$1`, [suite.id]);
    expect((await owner('PUT', `/api/cards/${suite.id}/phase`, { phaseId: phase.id })).body.error.code).toBe(
      'not_a_member_card',
    );
    const child = await w.card({ title: 'Bug child', specify: false });
    await q(`UPDATE cards SET worktree_card_id=$2 WHERE id=$1`, [child.id, suite.id]);
    expect((await owner('PUT', `/api/cards/${child.id}/phase`, { phaseId: phase.id })).body.error.code).toBe(
      'not_a_member_card',
    );

    const c = await w.card({ title: 'Late', specify: false });
    await q(`UPDATE phases SET status='reporting' WHERE id=$1`, [other.id]);
    const closed = await owner('PUT', `/api/cards/${c.id}/phase`, { phaseId: other.id });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('phase_not_open');
    await q(`UPDATE phases SET status='open' WHERE id=$1`, [other.id]);
  });

  it('a non-member cannot assign cards or read phases', async () => {
    const stranger = await w.t.userSession(uniqueEmail('stranger2'));
    const c = await w.card({ title: 'Mine', specify: false });
    expect(
      (
        await w.t.req('PUT', `/api/cards/${c.id}/phase`, {
          cookie: stranger.cookie,
          body: { phaseId: phase.id },
        })
      ).status,
    ).toBe(404);
    expect((await w.t.req('GET', `/api/phases/${phase.id}`, { cookie: stranger.cookie })).status).toBe(404);
    expect(
      (await w.t.req('GET', `/api/projects/${w.projectId}/phases`, { cookie: stranger.cookie })).status,
    ).toBe(404);
  });
});

describe('reopen and merge confirmation', () => {
  it('reopen is only allowed before approval', async () => {
    const p = await mkPhase('Reopen me', { followups: [] });
    const early = await owner('POST', `/api/phases/${p.id}/reopen`, { reason: 'x' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('cannot_reopen');
    await q(`UPDATE phases SET status='reporting', completed_at=now() WHERE id=$1`, [p.id]);
    const r = await ok<any>(owner('POST', `/api/phases/${p.id}/reopen`, { reason: 'one more card' }));
    expect(r.status).toBe('open');
    await q(`UPDATE phases SET status='running_followups' WHERE id=$1`, [p.id]);
    expect((await owner('POST', `/api/phases/${p.id}/reopen`, { reason: 'x' })).status).toBe(409);
  });

  it('a member confirms by hand that a finalized pr card is in the working branch', async () => {
    const c = await w.card({ title: 'PR card', specify: false, completionAction: 'pr' });
    const nope = await owner('POST', `/api/cards/${c.id}/confirm-merged`, {});
    expect(nope.status).toBe(409);
    await q(
      `UPDATE cards SET status='done', stage='done', finalized_at=now(), finalize_action='pr',
              finalize_result='{"prUrl":"https://x/pr/1"}', branch_name='aom/toy-1' WHERE id=$1`,
      [c.id],
    );
    await ok(asMember('POST', `/api/cards/${c.id}/confirm-merged`, { note: 'squash merged' }));
    expect(
      (await q('SELECT merged_into_working_at FROM cards WHERE id=$1', [c.id]))[0]?.merged_into_working_at,
    ).not.toBeNull();
    expect((await owner('POST', `/api/cards/${c.id}/confirm-merged`, {})).body.error.code).toBe(
      'already_merged',
    );
  });
});
