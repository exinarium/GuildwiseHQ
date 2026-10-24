import {
  indexPack,
  PACKS_CAPABILITY,
  packSnapshotOf,
  SESSION_TURNS_CAPABILITY,
  SESSION_VERBS_CAPABILITY,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { samplePackFixture } from '../../../packages/shared/test/fixtures/sample-pack-fixture.ts';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/** Discovery with a playbook and a template from an approved pack; boardroom cast lists approved pack personas only. */
let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({
    capabilities: [SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY, PACKS_CAPABILITY],
  });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});
const call = (method: string, url: string, body?: unknown, expected = 200) =>
  // biome-ignore lint/suspicious/noExplicitAny: a response body
  ok<any>(
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }),
    expected,
  );
const raw = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) });

describe('discovery with pack capabilities', () => {
  let packId = '';
  it('refuses a pack playbook until the pack is approved', async () => {
    packId = (
      await call(
        'POST',
        '/api/packs',
        { name: 'sample', url: 'https://github.com/x/sample.git', ref: 'v1.2.0' },
        201,
      )
    ).pack.id;
    const snap = packSnapshotOf({
      name: 'sample',
      ref: 'v6.12.4',
      sha: 'a'.repeat(40),
      index: indexPack({ name: 'sample', adapter: 'auto', tree: samplePackFixture() }),
    });
    r.send('packs.report', { packId, state: 'resolved', snapshot: snap });
    await until(async () => (await call('GET', '/api/packs')).packs[0].status === 'ready');
    const bad = await raw('POST', '/api/discovery', {
      title: 'x',
      idea: 'y',
      playbook: 'sample:brainstorming',
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('unknown_playbook');
    await call('POST', `/api/packs/${packId}/trust`, { sha: snap.sha, contentHash: snap.contentHash });
    const reg = (await call('GET', '/api/capabilities?kind=persona&usable=true')).items;
    expect(reg.some((i: { key: string }) => i.key === 'sample:analyst')).toBe(true);
  });

  it('runs the facilitator on the pack playbook, loaded through aom skill show', async () => {
    const s = (
      await call(
        'POST',
        '/api/discovery',
        { title: 'Pack style', idea: 'Invoices', playbook: 'sample:brainstorming' },
        201,
      )
    ).state;
    expect(s.config.playbook).toBe('sample:brainstorming');
    const start = await r.waitFor('chat.start', (f) => f.message.includes('"role":"facilitator"'), 15_000);
    expect(start.message).toContain('aom skill show playbook:sample:brainstorming');
    expect(start.message).toContain('imported pack');
  });

  it('accepts a pack template for the capture step and refuses one that is not a template', async () => {
    const bad = await raw('POST', '/api/discovery', {
      title: 'x',
      idea: 'y',
      templateKey: 'sample:brainstorming',
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('unknown_template');
    const s = (
      await call('POST', '/api/discovery', { title: 'Tpl', idea: 'y', templateKey: 'sample:prd' }, 201)
    ).state;
    expect(s.config.templateKey).toBe('sample:prd');
  });

  it('refuses them again once the approval is revoked', async () => {
    await call('POST', `/api/packs/${packId}/revoke`);
    expect(
      (await raw('POST', '/api/discovery', { title: 'x', idea: 'y', playbook: 'sample:brainstorming' }))
        .status,
    ).toBe(400);
    expect(
      (await call('GET', '/api/capabilities?kind=persona&usable=true')).items.some(
        (i: { key: string }) => i.key === 'sample:analyst',
      ),
    ).toBe(false);
  });
});
