import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool } from './helpers/db.ts';
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
