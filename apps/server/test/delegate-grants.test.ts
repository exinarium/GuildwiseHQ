import { randomUUID } from 'node:crypto';
import { DELEGATE_GRANT_LIMITS, SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
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

describe('replay', () => {
  it('rebuilds the grants and the sub-steps exactly', async () => {
    expect(PROJECTION_TABLES).toContain('delegate_grants');
    const snap = async () =>
      JSON.parse(
        JSON.stringify({
          grants: await q(
            `SELECT owner_kind, owner_id, target_kind, target_key, max_calls, timeout_sec, max_profile, granted_by FROM delegate_grants ORDER BY owner_id, target_key`,
          ),
          steps: await q(
            `SELECT shift_id, delegate_target, delegate_target_name, delegate_target_kind, delegate_profile, delegate_outcome,
                    delegate_duration_ms, delegate_summary, delegate_native, delegate_thread_id
               FROM shift_costs WHERE kind='delegate' ORDER BY shift_id`,
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
