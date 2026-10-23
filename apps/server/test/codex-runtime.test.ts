import { isKnownChoice } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveTurnModel } from '../src/chat/ceo-turns.ts';
import { defaultModelFor } from '../src/sessions/board-state.ts';
import { runtimeProblem } from '../src/sessions/offer.ts';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, type World } from './helpers/world.ts';

/**
 * The Codex CLI runtime on the server side: an agent may be hired on it when the workstation reports it available and the
 * role is one its sandbox can confine; the CEO, the DevOps engineer and the roles that need a browser, a path-limited write
 * area or no shell stay on Claude Code. The runtime id is a plain string everywhere else (no allow-list to extend).
 */
let w: World;
let r: FakeRunner;

const codex = (over: Record<string, unknown> = {}) => ({
  id: 'codex',
  version: '0.163.0',
  available: true,
  capabilities: ['shell', 'edit', 'web', 'skills', 'resume'],
  sandbox: 'enforced',
  sandboxReason: 'Codex permission profile (bubblewrap + seccomp)',
  auth: 'ok',
  ...over,
});
const runtimes = (c: Record<string, unknown> | null) => [
  { id: 'mock', version: '1', available: true, capabilities: ['shell', 'edit', 'web'] },
  { id: 'claude-code', version: '2', available: true, capabilities: ['shell', 'edit', 'web'] },
  ...(c ? [c] : []),
];
const report = async (c: Record<string, unknown> | null) => {
  r.send('runtimes.report', { runtimes: runtimes(c) });
  await r.barrier();
  await w.t.app.ctx.notifier.flush();
};
const hire = (roleKey: string, name: string, extra: Record<string, unknown> = {}) =>
  w.t.req('POST', '/api/agents', {
    cookie: w.owner.cookie,
    body: {
      name,
      roleKey,
      seniority: 'senior',
      workstationId: w.workstationId,
      runtime: 'codex',
      model: 'gpt-6-sol',
      ...extra,
    },
  });

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ hello: false });
  r.hello({ runtimes: runtimes(codex()) as never, capabilities: [] });
  await r.waitFor('welcome');
  await w.t.app.ctx.notifier.flush();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

describe('hiring on the Codex runtime', () => {
  it('accepts a builder and a reviewer when the workstation reports codex available', async () => {
    expect((await hire('builder', 'Cody')).status).toBe(201);
    expect((await hire('reviewer', 'Cora')).status).toBe(201);
  });

  it.each([
    ['analyst', 'no shell'],
    ['tester', 'browsers'],
    ['writer', 'certain paths'],
    ['researcher', 'no shell'],
  ])('refuses the %s role (%s)', async (roleKey) => {
    const res = await hire(roleKey, `Nope ${roleKey}`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('runtime_not_for_role');
  });

  it('refuses an agent whose workstation reports the Codex sandbox unavailable', async () => {
    await report(codex({ available: false, sandbox: 'unavailable', sandboxReason: 'bwrap not installed' }));
    const res = await hire('builder', 'Blocked');
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('sandbox_unavailable');
    expect(JSON.stringify(res.body)).toContain('bwrap not installed');
    await report(codex());
  });

  it('moves an existing agent to codex only when the role allows it', async () => {
    const mine = await w.t.req('POST', '/api/agents', {
      cookie: w.owner.cookie,
      body: {
        name: 'Mover',
        roleKey: 'analyst',
        seniority: 'senior',
        workstationId: w.workstationId,
        runtime: 'claude-code',
        model: 'sonnet',
      },
    });
    expect(mine.status).toBe(201);
    const id = (mine.body as { agentId?: string; id?: string }).agentId ?? (mine.body as { id?: string }).id;
    const res = await w.t.req('PATCH', `/api/agents/${id}`, {
      cookie: w.owner.cookie,
      body: { runtime: 'codex', model: 'gpt-6-sol' },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('runtime_not_for_role');
  });
});

describe('what the server knows about codex', () => {
  it('judges a codex choice from the workstation report', () => {
    const choice = { runtime: 'codex', model: 'gpt-6-sol' };
    expect(runtimeProblem([], choice)).toBeNull(); // nothing known: nothing refused
    expect(runtimeProblem(runtimes(null) as never, choice)).toMatch(/not installed/);
    expect(runtimeProblem(runtimes(codex()) as never, choice)).toBeNull();
    expect(runtimeProblem(runtimes(codex({ available: false, auth: 'expired' })) as never, choice)).toMatch(
      /codex login/,
    );
    expect(
      runtimeProblem(
        runtimes(codex({ available: false, sandboxReason: 'no user namespaces' })) as never,
        choice,
      ),
    ).toMatch(/no user namespaces/);
  });

  it('offers codex models, validates them, and picks a default by size on a codex-only workstation', () => {
    expect(isKnownChoice({ runtime: 'codex', model: 'gpt-6-sol', effort: 'high' })).toBe(false); // gpt-6-sol is not a listed id
    expect(isKnownChoice({ runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' })).toBe(true);
    expect(isKnownChoice({ runtime: 'codex', model: 'gpt-6-luna', effort: 'ultra' })).toBe(false);
    expect(defaultModelFor('persona', ['codex'])).toEqual({ runtime: 'codex', model: 'gpt-6-luna' });
    expect(defaultModelFor('synthesis', ['codex'])).toEqual({ runtime: 'codex', model: 'gpt-6-astra' });
  });

  it('never lets the CEO chat run on codex', () => {
    const agent = { id: 'a', runtime: 'claude-code', model: 'sonnet', effort: 'medium' };
    const chat = { model: 'sonnet', effort: 'medium' };
    expect(resolveTurnModel(agent, {}, chat, { runtime: 'codex', model: 'gpt-6.1-sol' })).toBeNull();
    expect(resolveTurnModel(agent, {}, chat, { runtime: 'claude-code', model: 'opus' })?.source).toBe(
      'message',
    );
  });
});
