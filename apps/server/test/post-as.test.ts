import { randomUUID } from 'node:crypto';
import { POST_AS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityFields, loadIdentityPlan } from '../src/commands/commit-as.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember } from './helpers/members.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let orgId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [POST_AS_CAPABILITY, 'app-integrations:1'] });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const url = () => `/api/projects/${w.projectId}/post-as`;
const owner = (method: string, u: string, body?: unknown) =>
  w.t.req(method, u, { cookie: w.owner.cookie, body });
const db = () => w.t.app.ctx.pool;

let n = 0;
/** An org app integration row (as GWP-214's projection writes it), optionally connected on the world's workstation. */
async function addApp(opts: { label: string; connected?: 'connected' | 'refused' | null; status?: string }) {
  const id = randomUUID();
  n++;
  const now = new Date();
  await q(
    `INSERT INTO org_app_integrations (id, org_id, provider, label, host, app_id, app_slug, app_name, installation_id, account,
       bot_login, bot_user_id, commit_name, commit_email, status, created_by, created_at, updated_at)
     VALUES ($1,$2,'github-app',$3,'github.com',$4,'acme-bot','Acme bot',$5,'acme','acme-bot[bot]','99',
             'acme-bot[bot]','99+acme-bot[bot]@users.noreply.github.com',$6,$7,$8,$8)`,
    [id, orgId, opts.label, String(4000 + n), String(700 + n), opts.status ?? 'active', randomUUID(), now],
  );
  if (opts.connected) {
    await q(
      `INSERT INTO org_app_integration_workstations (integration_id, workstation_id, via, added_at) VALUES ($1,$2,'web',$3)`,
      [id, w.workstationId, now],
    );
    await q(
      `INSERT INTO workstation_integrations (workstation_id, kind, instance, status, checked_at)
       VALUES ($1,'github-app',$2,$3::jsonb,$4)
       ON CONFLICT (workstation_id, kind, instance) DO UPDATE SET status=EXCLUDED.status`,
      [w.workstationId, `${4000 + n}:${700 + n}`, JSON.stringify({ state: opts.connected }), now],
    );
  }
  return id;
}

