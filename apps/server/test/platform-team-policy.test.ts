import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { platformPass, platformScan } from '../src/platform-team/detectors.ts';
import { triageBug } from '../src/platform-team/intake.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, fullFields, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let root: { id: string; cookie: string; email: string };
let releaseDir: string;
let ctx: World['t']['app']['ctx'];
let orgId: string;
let platformProjectId: string;

beforeAll(async () => {
  releaseDir = mkdtempSync(join(tmpdir(), 'aom-release-'));
  for (const v of ['0.1.20', '0.1.24']) writeFileSync(join(releaseDir, `aom-runner-${v}.tgz`), `fake ${v}`);
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_RUNNER_RELEASE_DIR: releaseDir } });
  ctx = w.t.app.ctx;
  r = await w.connectRunner({ capabilities: ['runner-pin:1'] });
  root = await w.t.superAdminSession();
  orgId = w.owner.id;
  const p = await ok<any>(
    w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key: 'PLT', name: 'Platform' } }),
    201,
  );
  platformProjectId = p.project.id;
  await ok(
    w.t.req('POST', `/api/projects/${platformProjectId}/repos`, {
      cookie: w.owner.cookie,
      body: { name: 'toy', remoteUrl: 'https://github.com/acme/toy.git' },
    }),
    201,
  );
});
afterAll(async () => {
  r.close();
  await w.t.close();
  rmSync(releaseDir, { recursive: true, force: true });
  await closeAdminPool();
});
beforeEach(async () => {
  await freshState();
  await q(
    `TRUNCATE platform_pauses, platform_bugs, platform_bug_hits, platform_deploy_audit, platform_deploy_approvals,
       platform_diag_grants, platform_diag_access, workstation_runner_pins, runner_errors, runner_error_workstations,
       workstation_role_blocks RESTART IDENTITY CASCADE`,
  );
  await q(`DELETE FROM platform_settings WHERE key IN ('platform.team','runners.version_pin')`);
  await ok(
    w.t.req('PUT', '/api/platform/team', {
      cookie: root.cookie,
      body: { orgId, projectId: platformProjectId },
    }),
  );
});

const api = (method: string, url: string, body?: unknown, cookie = w.owner.cookie) =>
  w.t.req(method, url, { cookie, body });
const deskItems = (subkind: string, org = orgId) =>
  q(`SELECT * FROM desk_items WHERE org_id=$1 AND subkind=$2 ORDER BY created_at`, [org, subkind]);

const FIX = {
  version: '0.1.25',
  fromVersion: '0.1.24',
  changedFiles: ['apps/server/src/dispatcher/dispatcher.ts'],
  reviewApproved: true,
  testsPassed: true,
  uatPassed: true,
  rollbackPath: 'redeploy 0.1.24',
};

