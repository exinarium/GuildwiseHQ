import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { designer, responderRole, roleInput, triagerRole, workflowInput } from './helpers/designer.ts';
import { addMember, type Member } from './helpers/members.ts';
import { createWorld, ok, type Session, type World } from './helpers/world.ts';

let w: World;
let d: ReturnType<typeof designer>;
let admin: Session;
let member: Member;
beforeAll(async () => {
  w = await createWorld();
  d = designer(w);
  await ok(w.t.req('POST', '/api/departments', { cookie: w.owner.cookie, body: { name: 'support' } }), 201);
  admin = await w.t.userSession(uniqueEmail('admin'));
  await w.t.addOrgMember(w.owner.id, admin.id, 'admin');
  member = await addMember(w, 'rb-member');
  await d.publish('roles', triagerRole());
  await d.publish('roles', responderRole());
  await d.publish('workflows', workflowInput('support'));
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const asAdmin = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: admin.cookie, body, headers: { 'x-aom-org': w.owner.id } });

describe('prompt preview (POST /api/roles/preview)', () => {
  it('renders the real instructions file from a sample brief without running an agent', async () => {
    const agentsBefore = (await q('SELECT count(*)::int AS n FROM agents'))[0]!.n;
    const shiftsBefore = (await q('SELECT count(*)::int AS n FROM shifts'))[0]!.n;
    const r = await ok<any>(
      d.req('POST', '/api/roles/preview', { role: roleInput('previewer', [['support', 'triage']]) }),
    );
    expect(r.stage).toBeNull();
    expect(r.text).toContain('You are the previewer. Do the work of your stage');
    expect(r.text).toContain('- Never promise refunds.');
    expect(r.text).toContain('Sample Agent, a junior Previewer');
    expect(r.headings).toEqual(
      expect.arrayContaining([
        'Who you are',
        'Role instructions',
        'Core rules',
        'How to report',
        'Boundaries',
      ]),
    );
    expect((await q('SELECT count(*)::int AS n FROM agents'))[0]!.n).toBe(agentsBefore);
    expect((await q('SELECT count(*)::int AS n FROM shifts'))[0]!.n).toBe(shiftsBefore);
  });

  it('uses the chosen step of a custom workflow and the seniority', async () => {
    const r = await ok<any>(
      d.req('POST', '/api/roles/preview', {
        role: triagerRole(),
        workflowKey: 'support',
        stageId: 'triage',
        seniority: 'senior',
      }),
    );
    expect(r.stage).toEqual({ workflowKey: 'support', stageId: 'triage', stageLabel: 'Triage' });
    expect(r.text).toContain('a senior Triager');
    expect(r.text).toContain('"Triage" stage');
    expect(r.text).toContain('triaged (success)');
  });

  it('picks the first step the role claims when only the workflow is named', async () => {
    const r = await ok<any>(
      d.req('POST', '/api/roles/preview', { role: responderRole(), workflowKey: 'support' }),
    );
    expect(r.stage?.stageId).toBe('resolve');
    expect(r.text).toContain('escalate (failure)');
  });

  it('previews an unfinished role (no name yet) and refuses unknown or non-agent steps', async () => {
    const draft = { ...roleInput('half', []), name: '', instructions: 'x' };
    const r = await ok<any>(d.req('POST', '/api/roles/preview', { role: draft }));
    expect(r.text).toContain('Unnamed role');
    const unknown = await d.req('POST', '/api/roles/preview', {
      role: triagerRole(),
      workflowKey: 'nope',
    });
    expect(unknown.status).toBe(404);
    const manual = await d.req('POST', '/api/roles/preview', {
      role: triagerRole(),
      workflowKey: 'support',
      stageId: 'intake',
    });
    expect(manual.status).toBe(400);
    const noWorkflow = await d.req('POST', '/api/roles/preview', { role: triagerRole(), stageId: 'triage' });
    expect(noWorkflow.status).toBe(400);
    // A built-in workflow is not a custom workflow of the organization.
    const builtin = await d.req('POST', '/api/roles/preview', { role: triagerRole(), workflowKey: 'code' });
    expect(builtin.status).toBe(404);
  });

  it('rejects an invalid role body', async () => {
    const r = await d.req('POST', '/api/roles/preview', { role: { key: 'Bad Key' } });
    expect(r.status).toBe(400);
  });

  it('is open to the Owner and Admins, not to members or strangers', async () => {
    const body = { role: triagerRole() };
    expect((await asAdmin('POST', '/api/roles/preview', body)).status).toBe(200);
    const asMember = await w.t.req('POST', `/api/roles/preview?projectId=${w.projectId}`, {
      cookie: member.cookie,
      body,
    });
    expect(asMember.status).toBe(403);
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    const asStranger = await w.t.req('POST', `/api/roles/preview?projectId=${w.projectId}`, {
      cookie: stranger.cookie,
      body,
    });
    expect(asStranger.status).toBe(404);
    expect((await w.t.req('POST', '/api/roles/preview', { body })).status).toBe(401);
  });
});

