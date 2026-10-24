import { randomUUID } from 'node:crypto';
import { DELEGATE_GRANT_LIMITS, SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DELEGATION_EXPLICIT_MIGRATION,
  migrateDelegationExplicit,
} from '../src/data-migrations/delegation-explicit.ts';
import { DATA_MIGRATIONS } from '../src/data-migrations/index.ts';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * Explicit delegation (R3b, docs/ARCHITECTURE.md section 38.9): off by default; grants per agent and per session; who may
 * grant; the target runs on its own model; the per-target and per-caller counts; sub-steps on the card and the session; events,
 * projection and rebuild equality; isolation between members.
 */
const q = async (sql: string, params: unknown[] = []): Promise<any[]> => rawQ(sql, params) as Promise<any[]>;
let w: World;
let r: FakeRunner;
let orgId: string;
let admin: { id: string; cookie: string };
let member: { id: string; cookie: string };
let other: { id: string; cookie: string };
const seen = new Set<string>();
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY] });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
  admin = await w.t.userSession(uniqueEmail('admin'));
  member = await w.t.userSession(uniqueEmail('member'));
  other = await w.t.userSession(uniqueEmail('other'));
  await w.t.addOrgMember(orgId, admin.id, 'admin');
  await w.t.addOrgMember(orgId, member.id, 'member');
  await w.t.addOrgMember(orgId, other.id, 'member');
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const as = (u: { cookie: string }) => ({ cookie: u.cookie, headers: { 'x-aom-org': orgId } });
const call = (u: { cookie: string }, method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { ...as(u), ...(body !== undefined ? { body } : {}) });
const owner = (method: string, url: string, body?: unknown, expected = 200) =>
  ok<any>(
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }),
    expected,
  );
const nextStart = async (pred: (f: any) => boolean = () => true): Promise<any> => {
  const f = await r.waitFor('chat.start', (x) => !seen.has(x.chatId) && pred(x), 15_000);
  seen.add(f.chatId);
  return f;
};
const rpc = async (id: string, method: string, params: Record<string, unknown> = {}) => {
  const rpcId = randomUUID();
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId: id, method, params });
  return (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 15_000, from)) as {
    ok: boolean;
    result?: any;
    error?: string;
  };
};
const MOCK = { runtime: 'mock', model: 'mock' };
const begin = (callerId: string, over: Record<string, unknown> = {}) => {
  const delegateId = randomUUID();
  return rpc(callerId, 'delegate.begin', {
    delegateId,
    target: 'devils-advocate',
    model: { runtime: 'claude-code', model: 'haiku' },
    taskChars: 30,
    ...over,
  }).then((res) => ({ ...res, delegateId }));
};
const finish = async (start: any) => {
  r.send('chat.done', {
    chatId: start.chatId,
    threadId: start.threadId,
    messageText: 'ok',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  await until(
    async () =>
      (await q('SELECT status FROM session_turns WHERE id=$1', [start.chatId]))[0]?.status === 'done',
  );
};
/** The first facilitator turn starts before any grant can exist; a grant is seen by the turn that follows it. */
const grantedTurn = async (s: any, grant: Record<string, unknown> | null = {}, key = 'devils-advocate') => {
  const first = await nextStart((f) => f.threadId === s.threadId);
  await owner('PUT', `/api/sessions/${s.threadId}/delegate-grants`, persona(key, grant));
  await finish(first);
  await owner('POST', `/api/discovery/${s.threadId}/say`, { body: 'go on' }, 201);
  return nextStart((f) => f.threadId === s.threadId);
};
const newSession = async (over: Record<string, unknown> = {}) =>
  (await owner('POST', '/api/discovery', { title: 'Grants', idea: 'x', ...over }, 201)).state;
const persona = (key = 'devils-advocate', grant: Record<string, unknown> | null = {}) => ({
  targetKind: 'persona',
  targetKey: key,
  grant,
});
const agentGrants = (id: string, u: { cookie: string } = w.owner) =>
  call(u, 'GET', `/api/agents/${id}/delegate-grants`);

describe('delegation is off by default', () => {
  it('has no grant for an existing agent or session, and the runner is told no targets', async () => {
    const s = await newSession();
    const start = await nextStart((f) => f.threadId === s.threadId);
    expect(start.session.delegation).toBeUndefined();
    const res = await begin(start.chatId);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not_granted');
    await finish(start);
    const agent = await w.hire('Dee', 'builder', 'junior');
    const g = await agentGrants(agent.agent?.id ?? agent.id);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ ownerKind: 'agent', grants: [], canManage: true });
  });

  it('keeps `delegate` out of every purpose table and out of the tools of a turn without a grant', async () => {
    const { SESSION_PURPOSE_VERBS } = await import('@aom/shared');
    for (const verbs of Object.values(SESSION_PURPOSE_VERBS)) expect(verbs).not.toContain('delegate');
  });
});

