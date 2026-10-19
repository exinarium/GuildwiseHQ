import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchOrgGraph, orgGraphScopeFor } from '../src/commands/org-graph.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_PROJECT_GRAPHS: 'true', AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const ctx = () => w.t.app.ctx;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, ...(body === undefined ? {} : { body }) });
const orgId = async () =>
  (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]!.org_id as string;
const orgCommands = () =>
  r
    .of('command')
    .filter((c) => c.command === 'graph.org')
    .map((c) => ({ id: c.commandId, payload: c.payload as any }));

let second: string;

describe('links the Owner asserts (design section 8: ids and names they typed, nothing from code)', () => {
  it('the Owner links two projects and a project to a name they typed; the event holds ids and that name only', async () => {
    const p2 = await ok<any>(owner('POST', '/api/projects', { key: 'BILL', name: 'Billing' }), 201);
    second = p2.project.id;
    const a = await ok<any>(
      owner('POST', '/api/org-graph/links', {
        from: { projectId: w.projectId },
        to: { projectId: second },
        kind: 'depends_on',
        note: 'checkout charges through billing',
      }),
      201,
    );
    expect(a.links).toHaveLength(1);
    expect(a.links[0]).toMatchObject({
      kind: 'depends_on',
      origin: 'owner',
      note: 'checkout charges through billing',
      from: { projectId: w.projectId, label: 'TOY' },
      to: { projectId: second, label: 'BILL' },
    });
    const b = await ok<any>(
      owner('POST', '/api/org-graph/links', {
        from: { projectId: w.projectId },
        to: { name: ' status-page.example ' },
        kind: 'uses',
      }),
      201,
    );
    expect(b.links).toHaveLength(2);
    expect(b.links[1]).toMatchObject({ to: { projectId: null, label: 'status-page.example' } });
    const ev = await q(`SELECT payload FROM events WHERE type='OrgGraphLinkAsserted' ORDER BY seq`);
    expect(ev).toHaveLength(2);
    expect(JSON.stringify(ev[0]!.payload)).not.toMatch(/\.(ts|cs|py|go)\b/);
    expect(Object.keys(ev[0]!.payload).sort()).toEqual([
      'by',
      'from',
      'kind',
      'linkId',
      'note',
      'orgId',
      'origin',
      'to',
    ]);
    expect(ev[1]!.payload.to).toEqual({ name: 'status-page.example' });
  });

  it('the same link twice is one link; a link needs two different ends; a project of another organization is not found', async () => {
    const again = await ok<any>(
      owner('POST', '/api/org-graph/links', {
        from: { projectId: w.projectId },
        to: { projectId: second },
        kind: 'depends_on',
      }),
      201,
    );
    expect(again.links).toHaveLength(2);
    expect(
      (
        await owner('POST', '/api/org-graph/links', {
          from: { projectId: second },
          to: { projectId: second },
        })
      ).status,
    ).toBe(400);
    expect(
      (await owner('POST', '/api/org-graph/links', { from: { name: 'A' }, to: { name: ' a ' } })).status,
    ).toBe(400);
    const other = await w.t.userSession(uniqueEmail('stranger'));
    const foreign = await ok<any>(
      w.t.req('POST', '/api/projects', { cookie: other.cookie, body: { key: 'FOR', name: 'Foreign' } }),
      201,
    );
    expect(
      (
        await owner('POST', '/api/org-graph/links', {
          from: { projectId: w.projectId },
          to: { projectId: foreign.project.id },
        })
      ).status,
    ).toBe(404);
  });

  it('Members cannot assert, retract or list; the Owner retracts', async () => {
    const m = await w.t.userSession(uniqueEmail('member'));
    await w.t.addOrgMember(await orgId(), m.id, 'member');
    const asMember = (method: string, url: string, body?: unknown) =>
      w.t.req(method, url, {
        cookie: m.cookie,
        headers: { 'x-aom-org': 'x' },
        ...(body === undefined ? {} : { body }),
      });
    const withOrg = async (method: string, url: string, body?: unknown) =>
      w.t.req(method, url, {
        cookie: m.cookie,
        headers: { 'x-aom-org': await orgId() },
        ...(body === undefined ? {} : { body }),
      });
    expect(asMember).toBeTypeOf('function');
    expect((await withOrg('GET', '/api/org-graph/links')).status).toBe(403);
    expect(
      (await withOrg('POST', '/api/org-graph/links', { from: { name: 'a' }, to: { name: 'b' } })).status,
    ).toBe(403);
    const list = await ok<any>(owner('GET', '/api/org-graph/links'));
    expect((await withOrg('DELETE', `/api/org-graph/links/${list.links[0].id}`)).status).toBe(403);
    const after = await ok<any>(owner('DELETE', `/api/org-graph/links/${list.links[1].id}`));
    expect(after.links).toHaveLength(1);
    expect((await owner('DELETE', `/api/org-graph/links/${list.links[1].id}`)).status).toBe(404);
    expect(await q(`SELECT 1 FROM events WHERE type='OrgGraphLinkRetracted'`)).toHaveLength(1);
  });

  it('a projection rebuild reproduces the links', async () => {
    const before = await q(
      'SELECT link_id, kind, from_project_id, from_name, to_project_id, to_name, note, retracted_at FROM org_graph_links ORDER BY link_id',
    );
    expect(before).toHaveLength(2);
    await rebuildProjections(ctx().pool, ctx().store);
    const after = await q(
      'SELECT link_id, kind, from_project_id, from_name, to_project_id, to_name, note, retracted_at FROM org_graph_links ORDER BY link_id',
    );
    expect(after).toEqual(before);
  });
});

