import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, fullFields, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  for (const title of ['Autosave drafts', 'Export to CSV'])
    await ok(
      w.t.req('POST', '/api/cards', {
        cookie: w.owner.cookie,
        body: {
          projectId: w.projectId,
          title,
          cardType: 'feature',
          fields: fullFields(),
          completionAction: 'merge',
          specify: false,
        },
      }),
      201,
    );
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const search = (text: string, cookie = w.owner.cookie) =>
  w.t.req('GET', `/api/search/cards?q=${encodeURIComponent(text)}`, { cookie });

describe('GET /api/search/cards (command palette)', () => {
  it('finds a card by title text or by ref', async () => {
    const byTitle = await ok<any>(search('autosave'));
    expect(byTitle.cards.map((c: any) => c.title)).toEqual(['Autosave drafts']);
    expect(byTitle.cards[0]).toMatchObject({ projectKey: 'TOY', ref: expect.stringMatching(/^TOY-\d+$/) });
    const byRef = await ok<any>(search(byTitle.cards[0].ref));
    expect(byRef.cards[0].ref).toBe(byTitle.cards[0].ref);
  });

  it('treats % and _ literally and rejects an empty query', async () => {
    expect((await ok<any>(search('%'))).cards).toEqual([]);
    expect((await search('  ')).status).toBe(400);
  });

  it("never lists the cards of an interest's hidden project", async () => {
    await q(`UPDATE projects SET kind='interest' WHERE id=$1`, [w.projectId]);
    try {
      expect((await ok<any>(search('autosave'))).cards).toEqual([]);
    } finally {
      await q(`UPDATE projects SET kind='project' WHERE id=$1`, [w.projectId]);
    }
    expect((await ok<any>(search('autosave'))).cards).toHaveLength(1);
  });

  it('never returns cards of projects the user is not a member of', async () => {
    const stranger = await w.t.userSession(`search-${Date.now()}@example.com`);
    expect((await ok<any>(search('autosave', stranger.cookie))).cards).toEqual([]);
  });
});
