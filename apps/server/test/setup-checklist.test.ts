import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let member: { id: string; cookie: string };
let orgId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
  const u = await w.t.userSession(uniqueEmail('newbie'));
  await w.t.addOrgMember(orgId, u.id, 'member');
  member = u;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const get = (cookie = w.owner.cookie) =>
  ok<any>(w.t.req('GET', '/api/setup-checklist', { cookie, headers: { 'x-aom-org': orgId } }));
const step = (c: any, id: string) => c.steps.find((s: any) => s.id === id);

describe('setup checklist', () => {
  it('computes the steps from real state and ticks them as things appear', async () => {
    await freshState();
    await q(`UPDATE projects SET status='archived' WHERE id=$1`, [w.projectId]);
    let c = await get();
    expect(c.steps.map((s: any) => s.id)).toEqual(['project', 'repository', 'workstation', 'team', 'ba']);
    expect(step(c, 'project')).toMatchObject({ done: false, link: '/projects?new=1', actionable: true });
    expect(step(c, 'repository')).toMatchObject({ done: false });
    expect(step(c, 'workstation')).toMatchObject({ done: true, link: null });
    expect(step(c, 'team')).toMatchObject({ done: false, link: '/agents?hire=ba' });
    expect(c).toMatchObject({ doneCount: 1, complete: false, dismissed: false });

    await q(`UPDATE projects SET status='active' WHERE id=$1`, [w.projectId]);
    c = await get();
    expect(step(c, 'project').done).toBe(true);
    expect(step(c, 'repository').done).toBe(true);

    await w.hire('Ben', 'ba', 'senior');
    await w.hire('Bea', 'builder', 'junior');
    c = await get();
    expect(step(c, 'team')).toMatchObject({
      done: false,
      link: '/agents?hire=reviewer',
      missing: ['reviewer', 'tester'],
    });
    await w.hire('Rex', 'reviewer', 'senior');
    await w.hire('Tia', 'tester', 'junior');
    c = await get();
    expect(step(c, 'team')).toMatchObject({ done: true, link: null });
    expect(step(c, 'ba').done).toBe(false);
    expect(c.complete).toBe(false);
  });

  it('a Business mode organization has no repository step and needs no builder, reviewer or tester', async () => {
    await freshState();
    await q(`UPDATE organizations SET mode='business' WHERE id=$1`, [orgId]);
    try {
      let c = await get();
      expect(c.steps.map((s: any) => s.id)).toEqual([
        'project',
        'workstation',
        'team',
        'knowledge',
        'rules',
        'ba',
        'connections',
      ]);
      expect(step(c, 'team')).toMatchObject({
        done: false,
        link: '/agents?hire=ba',
        missing: ['business analyst'],
      });
      await w.hire('Ben', 'ba', 'senior');
      c = await get();
      expect(step(c, 'team')).toMatchObject({ done: true, link: null });
    } finally {
      await q(`UPDATE organizations SET mode='dev' WHERE id=$1`, [orgId]);
    }
  });

  it('the DevOps agent does not count as part of the team', async () => {
    await freshState();
    await w.hire('Ben', 'ba', 'senior');
    await q(`UPDATE agents SET is_devops=true WHERE name='Ben'`);
    expect(step(await get(), 'team').missing).toContain('business analyst');
  });

  it('completes itself once the BA has been talked to', async () => {
    await freshState();
    const runner = await w.connectRunner();
    for (const [n, r] of [
      ['Ben', 'ba'],
      ['Bea', 'builder'],
      ['Rex', 'reviewer'],
      ['Tia', 'tester'],
    ] as const)
      await w.hire(n, r, 'senior');
    await ok(
      w.t.req('POST', '/api/intakes', { cookie: w.owner.cookie, body: { note: 'I need a login page' } }),
      201,
    );
    const c = await get();
    expect(step(c, 'ba')).toMatchObject({ done: true, link: null });
    expect(c).toMatchObject({ doneCount: 5, complete: true });
    runner.close();
  });

  it('a Member sees the progress, with links only on the steps they may do', async () => {
    await freshState();
    const c = await get(member.cookie);
    expect(step(c, 'project')).toMatchObject({ done: true, actionable: false, link: null });
    expect(step(c, 'repository')).toMatchObject({ actionable: false, link: null });
    expect(step(c, 'team')).toMatchObject({ actionable: true, link: '/agents?hire=ba' });
    expect(step(c, 'ba')).toMatchObject({ actionable: true, link: '/desk' });
  });

  it('links Owners to the desk chat when the integrations (intake) feature is off', async () => {
    await freshState();
    expect(step(await get(), 'ba').link).toBe('/intake');
    await q(`UPDATE organizations SET features = features || '{"integrations": false}'::jsonb WHERE id=$1`, [
      orgId,
    ]);
    try {
      expect(step(await get(), 'ba')).toMatchObject({ actionable: true, link: '/desk' });
    } finally {
      await q(`UPDATE organizations SET features = features - 'integrations' WHERE id=$1`, [orgId]);
    }
  });

  it('hiding and reopening is kept per user and does not change the steps', async () => {
    await freshState();
    const put = (cookie: string, dismissed: boolean) =>
      ok<any>(
        w.t.req('PUT', '/api/setup-checklist', {
          cookie,
          body: { dismissed },
          headers: { 'x-aom-org': orgId },
        }),
      );
    expect((await put(w.owner.cookie, true)).dismissed).toBe(true);
    expect((await get()).dismissed).toBe(true);
    expect((await get(member.cookie)).dismissed).toBe(false);
    expect((await put(w.owner.cookie, false)).dismissed).toBe(false);
  });

  it('needs a signed-in organization member', async () => {
    const res = await w.t.req('GET', '/api/setup-checklist', {});
    expect(res.status).toBe(401);
  });
});

