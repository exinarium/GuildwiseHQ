import { SESSION_TURNS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/** Capability Registry v0 on the server: built-ins, the organization vault's index and personas from either source. */
let w: World;
let r: FakeRunner;
let vaultId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [SESSION_TURNS_CAPABILITY] });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

// biome-ignore lint/suspicious/noExplicitAny: a response body
const call = (method: string, url: string, body?: unknown, expected = 200) =>
  ok<any>(
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }),
    expected,
  );
const registry = () => call('GET', '/api/capabilities');
const meta = (key: string, kind: 'skill' | 'persona' | 'playbook', hash: string, name = key) => ({
  key,
  kind,
  name,
  description: `${name} from the vault`,
  hash: hash.repeat(64).slice(0, 64),
  source: 'org-vault' as const,
});
const events = async () =>
  (await q(`SELECT count(*)::int AS n FROM events WHERE type='CapabilityIndexReported'`))[0]?.n as number;

describe('the effective registry', () => {
  it('lists the built-ins, by kind', async () => {
    const all = await registry();
    const keys = all.items.map((i: { kind: string; key: string }) => `${i.kind}:${i.key}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        'persona:chair',
        'persona:analyst',
        'playbook:brainstorm',
        'playbook:prd',
        'skill:interview-techniques',
      ]),
    );
    expect(
      all.items.every((i: { source: string; overrides: boolean }) => i.source === 'builtin' && !i.overrides),
    ).toBe(true);
    expect(all.indexedAt).toBeNull();
    const personas = (await call('GET', '/api/capabilities?kind=persona')).items;
    expect(personas.length).toBe(9);
    expect(personas.every((i: { kind: string }) => i.kind === 'persona')).toBe(true);
    expect((await w.t.req('GET', '/api/capabilities')).status).toBe(401);
  });

  it('merges what a runner indexed in the organization vault, overriding by kind and key', async () => {
    vaultId = (
      await call('POST', '/api/vaults', { kind: 'org', remoteUrl: 'git@example.test:srv/caps.git' }, 201)
    ).id;
    r.send('capabilities.report', {
      vaultId,
      items: [
        meta('brainstorm', 'playbook', 'a', 'Our brainstorm'),
        meta('legal-eagle', 'persona', 'b', 'Legal Eagle'),
        meta('brainstorm', 'skill', 'c'),
      ],
      issues: [{ path: 'skills/Bad Name/SKILL.md', message: 'name must be lowercase' }],
    });
    await until(async () => (await registry()).indexedAt !== null);
    const all = await registry();
    const find = (kind: string, key: string) =>
      all.items.find((i: { kind: string; key: string }) => i.kind === kind && i.key === key);
    expect(find('playbook', 'brainstorm')).toMatchObject({
      source: 'org-vault',
      overrides: true,
      name: 'Our brainstorm',
    });
    expect(find('persona', 'legal-eagle')).toMatchObject({ source: 'org-vault', overrides: false });
    expect(find('skill', 'brainstorm')).toMatchObject({ source: 'org-vault', overrides: false });
    expect(find('playbook', 'prd')).toMatchObject({ source: 'builtin' });
    expect(all.issues).toEqual([{ path: 'skills/Bad Name/SKILL.md', message: 'name must be lowercase' }]);
    // metadata only: nothing but the index is stored
    const cols = (
      await q(`SELECT column_name FROM information_schema.columns WHERE table_name='capability_index'`)
    ).map((c) => c.column_name);
    expect(cols).not.toContain('content');
  });

  it('records a changed index once and ignores an identical report', async () => {
    const same = {
      vaultId,
      items: [
        meta('brainstorm', 'playbook', 'a', 'Our brainstorm'),
        meta('legal-eagle', 'persona', 'b', 'Legal Eagle'),
        meta('brainstorm', 'skill', 'c'),
      ],
      issues: [{ path: 'skills/Bad Name/SKILL.md', message: 'name must be lowercase' }],
    };
    const before = await events();
    r.send('capabilities.report', same);
    await r.barrier();
    expect(await events()).toBe(before);
    r.send('capabilities.report', {
      vaultId,
      items: [meta('legal-eagle', 'persona', 'd', 'Legal Eagle v2')],
      issues: [],
    });
    await until(async () => (await events()) === before + 1);
    const all = await registry();
    expect(all.items.find((i: { key: string; kind: string }) => i.key === 'legal-eagle')).toMatchObject({
      name: 'Legal Eagle v2',
    });
    expect(
      all.items.find((i: { key: string; kind: string }) => i.kind === 'playbook' && i.key === 'brainstorm'),
    ).toMatchObject({ source: 'builtin' });
    expect(all.issues).toEqual([]);
  });

  it('ignores a report for a vault that is not the organization vault', async () => {
    const before = await events();
    r.send('capabilities.report', {
      vaultId: '00000000-0000-4000-8000-000000000001',
      items: [meta('x', 'skill', 'e')],
      issues: [],
    });
    await r.barrier();
    expect(await events()).toBe(before);
  });

  it('lets a session use a persona that lives in the vault; the runner reads its text', async () => {
    const s = (
      await call(
        'POST',
        '/api/sessions',
        {
          kind: 'boardroom',
          title: 'Legal view',
          participants: [{ kind: 'persona', refId: 'legal-eagle', seat: 'Counsel' }],
        },
        201,
      )
    ).session;
    const p = s.participants.find((x: { refId: string }) => x.refId === 'legal-eagle');
    expect(p.displayName).toBe('Legal Eagle v2');
    const t = (
      await call(
        'POST',
        `/api/sessions/${s.threadId}/turns`,
        { participantId: p.id, message: 'Any liability?' },
        202,
      )
    ).turn;
    const start = await r.waitFor('chat.start', (f) => f.chatId === t.id);
    expect(start.session?.speaker.personaKey).toBe('legal-eagle');
    expect(start.session?.instructions).toBeUndefined();
    expect(start.agent.skills).toEqual([]);
  });

  it('rebuilds the index from events', async () => {
    const snap = async () =>
      (await q(`SELECT to_jsonb(t)::text AS j FROM capability_index t`)).map((x) => x.j as string).sort();
    const status = async () =>
      (await q(`SELECT to_jsonb(t)::text AS j FROM capability_index_status t`)).map((x) => x.j as string);
    const [a, b] = [await snap(), await status()];
    expect(a.length).toBe(1);
    const { rebuildProjections } = await import('../src/projections/rebuild.ts');
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect(await snap()).toEqual(a);
    expect(await status()).toEqual(b);
  });
});