describe('who may grant', () => {
  let agentId: string;
  it('lets an Owner, an Admin and the hiring manager grant an agent, and nobody else', async () => {
    const hired = await w.hire('Gus', 'builder', 'junior');
    agentId = hired.agent?.id ?? hired.id;
    const url = `/api/agents/${agentId}/delegate-grants`;
    // an agent the viewer does not manage is not theirs to change (the HR rule: 403, or 404 when they cannot even see it)
    expect([403, 404]).toContain((await call(member, 'PUT', url, persona())).status);
    expect([403, 404]).toContain((await call(other, 'PUT', url, persona())).status);
    expect((await call(admin, 'PUT', url, persona())).status).toBe(200);
    expect((await call(w.owner, 'PUT', url, persona('optimist'))).status).toBe(200);
    // a viewer sees the list but not the controls
    const seenByMember = await call(member, 'GET', url);
    expect(seenByMember.body.canManage).toBe(false);
    expect(seenByMember.body.grants.map((g: any) => g.targetKey).sort()).toEqual([
      'devils-advocate',
      'optimist',
    ]);
    // Admins and Owners see and change any agent
    // the hiring manager (a Member who hired an agent)
    await q('UPDATE agents SET manager_user_id=$2 WHERE id=$1', [agentId, member.id]);
    expect((await call(member, 'PUT', url, persona('devils-advocate', null))).status).toBe(200);
    expect((await call(member, 'GET', url)).body.canManage).toBe(true);
    await q('UPDATE agents SET manager_user_id=$2 WHERE id=$1', [agentId, w.owner.id]);
    // each change is an event: the audit trail
    const evs = await q(
      `SELECT payload FROM events WHERE type='DelegateGrantChanged' AND payload->>'ownerId'=$1 ORDER BY seq`,
      [agentId],
    );
    expect(evs.map((e) => [e.payload.targetKey, e.payload.granted, e.payload.changedBy])).toEqual([
      ['devils-advocate', true, admin.id],
      ['optimist', true, w.owner.id],
      ['devils-advocate', false, member.id],
    ]);
  });

  it('refuses a target that does not exist, an agent granting itself, a retired agent and too many grants', async () => {
    const url = `/api/agents/${agentId}/delegate-grants`;
    expect((await call(w.owner, 'PUT', url, persona('no-such-persona'))).status).toBe(400);
    expect(
      (await call(w.owner, 'PUT', url, { targetKind: 'agent', targetKey: agentId, grant: {} })).status,
    ).toBe(400);
    expect(
      (await call(w.owner, 'PUT', url, { targetKind: 'agent', targetKey: randomUUID(), grant: {} })).status,
    ).toBe(400);
    expect((await call(w.owner, 'PUT', url, persona('optimist', { maxCalls: 99 }))).status).toBe(400);
    expect(DELEGATE_GRANT_LIMITS.maxGrantsPerOwner).toBeGreaterThan(2);
    // a revoke of something never granted is a no-op
    expect((await call(w.owner, 'PUT', url, persona('security-reviewer', null))).status).toBe(200);
  });

  it('never lets the CEO or the DevOps engineer delegate', async () => {
    const devops = (await q(`SELECT id FROM agents WHERE is_devops AND org_id=$1 LIMIT 1`, [orgId]))[0];
    if (devops) {
      expect((await call(w.owner, 'PUT', `/api/agents/${devops.id}/delegate-grants`, persona())).status).toBe(
        400,
      );
    }
  });

  it('lets the creator of a session grant its facilitator and Chair, an Admin in it override, and others read only', async () => {
    const s = await newSession();
    const url = `/api/sessions/${s.threadId}/delegate-grants`;
    // not in the session: it does not exist for them
    expect((await call(member, 'GET', url)).status).toBe(404);
    expect((await call(member, 'PUT', url, persona())).status).toBe(404);
    await owner(
      'POST',
      `/api/sessions/${s.threadId}/participants`,
      { kind: 'user', refId: member.id, seat: 'Guest' },
      201,
    );
    expect((await call(member, 'GET', url)).body.canManage).toBe(false);
    expect((await call(member, 'PUT', url, persona())).status).toBe(403);
    expect((await call(w.owner, 'PUT', url, persona())).status).toBe(200);
    expect((await call(w.owner, 'GET', url)).body.grants).toHaveLength(1);
    const evs = await q(
      `SELECT payload FROM events WHERE type='DelegateGrantChanged' AND payload->>'threadId'=$1`,
      [s.threadId],
    );
    expect(evs).toHaveLength(1);
  });
});