describe('deploy policy and audit trail', () => {
  it('a low-risk fix that passed review, tests and UAT is allowed without anyone approving it', async () => {
    const d = await ok<any>(api('POST', '/api/platform-team/deploy/check', FIX));
    expect(d).toMatchObject({ allowed: true, risk: 'low', missing: [] });
    expect(await deskItems('platform_deploy_approval')).toHaveLength(0);
  });

  it('needs review, tests and UAT first', async () => {
    const d = await ok<any>(
      api('POST', '/api/platform-team/deploy/check', { ...FIX, reviewApproved: false, uatPassed: false }),
    );
    expect(d.allowed).toBe(false);
    expect(d.missing).toEqual(['review', 'uat']);
  });

  it('a fix that only unpauses current workflows goes live without consent, and the platform org is informed', async () => {
    const bug = await ok<any>(
      api('POST', '/api/platform-team/pauses', { projectId: w.projectId, reason: 'the board is broken' }),
    );
    expect(bug.created).toBe(true);
    const card = await w.card({ title: 'The fix', projectId: platformProjectId });
    await q(`UPDATE platform_pauses SET bug_card_id=$1`, [card.id]);
    const body = { ...FIX, bugCardId: card.id };
    const d = await ok<any>(api('POST', '/api/platform-team/deploy/check', body));
    expect(d).toMatchObject({ allowed: true, fixesPausingBug: true, risk: 'low' });
    const rec = await ok<any>(api('POST', '/api/platform-team/deploy/record', body));
    expect(rec.recorded).toBe(true);
    const report = await deskItems('platform_deploy_report');
    expect(report).toHaveLength(1);
    expect(report[0]?.body).toContain('without approval');
    expect(report[0]?.body).toContain('redeploy 0.1.24');
    const audit = await q(
      `SELECT kind, allowed, fixes_pausing, rollback_path FROM platform_deploy_audit ORDER BY id`,
    );
    expect(audit.map((a) => a.kind)).toEqual(['check', 'deploy']);
    expect(audit[1]).toMatchObject({ fixes_pausing: true, rollback_path: 'redeploy 0.1.24' });
  });

  it('high risk is decided from the diff on the server and needs the platform organisation approval on its desk', async () => {
    const body = { ...FIX, changedFiles: ['apps/server/src/auth/sessions.ts', 'apps/web/src/x.tsx'] };
    const d1 = await ok<any>(api('POST', '/api/platform-team/deploy/check', body));
    expect(d1).toMatchObject({ allowed: false, risk: 'high', riskCategories: ['auth_permissions_secrets'] });
    expect(d1.missing).toEqual(['high_risk_approval']);
    // asking again does not raise a second item
    await ok(api('POST', '/api/platform-team/deploy/check', body));
    const items = await deskItems('platform_deploy_approval');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'approval', status: 'open' });
    // the script cannot record a deploy that is not allowed
    const refused = await api('POST', '/api/platform-team/deploy/record', body);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('deploy_not_allowed');
    // the super admin is not the approver: they have no desk and no part in it
    expect(
      (await api('POST', `/api/desk/${items[0]?.id}/resolve`, { resolution: 'approved' }, root.cookie))
        .status,
    ).toBeGreaterThanOrEqual(400);
    await ok(api('POST', `/api/desk/${items[0]?.id}/resolve`, { resolution: 'approved' }));
    const d2 = await ok<any>(api('POST', '/api/platform-team/deploy/check', body));
    expect(d2).toMatchObject({ allowed: true, risk: 'high' });
    await ok(api('POST', '/api/platform-team/deploy/record', body));
    const audit = await q(
      `SELECT kind, approved_by FROM platform_deploy_audit WHERE kind IN ('approval','deploy') ORDER BY id`,
    );
    // the refused attempt, the approval, the deploy
    expect(audit.map((a) => a.kind)).toEqual(['deploy', 'approval', 'deploy']);
    expect(audit[2]?.approved_by).toBeTruthy();
  });

  it('a rejected approval holds the deploy; downtime needs its own explicit go-ahead', async () => {
    const body = { ...FIX, version: '0.1.26', downtime: true };
    const d1 = await ok<any>(api('POST', '/api/platform-team/deploy/check', body));
    expect(d1.missing).toEqual(['downtime_approval']);
    const item = (await deskItems('platform_downtime_approval'))[0]!;
    await ok(
      api('POST', `/api/desk/${item.id}/resolve`, {
        resolution: 'rejected',
        note: 'not during working hours',
      }),
    );
    const d2 = await ok<any>(api('POST', '/api/platform-team/deploy/check', body));
    expect(d2.allowed).toBe(false);
    expect(d2.reason).toContain('declined');
    // a rollback is recorded as it happened even when the policy would not allow a new deploy
    const rb = await ok<any>(
      api('POST', '/api/platform-team/deploy/record', { ...body, outcome: 'rolled_back' }),
    );
    expect(rb.recorded).toBe(true);
    expect((await q(`SELECT kind FROM platform_deploy_audit WHERE kind='rollback'`)).length).toBe(1);
  });

  it('is for the platform organisation and the super admin only', async () => {
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    expect((await api('POST', '/api/platform-team/deploy/check', FIX, stranger.cookie)).status).toBe(404);
    expect((await api('GET', '/api/platform-team/overview', undefined, stranger.cookie)).status).toBe(404);
    expect((await api('GET', '/api/platform-team/overview', undefined, root.cookie)).status).toBe(200);
  });
});

