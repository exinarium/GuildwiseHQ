import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchLedger } from '../src/queries/ledger.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const add = (body: Record<string, unknown>, cookie = w.owner.cookie, status = 201) =>
  ok<any>(w.t.req('POST', '/api/ledger', { cookie, body }), status);
const list = (qs: string, cookie = w.owner.cookie) =>
  ok<any>(w.t.req('GET', `/api/ledger${qs}`, { cookie })).then((r) => r.entries as any[]);

describe('ledger entries', () => {
  it('lets the manager add a decision, a requirement and a standing order without a question', async () => {
    const dec = await add({
      scope: 'decision',
      projectId: w.projectId,
      title: 'Indentation',
      body: 'Source files are indented with tabs, never spaces.',
      tags: ['style'],
    });
    expect(dec.entry).toMatchObject({ scope: 'decision', projectKey: 'TOY', tags: ['style'], cardId: null });
    const card = await w.card({ title: 'Ledger card' });
    const req = await add({
      scope: 'feature',
      cardId: card.id,
      title: 'Export format',
      body: 'The export endpoint returns CSV with a header row.',
    });
    expect(req.entry).toMatchObject({ scope: 'feature', cardRef: card.ref, projectId: w.projectId });
    const so = await add({
      scope: 'standing_order',
      title: 'Never push',
      body: 'Agents never push to a remote branch.',
    });
    expect(so.entry).toMatchObject({ scope: 'standing_order', projectId: null });
    expect(await q(`SELECT type FROM events WHERE stream_id=$1`, [streamId.ledger(so.entry.id)])).toEqual([
      { type: 'LedgerEntryAdded' },
    ]);
  });

  it('validates the request and the scope rules', async () => {
    const bad = await w.t.req('POST', '/api/ledger', {
      cookie: w.owner.cookie,
      body: { scope: 'decision', title: 'x', body: 'y' },
    });
    expect(bad.status).toBe(400);
  });

  it('lists by scope and project, newest first', async () => {
    expect((await list('?scope=standing_order')).map((e) => e.title)).toEqual(['Never push']);
    expect((await list(`?projectId=${w.projectId}`)).length).toBe(3); // project entries + org-wide standing order
    expect((await list('')).length).toBe(3);
  });
});

describe('ledger search', () => {
  it('matches all words first, then any word above the rank floor', async () => {
    const strict = await list('?q=indented+tabs');
    expect(strict[0]).toMatchObject({ title: 'Indentation' });
    expect(strict[0].rank).toBeGreaterThan(0);
    // None of these words is in an entry together, but "tabs" is: loose match.
    const loose = await list('?q=should+we+use+tabs+in+the+toy+formatter');
    expect(loose.map((e) => e.title)).toContain('Indentation');
    expect(await list('?q=kubernetes')).toEqual([]);
  });

  it('honours the scope filter and ignores superseded entries', async () => {
    expect(await list('?q=push&scope=decision')).toEqual([]);
    expect((await list('?q=push&scope=standing_order')).map((e) => e.title)).toEqual(['Never push']);
    const entry = (await list('?q=Export+format'))[0];
    const newer = randomUUID();
    await seed(w, [
      {
        streamId: streamId.ledger(newer),
        event: {
          type: 'LedgerEntryAdded',
          payload: {
            entryId: newer,
            scope: 'feature',
            projectId: w.projectId,
            title: 'Export format v2',
            body: 'Export is JSON now.',
          },
        },
        actor: { kind: 'user', id: w.owner.id },
        scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' },
      },
      {
        streamId: streamId.ledger(entry.id),
        event: { type: 'LedgerEntrySuperseded', payload: { entryId: entry.id, supersededBy: newer } },
        actor: { kind: 'user', id: w.owner.id },
        scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' },
      },
    ]);
    const titles = (await list('?q=export')).map((e) => e.title);
    expect(titles).toContain('Export format v2');
    expect(titles).not.toContain('Export format');
  });

  it('dedup search scopes to the org and project plus standing orders', async () => {
    const pool = w.t.app.ctx.pool;
    const own = await searchLedger(pool, 'tabs indentation', { orgId: w.owner.id, projectId: w.projectId });
    expect(own.map((e) => e.title)).toContain('Indentation');
    const otherProject = await searchLedger(pool, 'tabs indentation', {
      orgId: w.owner.id,
      projectId: randomUUID(),
    });
    expect(otherProject.map((e) => e.title)).not.toContain('Indentation'); // other project's decision log
    const otherOrg = await searchLedger(pool, 'tabs indentation', {
      orgId: randomUUID(),
      projectId: w.projectId,
    });
    expect(otherOrg).toEqual([]);
    const so = await searchLedger(pool, 'never push remote branch', {
      orgId: w.owner.id,
      projectId: randomUUID(),
    });
    expect(so.map((e) => e.title)).toEqual(['Never push']); // standing orders apply everywhere
  });

  it('shows a user only their own org and projects they belong to', async () => {
    const other = await w.t.userSession(uniqueEmail('stranger'));
    expect(await list('?q=tabs', other.cookie)).toEqual([]);
    expect(await list('', other.cookie)).toEqual([]);
    const card = (await q('SELECT id FROM cards LIMIT 1'))[0]!;
    const denied = await w.t.req('POST', '/api/ledger', {
      cookie: other.cookie,
      body: { scope: 'feature', cardId: card.id, title: 'x', body: 'y' },
    });
    expect(denied.status).toBe(404);
    const noProject = await w.t.req('POST', '/api/ledger', {
      cookie: other.cookie,
      body: { scope: 'decision', projectId: w.projectId, title: 'x', body: 'y' },
    });
    expect(noProject.status).toBe(404);
    expect((await w.t.req('GET', '/api/ledger')).status).toBe(401);
  });
});