describe('a session turn with a grant', () => {
  it('tells the runner the targets, then allows exactly those, within the count and until revoked', async () => {
    const s = await newSession();
    const url = `/api/sessions/${s.threadId}/delegate-grants`;
    const start = await grantedTurn(s, { maxCalls: 2, timeoutSec: 60, maxProfile: 'read_only' });
    expect(start.session.delegation.targets).toEqual([
      expect.objectContaining({
        kind: 'persona',
        handle: 'devils-advocate',
        maxCalls: 2,
        timeoutSec: 60,
        maxProfile: 'read_only',
      }),
    ]);
    const a = await begin(start.chatId, { profile: 'shell' });
    expect(a.ok).toBe(true);
    // the grant's ceiling narrows what the persona asks for
    expect(a.result.profile).toBe('read_only');
    expect(a.result.target).toMatchObject({ handle: 'devils-advocate', timeoutSec: 60, maxCalls: 2 });
    expect((await begin(start.chatId)).ok).toBe(true);
    const third = await begin(start.chatId);
    expect(third.ok).toBe(false);
    expect(third.error).toContain('at most 2 calls to "devils-advocate"');
    // another persona is not granted
    const other = await begin(start.chatId, { target: 'optimist' });
    expect(other.ok).toBe(false);
    expect(other.error).toContain('not_granted');
    expect(other.error).toContain('devils-advocate');
    // revoking takes effect at once, also for the turn that is running
    await owner('PUT', url, persona('devils-advocate', null));
    expect((await begin(start.chatId)).error).toContain('not_granted');
    await finish(start);
  });

  it('does not let a speaker or the minutes writer delegate even when the session has a grant', async () => {
    const s = await newSession();
    const start = await grantedTurn(s);
    await q(
      `UPDATE session_turns SET meta = jsonb_set(COALESCE(meta,'{}'), '{purpose}', '"board_speaker"') WHERE id=$1`,
      [start.chatId],
    );
    expect((await begin(start.chatId)).error).toContain('not available in this turn');
    await finish(start);
  });

  it('refuses a call without a target, as an older runner would make it', async () => {
    const s = await newSession();
    const start = await grantedTurn(s);
    const legacy = await rpc(start.chatId, 'delegate.begin', {
      delegateId: randomUUID(),
      persona: 'devils-advocate',
      model: { runtime: 'claude-code', model: 'haiku' },
      taskChars: 10,
    });
    expect(legacy.ok).toBe(false);
    expect(legacy.error).toContain('update the runner');
    await finish(start);
  });
});