describe('triage and fix stop-loss', () => {
  async function bug() {
    await q(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('x','1',now()) ON CONFLICT DO NOTHING`,
    );
    const { reportBug } = await import('../src/platform-team/intake.ts');
    const out = await reportBug(ctx, {
      source: 'server_5xx',
      signature: `5xx:GET /t${Math.random()}:Error:1`,
      title: 'GET /t fails',
      description: 'x',
      diagnostics: {},
      scope: { projectId: w.projectId },
    });
    return out.cardId as string;
  }

  it('invalid closes the card with the reason and ends its pauses; valid sets severity and size', async () => {
    const id = await bug();
    const res = await triageBug(ctx, { userId: w.owner.id, label: 'the architect' }, id, {
      verdict: 'valid',
      severity: 'critical',
      size: 'small',
    });
    expect(res.severity).toBe('critical');
    expect((await q('SELECT fix_size, severity_by FROM platform_bugs'))[0]).toMatchObject({
      fix_size: 'small',
      severity_by: 'architect',
    });
    // the architect's judgement: critical with a scope pauses it
    expect(await q('SELECT 1 FROM platform_pauses WHERE resumed_at IS NULL')).toHaveLength(1);
    await triageBug(ctx, { userId: w.owner.id, label: 'the architect' }, id, {
      verdict: 'invalid',
      reason: 'a project problem',
    });
    expect((await q('SELECT status FROM platform_bugs'))[0]?.status).toBe('invalid');
    expect((await q('SELECT status FROM cards WHERE id=$1', [id]))[0]?.status).toBe('cancelled');
    expect(await q('SELECT 1 FROM platform_pauses WHERE resumed_at IS NULL')).toHaveLength(0);
  });

  it('degraded ends the automatic pause (work keeps running)', async () => {
    const id = await bug();
    await triageBug(ctx, { userId: w.owner.id, label: 'a' }, id, { verdict: 'valid', severity: 'critical' });
    await triageBug(ctx, { userId: w.owner.id, label: 'a' }, id, { verdict: 'valid', severity: 'degraded' });
    expect(await q('SELECT 1 FROM platform_pauses WHERE resumed_at IS NULL')).toHaveLength(0);
  });

  it('the architect triages through the aom rpc, only an architect, only on a platform bug card', async () => {
    const id = await bug();
    const arch = await w.hire('Arch', 'architect', 'senior');
    const bea = await w.hire('Bea', 'builder', 'junior');
    const mkShift = async (agentId: string, cardId: string) => {
      const sid = (await q(`SELECT gen_random_uuid() AS id`))[0]!.id as string;
      await q(
        `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, stage, status, runtime, model, started_at)
         VALUES ($1,$2,$3,$4,$5,'card','investigate','running','mock','mock',now())`,
        [sid, orgId, agentId, w.workstationId, cardId],
      );
      return sid;
    };
    const rpc = async (shiftId: string, params: Record<string, unknown>) => {
      const rpcId = crypto.randomUUID();
      const from = r.received.length;
      r.send('rpc.request', { rpcId, shiftId, method: 'platform.triage', params });
      return r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 5000, from);
    };
    const archShift = await mkShift(arch.id ?? arch.agent?.id, id);
    const beaShift = await mkShift(bea.id ?? bea.agent?.id, id);
    expect((await rpc(beaShift, { severity: 'critical' })).ok).toBe(false);
    expect((await rpc(archShift, {})).ok).toBe(false); // no severity, not invalid
    const good = await rpc(archShift, {
      severity: 'degraded',
      size: 'large',
      reason: 'works with a workaround',
    });
    expect(good.ok).toBe(true);
    expect((await q('SELECT severity, fix_size FROM platform_bugs'))[0]).toMatchObject({
      severity: 'degraded',
      fix_size: 'large',
    });
  });
});

describe('sanitised client diagnostics and grants', () => {
  let client: { id: string; cookie: string; email: string };
  let clientProject: string;
  beforeEach(async () => {
    client = await w.t.userSession(uniqueEmail('client'));
    const p = await ok<any>(
      w.t.req('POST', '/api/projects', { cookie: client.cookie, body: { key: 'CLI', name: 'Client' } }),
      201,
    );
    clientProject = p.project.id;
  });

  async function clientBug() {
    const c = await ok<any>(
      w.t.req('POST', '/api/cards', {
        cookie: client.cookie,
        body: {
          projectId: clientProject,
          title: 'Secret client roadmap',
          cardType: 'feature',
          fields: fullFields({ context: 'confidential: acme merger' }),
          completionAction: 'merge',
          specify: true,
        },
      }),
      201,
    );
    await q(
      `UPDATE cards SET retry_failures=3, retry_episode_id=gen_random_uuid(), retry_after=now() + interval '10 minutes' WHERE id=$1`,
      [c.card.id],
    );
    await platformScan(ctx);
    return (await q('SELECT * FROM platform_bugs'))[0]!;
  }

  it('the bug card of a client carries signature, counts and versions only: no card content', async () => {
    const bug = await clientBug();
    expect(bug.client_org_id).toBe(client.id);
    const pcard = (await q('SELECT * FROM cards WHERE id=$1', [bug.card_id]))[0]!;
    const text = JSON.stringify(pcard.fields) + JSON.stringify(bug.diagnostics) + pcard.title;
    expect(text).not.toMatch(/Secret client roadmap|acme merger|CLI-1/);
    expect(JSON.stringify(pcard.fields)).toContain('Sanitised diagnostics');
    // the overview shows the sanitised part only
    const ov = await ok<any>(api('GET', '/api/platform-team/overview'));
    expect(JSON.stringify(ov)).not.toMatch(/CLI-1|Secret client roadmap/);
  });

  it('a grant is requested by the platform org, approved on the client desk, time-boxed, audited and revocable', async () => {
    const bug = await clientBug();
    // reading without a grant is refused
    expect(
      (await api('GET', `/api/platform-team/bugs/${encodeURIComponent(bug.signature)}/extended`)).status,
    ).toBe(403);
    const g = await ok<any>(
      api('POST', '/api/platform-team/grants', {
        signature: bug.signature,
        reason: 'need the stage',
        hours: 2,
      }),
    );
    expect(g).toMatchObject({ status: 'requested', hours: 2, clientOrgId: client.id });
    expect(
      (await api('POST', '/api/platform-team/grants', { signature: bug.signature, reason: 'again please' }))
        .status,
    ).toBe(409);
    // it sits on the CLIENT organisation's desk
    const items = await deskItems('platform_grant_request', client.id);
    expect(items).toHaveLength(1);
    // the platform org cannot approve its own request
    expect(
      (await api('POST', `/api/desk/${items[0]?.id}/resolve`, { resolution: 'approved' })).status,
    ).toBeGreaterThanOrEqual(400);
    await ok(api('POST', `/api/desk/${items[0]?.id}/resolve`, { resolution: 'approved' }, client.cookie));
    const active = (await q('SELECT * FROM platform_diag_grants'))[0]!;
    expect(active.status).toBe('approved');
    expect(new Date(active.expires_at).getTime() - new Date(active.decided_at).getTime()).toBe(2 * 3_600_000);
    const read = await ok<any>(
      api('GET', `/api/platform-team/bugs/${encodeURIComponent(bug.signature)}/extended`),
    );
    expect(read.extended).toMatchObject({ cardRef: 'CLI-1' });
    expect(await q('SELECT 1 FROM platform_diag_access')).toHaveLength(1);
    const log = await ok<any>(
      api('GET', `/api/platform-team/grants/${g.id}/access-log`, undefined, client.cookie),
    );
    expect(log.entries).toHaveLength(1);
    // the platform team is told on its desk
    expect((await deskItems('platform_grant_request')).length).toBeGreaterThan(0);
    // only the client org can revoke
    expect((await api('POST', `/api/platform-team/grants/${g.id}/revoke`)).status).toBe(403);
    await ok(api('POST', `/api/platform-team/grants/${g.id}/revoke`, undefined, client.cookie));
    expect(
      (await api('GET', `/api/platform-team/bugs/${encodeURIComponent(bug.signature)}/extended`)).status,
    ).toBe(403);
  });

  it('expires by itself', async () => {
    const bug = await clientBug();
    const g = await ok<any>(
      api('POST', '/api/platform-team/grants', { signature: bug.signature, reason: 'short look', hours: 1 }),
    );
    const item = (await deskItems('platform_grant_request', client.id))[0]!;
    await ok(api('POST', `/api/desk/${item.id}/resolve`, { resolution: 'approved' }, client.cookie));
    expect(
      (await api('GET', `/api/platform-team/bugs/${encodeURIComponent(bug.signature)}/extended`)).status,
    ).toBe(200);
    w.t.clock.advance(61 * 60_000);
    try {
      // refused at once (time is up), and the pass marks it expired
      expect(
        (await api('GET', `/api/platform-team/bugs/${encodeURIComponent(bug.signature)}/extended`)).status,
      ).toBe(403);
      await platformPass(ctx, { force: true });
      expect((await q('SELECT status FROM platform_diag_grants WHERE id=$1', [g.id]))[0]?.status).toBe(
        'expired',
      );
    } finally {
      w.t.clock.setOffset(0);
    }
  });

  it('a declined request gives nothing', async () => {
    const bug = await clientBug();
    await ok(api('POST', '/api/platform-team/grants', { signature: bug.signature, reason: 'please' }));
    const item = (await deskItems('platform_grant_request', client.id))[0]!;
    await ok(api('POST', `/api/desk/${item.id}/resolve`, { resolution: 'rejected' }, client.cookie));
    expect((await q('SELECT status FROM platform_diag_grants'))[0]?.status).toBe('denied');
    expect(
      (await api('GET', `/api/platform-team/bugs/${encodeURIComponent(bug.signature)}/extended`)).status,
    ).toBe(403);
  });
});

describe('safe mode: runner version pin', () => {
  it('pins one workstation: delivered to the runner as a command now and in welcome on the next connect', async () => {
    const from = r.received.length;
    const res = await ok<any>(
      api('PUT', '/api/platform-team/runner-pin', {
        workstationId: w.workstationId,
        version: '0.1.20',
        reason: 'roll back to the last good version',
      }),
    );
    expect(res.notified).toBe(1);
    const cmd = await r.waitFor('command', (f) => f.command === 'runner.pin', 5000, from);
    expect(cmd.payload).toEqual({ version: '0.1.20' });
    // the workstation page shows it, and the runner can fetch exactly that release
    const rel = await ok<any>(w.t.req('GET', '/api/runner/release?version=0.1.20'));
    expect(rel.version).toBe('0.1.20');
    expect((await w.t.req('GET', '/api/runner/release?version=9.9.9')).status).toBe(404);
    // unpin
    const from2 = r.received.length;
    await ok(api('PUT', '/api/platform-team/runner-pin', { workstationId: w.workstationId, version: null }));
    const cmd2 = await r.waitFor('command', (f) => f.command === 'runner.pin', 5000, from2);
    expect(cmd2.payload).toEqual({ version: null });
    // pinned again: a runner that connects again is told in welcome (the old connection is replaced)
    await ok(
      api('PUT', '/api/platform-team/runner-pin', { workstationId: w.workstationId, version: '0.1.20' }),
    );
    const r2 = await w.connectRunner({ capabilities: ['runner-pin:1'] });
    try {
      const welcome = r2.of('welcome').at(-1);
      expect(welcome?.runnerPin).toEqual({ version: '0.1.20' });
    } finally {
      r2.close();
    }
  });

  it('pins all workstations, refuses an unknown release, and the super admin may pin too', async () => {
    expect(
      (await api('PUT', '/api/platform-team/runner-pin', { workstationId: null, version: '0.0.1' })).status,
    ).toBe(400);
    const res = await ok<any>(
      w.t.req('PUT', '/api/platform-team/runner-pin', {
        cookie: root.cookie,
        body: { workstationId: null, version: '0.1.24', reason: 'freeze' },
      }),
    );
    expect(res.notified).toBeGreaterThanOrEqual(1);
    const pins = await ok<any>(api('GET', '/api/platform-team/runner-pins'));
    expect(pins.pins).toHaveLength(1);
    expect(pins.pins[0]).toMatchObject({ workstationId: null, version: '0.1.24' });
    // a workstation's own pin wins over the all-pin
    await ok(
      api('PUT', '/api/platform-team/runner-pin', { workstationId: w.workstationId, version: '0.1.20' }),
    );
    const r3 = await w.connectRunner({ capabilities: ['runner-pin:1'] });
    try {
      expect(r3.of('welcome').at(-1)?.runnerPin).toEqual({ version: '0.1.20' });
    } finally {
      r3.close();
    }
    // the platform desk is told
    expect((await deskItems('platform_runner_pin')).length).toBeGreaterThan(0);
  });
});

void until;