describe('post-as app selection (GWP-212.2)', () => {
  let appA: string;

  it('no app selected: payload identity fields are exactly as before', async () => {
    const plan = await loadIdentityPlan(db(), w.projectId);
    expect(plan.postAs).toBeNull();
    const fields = await identityFields(db(), w.projectId);
    expect(Object.keys(fields)).toEqual(['commitAs']);
    const res = await ok<any>(owner('GET', `/api/projects/${w.projectId}/commit-as`));
    expect(res.postAs).toMatchObject({ selected: [], canSelect: true, lastChange: null });
    expect(res.repos[0].resolved).toMatchObject({ repoId: w.repoId, source: 'repo' });
    expect(res.repos[0].resolved.fallbackReason).toBeUndefined();
  });

  it('rejects an unknown, a removed and a not connected app', async () => {
    expect((await owner('PUT', url(), { apps: [{ integrationId: randomUUID() }] })).status).toBe(400);
    const removed = await addApp({ label: 'Gone bot', connected: 'connected', status: 'removed' });
    expect((await owner('PUT', url(), { apps: [{ integrationId: removed }] })).status).toBe(400);
    const offline = await addApp({ label: 'Offline bot', connected: null });
    const res = await owner('PUT', url(), { apps: [{ integrationId: offline }] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Offline bot is not connected');
    const refused = await addApp({ label: 'Broken bot', connected: 'refused' });
    expect((await owner('PUT', url(), { apps: [{ integrationId: refused }] })).status).toBe(400);
  });

  it('a project member who is not an organization manager is forbidden', async () => {
    const id = await addApp({ label: 'Member try', connected: 'connected' });
    const m = await addMember(w, 'postas-member');
    const res = await w.t.req('PUT', url(), { cookie: m.cookie, body: { apps: [{ integrationId: id }] } });
    expect(res.status).toBe(403);
    const view = await ok<any>(
      w.t.req('GET', `/api/projects/${w.projectId}/commit-as`, { cookie: m.cookie }),
    );
    expect(view.postAs.canSelect).toBe(false);
  });

  it('the org owner ticks a connected app: event with actor, old and new; access check sent; plan resolves to app', async () => {
    appA = await addApp({ label: 'Acme bot', connected: 'connected' });
    const res = await owner('PUT', url(), { apps: [{ integrationId: appA }] });
    expect(res.status).toBe(200);
    expect(res.body.postAs.selected).toMatchObject([
      { integrationId: appA, label: 'Acme bot', state: 'connected' },
    ]);
    expect(res.body.postAs.lastChange).toMatchObject({ by: expect.any(String) });
    const ev = await q(`SELECT payload FROM events WHERE type='ProjectPostAsAppsSet' ORDER BY seq`);
    expect(ev.at(-1)?.payload).toEqual({
      projectId: w.projectId,
      apps: [{ integrationId: appA, provider: 'github-app' }],
      previous: [],
      setBy: w.owner.id,
    });
    // unchanged set: nothing appended
    await owner('PUT', url(), { apps: [{ integrationId: appA }] });
    expect((await q(`SELECT 1 FROM events WHERE type='ProjectPostAsAppsSet'`)).length).toBe(ev.length);

    const cmd = await q(
      `SELECT payload FROM runner_commands WHERE type='app.access_check' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(cmd[0]?.payload).toMatchObject({
      projectId: w.projectId,
      integrationId: appA,
      host: 'github.com',
    });
    expect(JSON.stringify(cmd[0]?.payload)).not.toMatch(/token|key/i);

    // coverage unknown: resolves to the app (fail closed)
    const plan = await loadIdentityPlan(db(), w.projectId);
    expect(plan.postAs?.repos[0]).toMatchObject({
      repoId: w.repoId,
      source: 'app',
      app: { integrationId: appA },
    });
    expect((await identityFields(db(), w.projectId)).postAs).toBeDefined();
  });

  it('a second app of the same provider is rejected with a clear message', async () => {
    const appB = await addApp({ label: 'Other bot', connected: 'connected' });
    const res = await owner('PUT', url(), { apps: [{ integrationId: appA }, { integrationId: appB }] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(
      'A project can post as one GitHub App only; untick Acme bot first',
    );
  });

  it('a repository the installation cannot reach is a warning and uses the fallback', async () => {
    await q(
      `INSERT INTO project_app_access (project_id, repo_id, integration_id, state, checked_at) VALUES ($1,$2,$3,'not_covered',now())
       ON CONFLICT (project_id, repo_id, integration_id) DO UPDATE SET state='not_covered'`,
      [w.projectId, w.repoId, appA],
    );
    const res = await ok<any>(owner('GET', `/api/projects/${w.projectId}/commit-as`));
    expect(res.repos[0]).toMatchObject({
      resolved: { source: 'repo', fallbackReason: 'not_covered' },
      access: { state: 'not_covered' },
    });
    expect((await loadIdentityPlan(db(), w.projectId)).postAs?.repos[0]?.source).toBe('repo');
    await q(`UPDATE project_app_access SET state='covered' WHERE project_id=$1`, [w.projectId]);
  });

  it('a removed integration shows "removed" and resolves to the fallback; the reference stays', async () => {
    await q(`UPDATE org_app_integrations SET status='removed', removed_at=now() WHERE id=$1`, [appA]);
    const res = await ok<any>(owner('GET', `/api/projects/${w.projectId}/commit-as`));
    expect(res.postAs.selected).toMatchObject([{ integrationId: appA, state: 'removed' }]);
    expect(res.repos[0].resolved).toMatchObject({ source: 'repo', fallbackReason: 'app_removed' });
    // unticking a removed app is always allowed and records old and new
    const cleared = await owner('PUT', url(), { apps: [] });
    expect(cleared.status).toBe(200);
    const ev = await q(`SELECT payload FROM events WHERE type='ProjectPostAsAppsSet' ORDER BY seq`);
    expect(ev.at(-1)?.payload).toMatchObject({ apps: [], previous: [{ integrationId: appA }] });
    expect((await q('SELECT post_as FROM projects WHERE id=$1', [w.projectId]))[0]?.post_as).toBeNull();
  });

  it('only an organization manager can re-run the access check', async () => {
    const m = await addMember(w, 'postas-check');
    expect((await w.t.req('POST', `${url()}/check`, { cookie: m.cookie })).status).toBe(403);
    expect((await owner('POST', `${url()}/check`)).status).toBe(202);
  });
});