describe('an agent as the target', () => {
  let callerShift: string;
  let callerId: string;
  let targetId: string;
  let cardId: string;
  it('runs on its own model, which the caller cannot change, with its own profile', async () => {
    // only one builder may take the card: the others are retired for this test
    await q(`UPDATE agents SET status='retired' WHERE org_id=$1 AND role_key='builder'`, [orgId]);
    const caller = await w.hire('Cora', 'builder', 'junior');
    callerId = caller.agent?.id ?? caller.id;
    const target = await w.hire('Rex', 'reviewer', 'senior');
    targetId = target.agent?.id ?? target.id;
    await q(
      `UPDATE agents SET model='haiku', runtime='claude-code',
              permissions = jsonb_set(permissions, '{allowedTools}', '["read"]') WHERE id=$1`,
      [targetId],
    );
    cardId = (await w.card({ title: 'Agent delegation' })).id;
    const from = r.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    const start = await r.waitFor('shift.start', (f: any) => f.agent.name === 'Cora', 8000, from);
    callerShift = start.shiftId;
    // no grant yet: the shift is told nothing
    expect(start.delegation).toBeUndefined();
    r.accepted(callerShift);
    r.started(callerShift, {
      path: '/work/x',
      branchName: 'x',
      baseBranch: 'main',
      created: true,
      headSha: 'abc',
    });
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [callerShift, 'running']))[0],
      3000,
    );
    await owner('PUT', `/api/agents/${callerId}/delegate-grants`, {
      targetKind: 'agent',
      targetKey: targetId,
      grant: { maxCalls: 2, timeoutSec: 90, maxProfile: null },
    });
    const g = (await agentGrants(callerId)).body.grants[0];
    expect(g).toMatchObject({
      targetKind: 'agent',
      targetName: 'Rex',
      handle: 'agent:rex',
      model: 'claude-code:haiku',
    });
    // the caller names a different model: refused (the target's model is fixed)
    const wrong = await begin(callerShift, {
      target: 'agent:rex',
      model: { runtime: 'claude-code', model: 'sonnet' },
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain('model_locked');
    const right = await begin(callerShift, {
      target: 'agent:rex',
      model: { runtime: 'claude-code', model: 'haiku' },
    });
    expect(right.ok).toBe(true);
    expect(right.result.target).toMatchObject({
      kind: 'agent',
      handle: 'agent:rex',
      key: targetId,
      runtime: 'claude-code',
      model: 'haiku',
    });
    // the reviewer role reads: its profile is read only, whatever the caller asks
    expect(right.result.profile).toBe('read_only');
    expect(right.result.target.profile).toBe('read_only');
    const done = await rpc(callerShift, 'delegate.cost', {
      delegateId: right.delegateId,
      target: 'agent:rex',
      outcome: 'ok',
      profile: 'read_only',
      narrowedFrom: 'shell',
      summary: 'Looks fine to me.',
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, model: 'claude-haiku-4-5' },
      durationMs: 4200,
    });
    expect(done.ok).toBe(true);
  });

  it('shows on the card as a sub-step with target, model, profile, duration, cost and summary', async () => {
    const detail = await owner('GET', `/api/cards/${cardId}`);
    expect(detail.delegations).toHaveLength(1);
    expect(detail.delegations[0]).toMatchObject({
      target: 'agent:rex',
      targetName: 'Rex',
      targetKind: 'agent',
      model: 'claude-haiku-4-5',
      profile: 'read_only',
      outcome: 'ok',
      durationMs: 4200,
      summary: 'Looks fine to me.',
      native: false,
      costUnknown: false,
      // Q63: it ran narrower than its own profile, and the step says which
      narrowedFrom: 'shell',
    });
    expect(detail.delegations[0].costUsd).toBeCloseTo(1.5, 5);
  });

  it('stops when the target is retired or the grant is revoked', async () => {
    await q(`UPDATE agents SET status='retired' WHERE id=$1`, [targetId]);
    const res = await begin(callerShift, {
      target: 'agent:rex',
      model: { runtime: 'claude-code', model: 'haiku' },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/retired|unavailable|handle|not_granted/);
    await q(`UPDATE agents SET status='active' WHERE id=$1`, [targetId]);
    await owner('PUT', `/api/agents/${callerId}/delegate-grants`, {
      targetKind: 'agent',
      targetKey: targetId,
      grant: null,
    });
    expect((await agentGrants(callerId)).body.grants).toEqual([]);
    expect((await begin(callerShift, { target: 'agent:rex' })).error).toContain('not_granted');
  });
});