describe('the build request: the workstation is told what to build from, and the answer is not stored', () => {
  it('a link or an indexed project queues graph.org to the workstation of the organization vault, once while it waits', async () => {
    const vaults = await q(
      `SELECT id, storage, local_workstation_id FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`,
      [await orgId()],
    );
    expect(vaults).toHaveLength(1);
    expect(vaults[0]).toMatchObject({ storage: 'local', local_workstation_id: w.workstationId });
    await until(async () => orgCommands().length >= 1, 4000, 'graph.org');
    const n = orgCommands().length;
    const cmd = orgCommands().at(-1)!;
    expect(cmd.payload.vault).toEqual({ vaultId: vaults[0]!.id, storage: 'local' });
    expect(cmd.payload.projects.map((p: any) => p.key).sort()).toEqual(['BILL', 'TOY']);
    expect(cmd.payload.projects.every((p: any) => p.retired === false)).toBe(true);
    expect(cmd.payload.assertions.length).toBeGreaterThanOrEqual(1);
    expect(cmd.payload.assertions[0]).toMatchObject({
      from: { projectId: w.projectId },
      to: { projectId: second },
      kind: 'depends_on',
    });
    // one build runs at a time: requests that come meanwhile do not pile up, they mark it dirty
    expect(await dispatchOrgGraph(ctx(), await orgId())).toBe(true);
    expect(await dispatchOrgGraph(ctx(), await orgId())).toBe(true);
    expect(
      await q(`SELECT 1 FROM runner_commands WHERE type='graph.org' AND status IN ('pending','sent')`),
    ).toHaveLength(1);
    expect(orgCommands().length).toBe(n);
    expect((await q('SELECT payload FROM runner_commands WHERE id=$1', [cmd.id]))[0]!.payload.dirty).toBe(
      true,
    );
    // the answer is a plain completion (counts are not stored); the dirty request is asked again, from the state of now
    r.send('command.result', {
      commandId: cmd.id,
      ok: true,
      result: { ok: true, projects: 2, withGraph: 0, drafts: 0, links: 1 },
    });
    await until(
      async () => (await q('SELECT status FROM runner_commands WHERE id=$1', [cmd.id]))[0]?.status === 'done',
      4000,
      'done',
    );
    await until(async () => orgCommands().length === n + 1, 4000, 'the build asked again');
    const again = orgCommands().at(-1)!;
    expect(again.payload.dirty).toBeUndefined();
    expect(again.payload.assertions).toHaveLength(1); // the link retracted meanwhile is not in it
    r.send('command.result', {
      commandId: again.id,
      ok: true,
      result: { ok: true, projects: 2, withGraph: 0, drafts: 0, links: 1 },
    });
    await until(
      async () =>
        (await q('SELECT status FROM runner_commands WHERE id=$1', [again.id]))[0]?.status === 'done',
      4000,
      'done',
    );
  });

  it('an archived project is sent as retired', async () => {
    await ok(owner('POST', `/api/projects/${second}/archive`), 200).catch(() => undefined);
    await q(`UPDATE projects SET status='archived' WHERE id=$1`, [second]);
    await q(`UPDATE runner_commands SET status='done' WHERE type='graph.org'`);
    expect(await dispatchOrgGraph(ctx(), await orgId())).toBe(true);
    await until(async () => orgCommands().length >= 2, 4000, 'graph.org after archive');
    const cmd = orgCommands().at(-1)!;
    expect(cmd.payload.projects.find((p: any) => p.key === 'BILL')).toMatchObject({ retired: true });
  });

  it('the CEO shift and chat are told where the graph is, and nothing is queued with the setting off', async () => {
    const scope = await orgGraphScopeFor(ctx(), await orgId());
    const [v] = await q(`SELECT id FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`, [
      await orgId(),
    ]);
    expect(scope).toEqual({ vaultId: v!.id });
    ctx().config.projectGraphs.enabled = false;
    try {
      expect(await orgGraphScopeFor(ctx(), await orgId())).toBeUndefined();
      expect(await dispatchOrgGraph(ctx(), await orgId())).toBe(false);
    } finally {
      ctx().config.projectGraphs.enabled = true;
    }
  });
});