describe('business setup steps: each done check in isolation', () => {
  const owner = (method: string, url: string, body?: unknown, expected = 200) =>
    ok<any>(
      w.t.req(method, url, {
        cookie: w.owner.cookie,
        headers: { 'x-aom-org': orgId },
        ...(body !== undefined ? { body } : {}),
      }),
      expected,
    );
  const done = async (id: string) => step(await get(), id).done as boolean;

  beforeAll(async () => {
    await q(`UPDATE organizations SET mode='business' WHERE id=$1`, [orgId]);
  });
  afterAll(async () => {
    await q(`UPDATE organizations SET mode='dev' WHERE id=$1`, [orgId]);
  });

  it('Knowledge: an uploaded file or a user-written document counts; a chat-drafted or archived one does not', async () => {
    await freshState();
    expect(await done('knowledge')).toBe(false);
    const doc = (await owner('POST', '/api/documents', { kind: 'prd', title: 'Notes', projectId: w.projectId, content: 'x' }, 201))
      .document;
    // drafted by an agent from a chat
    await q(`UPDATE documents SET source_thread_ids = ARRAY[gen_random_uuid()] WHERE id=$1`, [doc.id]);
    expect(await done('knowledge')).toBe(false);
    // written by the user: no source thread
    await q(`UPDATE documents SET source_thread_ids = '{}' WHERE id=$1`, [doc.id]);
    expect(await done('knowledge')).toBe(true);
    // archived
    await q(`UPDATE documents SET status='archived' WHERE id=$1`, [doc.id]);
    expect(await done('knowledge')).toBe(false);
    // an uploaded file, even with a source thread, counts; an archived upload does not
    await q(`UPDATE documents SET kind='file', source_thread_ids = ARRAY[gen_random_uuid()], status='draft' WHERE id=$1`, [doc.id]);
    expect(await done('knowledge')).toBe(true);
    await q(`UPDATE documents SET status='archived' WHERE id=$1`, [doc.id]);
    expect(await done('knowledge')).toBe(false);
  });

  it('Knowledge: runner-reported notes on an org or project vault of an active workstation count; personal vaults and unlinked workstations do not', async () => {
    await freshState();
    await q(`UPDATE documents SET status='archived' WHERE org_id=$1`, [orgId]);
    await q(`DELETE FROM workstation_vaults WHERE workstation_id=$1`, [w.workstationId]);
    const vault = async (kind: string) => {
      const id = randomUUID();
      await q(
        `INSERT INTO vaults (id, org_id, project_id, kind, name, remote_url, created_at)
         VALUES ($1, $2, $3, $4, 'v', $5, now())`,
        [id, orgId, kind === 'project' ? w.projectId : null, kind, `git@example.test:${id}.git`],
      );
      return id;
    };
    const link = (vaultId: string, notes: number) =>
      q(`INSERT INTO workstation_vaults (workstation_id, vault_id, local_path, note_count) VALUES ($1,$2,'/v',$3)`, [
        w.workstationId,
        vaultId,
        notes,
      ]);
    const personal = await vault('personal');
    await link(personal, 5);
    expect(await done('knowledge')).toBe(false);
    const org = await vault('org');
    await link(org, 0);
    expect(await done('knowledge')).toBe(false);
    await q(`UPDATE workstation_vaults SET note_count=3 WHERE vault_id=$1`, [org]);
    expect(await done('knowledge')).toBe(true);
    await q(`UPDATE workstations SET status='unlinked' WHERE id=$1`, [w.workstationId]);
    try {
      expect(await done('knowledge')).toBe(false);
    } finally {
      await q(`UPDATE workstations SET status='active' WHERE id=$1`, [w.workstationId]);
    }
    await q(`UPDATE workstation_vaults SET note_count=0 WHERE vault_id=$1`, [org]);
    const project = await vault('project');
    await link(project, 2);
    expect(await done('knowledge')).toBe(true);
    await q(`DELETE FROM workstation_vaults WHERE workstation_id=$1`, [w.workstationId]);
  });

  it('Rules: a live standing order ticks it; a retired one or a decision does not', async () => {
    await freshState();
    await q(`UPDATE ledger_entries SET retired_at = now() WHERE org_id=$1 AND scope='standing_order' AND retired_at IS NULL`, [orgId]);
    expect(await done('rules')).toBe(false);
    await owner('POST', '/api/ledger', { scope: 'decision', title: 'Use pnpm', body: 'We use pnpm everywhere.' }, 201);
    expect(await done('rules')).toBe(false);
    const e = await owner('POST', '/api/ledger', { scope: 'standing_order', title: 'Greet clients', body: 'Always greet clients by name.' }, 201);
    expect(await done('rules')).toBe(true);
    expect(step(await get(), 'rules')).toMatchObject({ link: '/ledger' });
    await owner('POST', `/api/ledger/${e.entry.id}/retire`, { reason: 'obsolete' });
    expect(await done('rules')).toBe(false);
    const f = await owner('POST', '/api/ledger', { scope: 'standing_order', title: 'Sign off', body: 'Sign every mail.' }, 201);
    await q(`UPDATE ledger_entries SET superseded_by = $2 WHERE id=$1`, [f.entry.id, e.entry.id]);
    expect(await done('rules')).toBe(false);
  });

  it('Connections: an MCP grant, a webhook or e-mail automation or an output destination ticks it; paused automations and delivery recipes do not', async () => {
    await freshState();
    await q(`DELETE FROM schedules WHERE org_id=$1`, [orgId]);
    await q(`UPDATE projects SET mcp_servers='{}' WHERE org_id=$1`, [orgId]);
    expect(await done('connections')).toBe(false);
    expect(step(await get(), 'connections')).toMatchObject({ optional: true, link: '/automations' });

    // an MCP server granted to an active project
    await q(`UPDATE projects SET mcp_servers = ARRAY['plugin_files_local'] WHERE id=$1`, [w.projectId]);
    expect(await done('connections')).toBe(true);
    await q(`UPDATE projects SET status='archived' WHERE id=$1`, [w.projectId]);
    expect(await done('connections')).toBe(false);
    await q(`UPDATE projects SET status='active', mcp_servers='{}' WHERE id=$1`, [w.projectId]);
    expect(await done('connections')).toBe(false);

    // an automation that delivers its output to a destination
    const s = await owner(
      'POST',
      '/api/schedules',
      {
        name: 'Daily result',
        trigger: { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
        action: {
          kind: 'create_card',
          projectId: w.projectId,
          template: { title: 'Daily', fields: {} },
          deliverOutput: { destinations: [{ kind: 'webhook', url: 'https://example.com/h', format: 'generic' }] },
        },
      },
      201,
    );
    expect(await done('connections')).toBe(true);
    await q(`UPDATE schedules SET enabled=false WHERE id=$1`, [s.id]);
    expect(await done('connections')).toBe(false);

    // a webhook or e-mail integration automation
    await q(`UPDATE schedules SET enabled=true, action = jsonb_build_object('kind','integration','integration','email') WHERE id=$1`, [s.id]);
    expect(await done('connections')).toBe(true);
    await q(`UPDATE schedules SET action = jsonb_build_object('kind','integration','integration','jira') WHERE id=$1`, [s.id]);
    expect(await done('connections')).toBe(false);
    await q(`DELETE FROM schedules WHERE id=$1`, [s.id]);
  });
});