describe('a chat of an agent as the caller', () => {
  it('delegates only to what its agent was granted, and books the cost on the chat', async () => {
    const hired = await w.hire('Chet', 'ba', 'senior');
    const agentId = hired.agent?.id ?? hired.id;
    const chatId = randomUUID();
    // the chat of an agent is a shift of kind chat, started by the relay (an event, so a rebuild keeps it)
    await seed(w, [
      {
        streamId: `shift-${chatId}`,
        event: {
          type: 'ShiftStarted',
          payload: {
            shiftId: chatId,
            agentId,
            workstationId: w.workstationId,
            kind: 'chat',
            runtime: 'mock',
            model: 'mock',
            overflow: false,
          },
        },
        actor: { kind: 'runner', id: w.workstationId },
        scope: { orgId, projectId: null, audience: 'org' },
      },
    ]);
    expect((await begin(chatId)).error).toContain('not_granted');
    await owner('PUT', `/api/agents/${agentId}/delegate-grants`, persona());
    const b = await begin(chatId);
    expect(b.ok).toBe(true);
    const done = await rpc(chatId, 'delegate.cost', {
      delegateId: b.delegateId,
      target: 'devils-advocate',
      outcome: 'ok',
      summary: 'a second opinion',
      usage: { inputTokens: 10, outputTokens: 10, model: 'claude-haiku-4-5' },
    });
    expect(done.ok).toBe(true);
    const row = (
      await q('SELECT parent_id, agent_id, delegate_summary FROM shift_costs WHERE shift_id=$1', [
        b.delegateId,
      ])
    )[0];
    expect(row).toMatchObject({ parent_id: chatId, agent_id: agentId, delegate_summary: 'a second opinion' });
    // the CEO and the DevOps engineer never delegate, grant or not
    await q(`UPDATE agents SET role_key='ceo' WHERE id=$1`, [agentId]);
    expect((await begin(chatId)).error).toContain('not available to this agent');
    expect(
      (await call(w.owner, 'PUT', `/api/agents/${agentId}/delegate-grants`, persona('optimist'))).status,
    ).toBe(400);
    await q(`UPDATE agents SET role_key='ba' WHERE id=$1`, [agentId]);
    await seed(w, [
      {
        streamId: `shift-${chatId}`,
        event: {
          type: 'ShiftEnded',
          payload: {
            shiftId: chatId,
            agentId,
            outcome: 'stopped',
            durationMs: 1,
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        },
        actor: { kind: 'runner', id: w.workstationId },
        scope: { orgId, projectId: null, audience: 'org' },
      },
    ]);
  });
});

describe('what the organization allows', () => {
  it('refuses a delegate on a model the workstation cannot run, and a paused project', async () => {
    const s = await newSession({ projectId: w.projectId });
    const start = await grantedTurn(s);
    const bad = await begin(start.chatId, { model: { runtime: 'direct-model', model: 'openai:gpt-5-mini' } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/runtime_unavailable|unknown model/);
    await q(`UPDATE projects SET paused_at = now() WHERE id=$1`, [w.projectId]);
    try {
      expect((await begin(start.chatId)).error).toContain('paused');
    } finally {
      await q(`UPDATE projects SET paused_at = NULL WHERE id=$1`, [w.projectId]);
    }
    await finish(start);
  });
});

describe('the session shows what was delegated', () => {
  it('lists the sub-steps in the session state and keeps the cost on the session meter', async () => {
    const s = await newSession();
    const start = await grantedTurn(s);
    const b = await begin(start.chatId);
    await rpc(start.chatId, 'delegate.cost', {
      delegateId: b.delegateId,
      target: 'devils-advocate',
      outcome: 'failed',
      summary: 'the delegate timed out',
      usage: { inputTokens: 10, outputTokens: 10, model: 'claude-haiku-4-5' },
    });
    await finish(start);
    const st = (await owner('GET', `/api/discovery/${s.threadId}`)).state;
    expect(st.delegations).toEqual([
      expect.objectContaining({
        target: 'devils-advocate',
        outcome: 'failed',
        summary: 'the delegate timed out',
      }),
    ]);
  });
});

describe('the data migration', () => {
  it('grants nothing, and gives delegations booked before their sub-step columns', async () => {
    expect(DATA_MIGRATIONS.map((m) => m.name)).toContain(DELEGATION_EXPLICIT_MIGRATION);
    const before = await q(
      `SELECT shift_id, delegate_target, delegate_outcome, delegate_thread_id FROM shift_costs WHERE kind='delegate' AND delegate_thread_id IS NOT NULL LIMIT 1`,
    );
    expect(before).toHaveLength(1);
    const grantsBefore = (
      await q('SELECT count(*)::int AS n FROM delegate_grants WHERE org_id=$1', [orgId])
    )[0].n;
    // as a row projected before the columns existed
    await q(
      `UPDATE shift_costs SET delegate_target=NULL, delegate_target_name=NULL, delegate_outcome=NULL, delegate_duration_ms=NULL, delegate_thread_id=NULL WHERE shift_id=$1`,
      [before[0].shift_id],
    );
    await q('DELETE FROM data_migrations WHERE name=$1', [DELEGATION_EXPLICIT_MIGRATION]);
    const env = { pool: w.t.app.ctx.pool, store: w.t.app.ctx.store, clock: w.t.app.ctx.clock, log: () => {} };
    expect(await migrateDelegationExplicit(env)).toMatchObject({ backfilled: expect.any(Number) });
    const after = (
      await q(
        `SELECT delegate_target, delegate_outcome, delegate_thread_id FROM shift_costs WHERE shift_id=$1`,
        [before[0].shift_id],
      )
    )[0];
    expect(after).toEqual({
      delegate_target: before[0].delegate_target,
      delegate_outcome: before[0].delegate_outcome,
      delegate_thread_id: before[0].delegate_thread_id,
    });
    // no grant was made, and a second run does nothing
    expect((await q('SELECT count(*)::int AS n FROM delegate_grants WHERE org_id=$1', [orgId]))[0].n).toBe(
      grantsBefore,
    );
    expect(await migrateDelegationExplicit(env)).toBeNull();
  });
});

describe('role-level grants cover every agent of the role (R3c, Q61)', () => {
  const roleUrl = (key: string) => `/api/roles/${key}/delegate-grants`;
  const chatShift = async (agentId: string): Promise<string> => {
    const chatId = randomUUID();
    await seed(w, [
      {
        streamId: `shift-${chatId}`,
        event: {
          type: 'ShiftStarted',
          payload: {
            shiftId: chatId,
            agentId,
            workstationId: w.workstationId,
            kind: 'chat',
            runtime: 'mock',
            model: 'mock',
            overflow: false,
          },
        },
        actor: { kind: 'runner', id: w.workstationId },
        scope: { orgId, projectId: null, audience: 'org' },
      },
    ]);
    return chatId;
  };
  let first = '';

  it('is for Owners and Admins; a member cannot read or change it; the CEO and DevOps roles and unknown roles are refused', async () => {
    expect((await call(member, 'GET', roleUrl('ba'))).status).toBe(403);
    expect((await call(member, 'PUT', roleUrl('ba'), persona())).status).toBe(403);
    expect((await call(admin, 'GET', roleUrl('ba'))).body).toMatchObject({
      ownerKind: 'role',
      roleKey: 'ba',
      grants: [],
      canManage: true,
    });
    expect((await call(w.owner, 'PUT', roleUrl('ceo'), persona())).status).toBe(400);
    expect((await call(w.owner, 'PUT', roleUrl('devops'), persona())).status).toBe(400);
    expect((await call(w.owner, 'PUT', roleUrl('no-such-role'), persona())).status).toBe(404);
    expect((await call(w.owner, 'PUT', roleUrl('ba'), persona('no-such-persona'))).status).toBe(400);
  });

  it('gives the grant to every agent of the role, the future hires included, and to no other role', async () => {
    first = (await w.hire('Rhea', 'ba', 'senior')).agent?.id ?? '';
    first ||= (await q(`SELECT id FROM agents WHERE name='Rhea'`))[0]?.id;
    const chat = await chatShift(first);
    expect((await begin(chat)).error).toContain('not_granted');
    const res = await call(admin, 'PUT', roleUrl('ba'), persona('devils-advocate', { maxCalls: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.grants).toHaveLength(1);
    // the agent that was hired before the grant has it, shown as inherited from the role
    const g = (await agentGrants(first)).body;
    expect(g.roleKey).toBe('ba');
    expect(g.grants[0]).toMatchObject({ targetKey: 'devils-advocate', inherited: true, maxCalls: 2 });
    expect((await begin(chat)).ok).toBe(true);
    // an agent hired later has it too, with no action on the agent
    const later =
      (await w.hire('Rosa', 'ba', 'senior')).agent?.id ??
      (await q(`SELECT id FROM agents WHERE name='Rosa'`))[0]?.id;
    expect((await agentGrants(later)).body.grants.map((x: any) => [x.targetKey, x.inherited])).toEqual([
      ['devils-advocate', true],
    ]);
    expect((await begin(await chatShift(later))).ok).toBe(true);
    // an agent of another role does not
    const other =
      (await w.hire('Reg', 'reviewer', 'senior')).agent?.id ??
      (await q(`SELECT id FROM agents WHERE name='Reg'`))[0]?.id;
    expect((await agentGrants(other)).body.grants).toEqual([]);
    expect((await begin(await chatShift(other))).error).toContain('not_granted');
  });

  it('lets a per-agent grant add targets but never take one of the role’s away', async () => {
    const url = `/api/agents/${first}/delegate-grants`;
    expect((await call(w.owner, 'PUT', url, persona('optimist'))).status).toBe(200);
    const list = (await agentGrants(first)).body.grants.map((x: any) => [x.targetKey, x.inherited]);
    expect(list).toEqual(
      expect.arrayContaining([
        ['devils-advocate', true],
        ['optimist', false],
      ]),
    );
    // removing the inherited one on the agent is refused, with the way out
    const del = await call(w.owner, 'PUT', url, persona('devils-advocate', null));
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('granted_by_role');
    // granting the same target on the agent too changes nothing: the role’s grant is the one in force
    expect((await call(w.owner, 'PUT', url, persona('devils-advocate', { maxCalls: 8 }))).status).toBe(200);
    expect(
      (await agentGrants(first)).body.grants.find((x: any) => x.targetKey === 'devils-advocate'),
    ).toMatchObject({ inherited: true, maxCalls: 2 });
    // the agent’s own ones can go (the same target as the role’s too: its own row, not the role’s)
    expect((await call(w.owner, 'PUT', url, persona('optimist', null))).status).toBe(200);
    expect((await call(w.owner, 'PUT', url, persona('devils-advocate', null))).status).toBe(200);
    expect((await agentGrants(first)).body.grants.map((x: any) => x.targetKey)).toEqual(['devils-advocate']);
  });

  it('records each change as an event of the organization with the role, and a revoke on the role takes it from every agent', async () => {
    const evs = await q(
      `SELECT payload FROM events WHERE type='DelegateGrantChanged' AND payload->>'ownerKind'='role' ORDER BY seq`,
    );
    expect(
      evs.map((e) => [e.payload.roleKey, e.payload.targetKey, e.payload.granted, e.payload.changedBy]),
    ).toEqual([['ba', 'devils-advocate', true, admin.id]]);
    expect((await call(w.owner, 'PUT', roleUrl('ba'), persona('devils-advocate', null))).status).toBe(200);
    expect((await agentGrants(first)).body.grants).toEqual([]);
    expect((await begin(await chatShift(first))).error).toContain('not_granted');
    // a role cannot delegate to its own agents
    const mine = await call(w.owner, 'PUT', roleUrl('ba'), {
      targetKind: 'agent',
      targetKey: first,
      grant: {},
    });
    expect(mine.status).toBe(400);
    // granted again for the replay test below
    expect((await call(w.owner, 'PUT', roleUrl('ba'), persona('optimist'))).status).toBe(200);
  });

  it('tells the runner the role’s targets when the agent’s chat starts', async () => {
    const { delegationSpecFor } = await import('../src/sessions/delegate-grants.ts');
    const spec = await delegationSpecFor(w.t.app.ctx.pool, 'agent', first);
    expect(spec?.targets.map((t) => t.handle)).toEqual(['optimist']);
  });
});

describe('a grant may set the model the target runs on (R3c, Q62)', () => {
  const MODEL = { runtime: 'claude-code', model: 'haiku' };
  it('is shown, told to the runner, and the only model the target runs on for that caller; the caller still cannot choose', async () => {
    const s = await newSession();
    const first = await nextStart((f) => f.threadId === s.threadId);
    const res = await call(
      w.owner,
      'PUT',
      `/api/sessions/${s.threadId}/delegate-grants`,
      persona('devils-advocate', { model: MODEL }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.grants[0].modelOverride).toBe('claude-code:haiku');
    await finish(first);
    await owner('POST', `/api/discovery/${s.threadId}/say`, { body: 'go on' }, 201);
    const start = await nextStart((f) => f.threadId === s.threadId);
    expect(start.session.delegation.targets[0].modelOverride).toEqual(MODEL);
    const wrong = await begin(start.chatId, { model: { runtime: 'claude-code', model: 'sonnet' } });
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain('model_locked');
    expect(wrong.error).toContain('claude-code:haiku');
    const right = await begin(start.chatId, { model: MODEL });
    expect(right.ok, right.error).toBe(true);
    expect(right.result.target).toMatchObject({ modelOverride: MODEL });
    // another grant of the same target on another owner keeps the target’s own model
    await finish(start);
  });

  it('is checked when it is made: an unknown model, a runtime that cannot take the target, a runtime the workstation does not offer', async () => {
    const s = await newSession();
    const url = `/api/sessions/${s.threadId}/delegate-grants`;
    const bad = await call(
      w.owner,
      'PUT',
      url,
      persona('devils-advocate', { model: { runtime: 'claude-code', model: 'no-such-model-9' } }),
    );
    expect([400, 409]).toContain(bad.status);
    // a read-only target on Codex: Codex always has a shell, and a role without one stays on Claude Code
    const codex = await call(
      w.owner,
      'PUT',
      url,
      persona('devils-advocate', { model: { runtime: 'codex', model: 'gpt-6.1-sol' } }),
    );
    expect(codex.status).toBe(400);
    expect(codex.body.error.code).toBe('model_not_for_target');
    const unknownRuntime = await call(
      w.owner,
      'PUT',
      url,
      persona('devils-advocate', { model: { runtime: 'nope', model: 'x' } }),
    );
    expect(unknownRuntime.status).toBe(400);
    // nothing was granted
    expect((await call(w.owner, 'GET', url)).body.grants).toEqual([]);
    const start = await nextStart((f) => f.threadId === s.threadId);
    await finish(start);
  });

  it('works on a role grant and on an agent as the target', async () => {
    const hired =
      (await w.hire('Mona', 'reviewer', 'senior')).agent?.id ??
      (await q(`SELECT id FROM agents WHERE name='Mona'`))[0]?.id;
    await q(`UPDATE agents SET model='sonnet', runtime='claude-code' WHERE id=$1`, [hired]);
    const caller =
      (await w.hire('Cal', 'planner', 'senior')).agent?.id ??
      (await q(`SELECT id FROM agents WHERE name='Cal'`))[0]?.id;
    const res = await call(w.owner, 'PUT', roleUrl2('planner'), {
      targetKind: 'agent',
      targetKey: hired,
      grant: { model: MODEL },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.grants[0]).toMatchObject({
      targetKind: 'agent',
      model: 'claude-code:sonnet',
      modelOverride: 'claude-code:haiku',
    });
    const { delegationSpecFor } = await import('../src/sessions/delegate-grants.ts');
    const spec = await delegationSpecFor(w.t.app.ctx.pool, 'agent', caller);
    expect(spec?.targets[0]).toMatchObject({ kind: 'agent', model: 'sonnet', modelOverride: MODEL });
    // the agent runs on the grant’s model for that caller: the server holds the caller to it
    const chat = randomUUID();
    await seed(w, [
      {
        streamId: `shift-${chat}`,
        event: {
          type: 'ShiftStarted',
          payload: {
            shiftId: chat,
            agentId: caller,
            workstationId: w.workstationId,
            kind: 'chat',
            runtime: 'mock',
            model: 'mock',
            overflow: false,
          },
        },
        actor: { kind: 'runner', id: w.workstationId },
        scope: { orgId, projectId: null, audience: 'org' },
      },
    ]);
    const handle = (await agentGrants(caller)).body.grants[0].handle;
    expect(
      (await begin(chat, { target: handle, model: { runtime: 'claude-code', model: 'sonnet' } })).error,
    ).toContain('model_locked');
    expect((await begin(chat, { target: handle, model: MODEL })).ok).toBe(true);
  });
});
const roleUrl2 = (key: string) => `/api/roles/${key}/delegate-grants`;

describe('replay', () => {
  it('rebuilds the grants and the sub-steps exactly', async () => {
    expect(PROJECTION_TABLES).toContain('delegate_grants');
    const snap = async () =>
      JSON.parse(
        JSON.stringify({
          grants: await q(
            `SELECT owner_kind, owner_id, owner_key, target_kind, target_key, max_calls, timeout_sec, max_profile, granted_by, model_runtime, model_name FROM delegate_grants WHERE org_id=$1 ORDER BY owner_id, target_key`,
            [orgId],
          ),
          steps: await q(
            `SELECT shift_id, delegate_target, delegate_target_name, delegate_target_kind, delegate_profile, delegate_outcome,
                    delegate_duration_ms, delegate_summary, delegate_native, delegate_thread_id
               FROM shift_costs WHERE kind='delegate' AND org_id=$1 ORDER BY shift_id`,
            [orgId],
          ),
        }),
      );
    const before = await snap();
    expect(before.grants.length).toBeGreaterThan(0);
    expect(before.steps.length).toBeGreaterThan(0);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect(await snap()).toEqual(before);
  });
});

describe('isolation', () => {
  it('does not show one organization the grants of another', async () => {
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    const agent = (await q(`SELECT id FROM agents WHERE org_id=$1 LIMIT 1`, [orgId]))[0];
    const res = await w.t.req('GET', `/api/agents/${agent.id}/delegate-grants`, { cookie: stranger.cookie });
    expect([403, 404]).toContain(res.status);
  });
});
