import { DIRECT_MODEL_CAPABILITY, PRIVATE_ENDPOINTS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, type World } from './helpers/world.ts';

/** Revision R2 (Q47): the workstation owner's private-endpoint allow-list. */
let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [DIRECT_MODEL_CAPABILITY, PRIVATE_ENDPOINTS_CAPABILITY] });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});
const as = (cookie: string, method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) });
const url = () => `/api/workstations/${w.workstationId}/private-endpoints`;

describe('private endpoints of a workstation', () => {
  it('is empty by default and shown with the providers', async () => {
    const res = await as(w.owner.cookie, 'GET', `/api/workstations/${w.workstationId}/providers`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ privateEndpoints: [], privateEndpointsSupported: true });
  });

  it('queues a command with the normalized entries, and shows what the runner reports back', async () => {
    const from = r.received.length;
    const res = await as(w.owner.cookie, 'PUT', url(), {
      endpoints: [' 192.168.1.12:11434 ', 'studio.lan:1234', '192.168.1.12:11434'],
    });
    expect(res.status).toBe(202);
    expect(res.body.endpoints).toEqual(['192.168.1.12:11434', 'studio.lan:1234']);
    const cmd = await r.waitFor('command', (c) => c.command === 'provider.endpoints.set', 5000, from);
    expect(cmd.payload).toEqual({ endpoints: ['192.168.1.12:11434', 'studio.lan:1234'] });
    r.send('command.result', { commandId: cmd.commandId, ok: true, result: { stored: true } });
    r.send('runtimes.report', {
      runtimes: [
        {
          id: 'direct-model',
          version: 'x',
          available: true,
          capabilities: ['skills'],
          providers: [],
          privateEndpoints: ['192.168.1.12:11434', 'studio.lan:1234'],
        },
      ],
    });
    await r.barrier();
    await w.t.app.ctx.notifier.flush();
    const got = await as(w.owner.cookie, 'GET', `/api/workstations/${w.workstationId}/providers`);
    expect(got.body.privateEndpoints).toEqual(['192.168.1.12:11434', 'studio.lan:1234']);
  });

  it('refuses wildcards, ranges, public addresses and metadata', async () => {
    for (const bad of [
      '192.168.*.*:80',
      '10.0.0.0/8:80',
      '8.8.8.8:53',
      '169.254.169.254:80',
      'host:99999',
      'nohostport',
    ])
      expect((await as(w.owner.cookie, 'PUT', url(), { endpoints: [bad] })).status, bad).toBe(422);
  });

  it('only the workstation owner edits it, not even an Owner of the organization who does not own the machine', async () => {
    const admin = await w.t.userSession('pe-admin@example.test');
    await w.t.addOrgMember(w.owner.id, admin.id, 'admin');
    const res = await as(admin.cookie, 'PUT', url(), { endpoints: ['10.0.0.5:80'] });
    expect(res.status).toBe(404);
    expect((await as(admin.cookie, 'GET', `/api/workstations/${w.workstationId}/providers`)).status).toBe(
      404,
    );
    expect((await as(w.owner.cookie, 'PUT', url(), { endpoints: [] })).status).toBe(202);
  });
});
