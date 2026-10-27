import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let orgId = '';
const SYSTEM = { kind: 'system' as const, id: null };
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });

describe('reopening a published research card', () => {
  it('supersedes the note, hides it everywhere, and a republish leaves one live row', async () => {
    const created = await ok<any>(
      owner('POST', '/api/projects', { key: 'RSX', name: 'Research reopen', workflowKey: 'research' }),
      201,
    );
    const projectId = created.project.id as string;
    const card = (
      await ok<any>(
        owner('POST', '/api/cards', {
          projectId,
          title: 'Which db?',
          cardType: 'research',
          fields: { question: 'Which db?', depth: 'standard' },
          specify: true,
        }),
        201,
      )
    ).card;
    const publish = (title: string) =>
      seed(w, [
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'ResearchPublished',
            payload: {
              cardId: card.id,
              projectId,
              vaultPath: `projects/rsx/general/${title}.md`,
              title,
              citations: [
                { url: 'https://example.test/a', title: 'A', accessedAt: '2026-10-03T08:00:00.000Z' },
              ],
              excerpt: 'x',
            },
          },
          actor: SYSTEM,
          scope: { orgId, projectId, audience: 'project' },
        },
      ]);
    const listed = async () =>
      (await ok<any>(owner('GET', `/api/research/publications?projectId=${projectId}`))).publications ??
      (await ok<any>(owner('GET', `/api/research/publications?projectId=${projectId}`)));
    const noteCount = async () =>
      Number((await q('SELECT count(*) AS n FROM research_publications WHERE card_id=$1', [card.id]))[0]?.n);
    const live = async () =>
      Number(
        (
          await q(
            'SELECT count(*) AS n FROM research_publications WHERE card_id=$1 AND superseded_at IS NULL',
            [card.id],
          )
        )[0]?.n,
      );

    await publish('first');
    expect(await listed()).toHaveLength(1);
    expect((await q('SELECT status FROM cards WHERE id=$1', [card.id]))[0]?.status).toBe('done');

    await ok(owner('POST', `/api/cards/${card.id}/reopen`, { toStage: 'research', reason: 'needs more' }));
    expect(await listed()).toHaveLength(0);
    expect(await noteCount()).toBe(1); // kept for history
    expect(await live()).toBe(0);
    const proj = await ok<any>(owner('GET', `/api/projects/${projectId}`));
    expect((proj.project ?? proj).publishedNotes).toBe(0);
    const detail = await ok<any>(owner('GET', `/api/cards/${card.id}`));
    expect(
      detail.thread.some(
        (m: any) => m.kind === 'system' && /earlier research note stays in the vault/.test(m.body),
      ),
    ).toBe(true);

    await publish('second');
    expect(await noteCount()).toBe(2);
    expect(await live()).toBe(1);
    const l = await listed();
    expect(l).toHaveLength(1);
    expect(l[0].title).toBe('second');

    // a second publication without a reopen in between still leaves one live row
    await publish('third');
    expect(await live()).toBe(1);
    expect((await listed())[0].title).toBe('third');

    const snap = async () =>
      (
        await q(
          `SELECT id, title, superseded_at FROM research_publications WHERE card_id=$1 ORDER BY event_seq`,
          [card.id],
        )
      ).map((r) => `${r.id}|${r.title}|${r.superseded_at ? new Date(r.superseded_at).toISOString() : ''}`);
    await w.t.app.ctx.notifier.flush();
    const before = await snap();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snap()).toEqual(before);
    expect(PROJECTION_TABLES).toContain('research_publications');
  });
});