describe('prompt preview of a stored draft (GET /api/roles/drafts/:id/preview)', () => {
  it('renders the stored draft, with a step of a workflow', async () => {
    const draft = await d.draft('roles', roleInput('stored', [['support', 'triage']]));
    const r = await ok<any>(
      d.req(
        'GET',
        `/api/roles/drafts/${draft.id}/preview?workflowKey=support&stageId=triage&seniority=senior`,
      ),
    );
    expect(r.text).toContain('You are the stored.');
    expect(r.text).toContain('a senior Stored');
    expect(r.stage?.stageLabel).toBe('Triage');
    expect((await asAdmin('GET', `/api/roles/drafts/${draft.id}/preview`)).status).toBe(200);
  });

  it('404s for built-in roles, other organizations and members', async () => {
    const builtinId = (
      await q(`SELECT id FROM role_definitions WHERE org_id IS NULL AND key='builder' LIMIT 1`)
    )[0]!.id as string;
    expect((await d.req('GET', `/api/roles/drafts/${builtinId}/preview`)).status).toBe(404);
    const draft = await d.draft('roles', roleInput('theirs', [['support', '*']]));
    const other = await w.t.userSession(uniqueEmail('other'));
    expect(
      (await w.t.req('GET', `/api/roles/drafts/${draft.id}/preview`, { cookie: other.cookie })).status,
    ).toBe(404);
    const asMember = await w.t.req('GET', `/api/roles/drafts/${draft.id}/preview?projectId=${w.projectId}`, {
      cookie: member.cookie,
    });
    expect(asMember.status).toBe(403);
  });
});

describe('Admins build roles; widening stays with the Owner', () => {
  it('an Admin drafts and submits a role, and the Owner approves it', async () => {
    const draft = await ok<any>(
      asAdmin('POST', '/api/roles', roleInput('adminrole', [['support', '*']])),
      201,
    );
    expect(draft.issues).toEqual([]);
    const sub = await ok<any>(asAdmin('POST', `/api/roles/${draft.id}/submit`));
    expect((await d.resolve(sub.deskItemId, 'approved')).status).toBe(200);
  });

  it('an Admin cannot save or submit a role that reads every organization repository', async () => {
    const wide = roleInput('wide', [['support', '*']]);
    (wide.permissions as any).readOrgRepos = true;
    const refused = await asAdmin('POST', '/api/roles', wide);
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/only the organization Owner/);
    // Owner drafts it (a warning, not an error), an Admin cannot submit it, the Owner can.
    const draft = await ok<any>(d.req('POST', '/api/roles', wide), 201);
    expect(draft.issues.map((i: any) => i.code)).toContain('reads_org_repos');
    expect((await asAdmin('POST', `/api/roles/${draft.id}/submit`)).status).toBe(403);
    expect((await asAdmin('PUT', `/api/roles/${draft.id}`, wide)).status).toBe(403);
    const sub = await ok<any>(d.req('POST', `/api/roles/${draft.id}/submit`));
    expect((await d.resolve(sub.deskItemId, 'approved')).status).toBe(200);
  });

  it('an Admin cannot approve a wide role on the desk', async () => {
    const wide = roleInput('wide2', [['support', '*']]);
    (wide.permissions as any).readOrgRepos = true;
    const draft = await ok<any>(d.req('POST', '/api/roles', wide), 201);
    const sub = await ok<any>(d.req('POST', `/api/roles/${draft.id}/submit`));
    const r = await w.t.req('POST', `/api/desk/${sub.deskItemId}/resolve`, {
      cookie: admin.cookie,
      body: { resolution: 'approved' },
      headers: { 'x-aom-org': w.owner.id },
    });
    expect(r.status).toBe(403);
    expect((await d.resolve(sub.deskItemId, 'approved')).status).toBe(200);
  });
});
