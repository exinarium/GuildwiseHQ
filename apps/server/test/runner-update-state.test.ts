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

const hello = (runnerVersion: string) =>
  r.send('hello', {
    runnerVersion,
    protocol: 1,
    platform: 'linux',
    hostname: 'fake-host',
    runtimes: MOCK_RUNTIME,
    repos: [],
    vaults: [],
    activeShifts: [],
    outboxPending: 0,
  });
const workstation = async () =>
  (await w.t.req('GET', '/api/workstations', { cookie: w.owner.cookie })).body.workstations[0];

describe('runner update state', () => {
  it('shows what the runner reports about updating itself, next to its version', async () => {
    hello('0.1.1');
    await until(async () => (await workstation()).runnerVersion === '0.1.1', 3000, 'hello stored');
    expect((await workstation()).runnerUpdate).toBeNull(); // an old runner says nothing
    r.send('runner.update', {
      state: 'pending',
      latestVersion: '0.1.2',
      lastCheckedAt: new Date().toISOString(),
      detail: '0.1.2 is downloaded and installs as soon as this runner is idle',
    });
    await until(async () => (await workstation()).runnerUpdate?.state === 'pending', 3000, 'update stored');
    expect((await workstation()).runnerUpdate).toMatchObject({ state: 'pending', latestVersion: '0.1.2' });
  });

  it('forgets the state when the runner reconnects (it reports again after welcome)', async () => {
    hello('0.1.2');
    await until(async () => (await workstation()).runnerUpdate === null, 3000, 'cleared by hello');
  });
});
