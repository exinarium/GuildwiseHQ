import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, MOCK_RUNTIME, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld();
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const runtime = (sandbox?: string, sandboxReason?: string) => [
  { ...MOCK_RUNTIME[0], ...(sandbox ? { sandbox, sandboxReason } : {}) },
];
const hello = (runtimes: unknown) =>
  r.send('hello', {
    runnerVersion: '0.0.0-test',
    protocol: 1,
    platform: 'win32',
    hostname: 'fake-host',
    runtimes,
    repos: [],
    vaults: [],
    activeShifts: [],
    outboxPending: 0,
  });
const workstation = async () =>
  (await w.t.req('GET', '/api/workstations', { cookie: w.owner.cookie })).body.workstations[0];
const agentOf = async (name: string) =>
  (await w.t.req('GET', '/api/agents', { cookie: w.owner.cookie })).body.agents.find(
    (a: any) => a.name === name,
  );

describe('sandbox state', () => {
  it('round-trips from hello to the workstation and agent DTOs', async () => {
    await w.hire('Una', 'builder', 'junior');
    expect((await agentOf('Una')).sandbox).toBeNull(); // an old runner reports nothing
    hello(runtime('unsandboxed', 'Native Windows: allowUnsandboxed is set'));
    await until(
      async () => (await workstation()).runtimes[0].sandbox === 'unsandboxed',
      3000,
      'state stored',
    );
    expect((await workstation()).runtimes[0]).toMatchObject({
      sandbox: 'unsandboxed',
      sandboxReason: 'Native Windows: allowUnsandboxed is set',
    });
    expect(await agentOf('Una')).toMatchObject({
      sandbox: 'unsandboxed',
      sandboxReason: 'Native Windows: allowUnsandboxed is set',
    });
  });

  it('a runtimes.report after a re-probe updates it, including back to enforced', async () => {
    r.send('runtimes.report', { runtimes: runtime('enforced', 'bubblewrap + socat') });
    await until(async () => (await workstation()).runtimes[0].sandbox === 'enforced', 3000, 'report applied');
    expect((await agentOf('Una')).sandbox).toBe('enforced');
  });
});

describe('hire gate', () => {
  const hire = (name: string, extra: Record<string, unknown> = {}) =>
    w.t.req('POST', '/api/agents', {
      cookie: w.owner.cookie,
      body: {
        name,
        roleKey: 'builder',
        seniority: 'junior',
        workstationId: w.workstationId,
        runtime: 'mock',
        model: 'mock',
        ...extra,
      },
    });
  const settle = async (state: string) => {
    r.send('runtimes.report', { runtimes: runtime(state, `${state} for the test`) });
    await until(async () => (await workstation()).runtimes[0].sandbox === state, 3000, state);
  };

  it('refuses an unsandboxed workstation without the acknowledgement, and records it when given', async () => {
    await settle('unsandboxed');
    const refused = await hire('Gus');
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('unsandboxed_ack_required');
    expect(await q(`SELECT 1 FROM agents WHERE name='Gus'`)).toHaveLength(0);
    const ok = await hire('Gus', { acknowledgeUnsandboxed: true });
    expect(ok.status).toBe(201);
    const ev = await q(`SELECT payload FROM events WHERE type='AgentHired' AND payload->>'name'='Gus'`);
    expect(ev[0]?.payload.unsandboxedAck).toMatchObject({ by: w.owner.id });
    expect(Date.parse(ev[0]?.payload.unsandboxedAck.at)).toBeGreaterThan(0);
  });

  it('refuses an unavailable workstation outright, with the reason, even when acknowledged', async () => {
    await settle('unavailable');
    const r1 = await hire('Hal', { acknowledgeUnsandboxed: true });
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('sandbox_unavailable');
    expect(r1.body.error.message).toContain('unavailable for the test');
  });

  it('gates a runtime change the same way and records the acknowledgement', async () => {
    await settle('enforced');
    const h = await hire('Ivy', { runtime: 'mock' });
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    const a = h.body.agent ?? h.body;
    await settle('unsandboxed');
    const patch = (body: object) => w.t.req('PATCH', `/api/agents/${a.id}`, { cookie: w.owner.cookie, body });
    // the runtime did not change: no gate
    expect((await patch({ model: 'mock-2' })).status).toBe(200);
    // a changed runtime that lands on an unsandboxed one: gate (the runtime id is the same here, so use another id)
    await q(
      `UPDATE workstations SET runtimes = runtimes || '[{"id":"mock2","version":"1","available":true,"capabilities":[],"sandbox":"unsandboxed"}]'::jsonb WHERE id=$1`,
      [w.workstationId],
    );
    const refused = await patch({ runtime: 'mock2' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('unsandboxed_ack_required');
    expect((await patch({ runtime: 'mock2', acknowledgeUnsandboxed: true })).status).toBe(200);
    const ev = await q(
      `SELECT payload FROM events WHERE type='AgentChanged' AND payload->>'agentId'=$1 AND payload->'changes'->>'runtime'='mock2'`,
      [a.id],
    );
    expect(ev[0]?.payload.unsandboxedAck).toMatchObject({ by: w.owner.id });
    expect(ev[0]?.payload.changes).not.toHaveProperty('acknowledgeUnsandboxed');
  });
});

describe('live refresh', () => {
  const changed = async () =>
    (await q(`SELECT payload FROM events WHERE type='WorkstationRuntimesChanged' ORDER BY seq`)).length;

  it('a runtimes.report that changes the state emits an event the browsers invalidate on; an identical one does not', async () => {
    r.send('runtimes.report', { runtimes: runtime('enforced', 'x') });
    await until(async () => (await workstation()).runtimes[0].sandbox === 'enforced', 3000, 'enforced');
    const n = await changed();
    r.send('runtimes.report', { runtimes: runtime('enforced', 'reworded reason') });
    r.send('runtimes.report', { runtimes: runtime('unavailable', 'y') });
    await until(async () => (await changed()) === n + 1, 3000, 'one event for the change');
    const last = (
      await q(`SELECT payload FROM events WHERE type='WorkstationRuntimesChanged' ORDER BY seq DESC LIMIT 1`)
    )[0];
    expect(last?.payload.runtimes[0]).toMatchObject({ id: 'mock', sandbox: 'unavailable' });
  });
});
