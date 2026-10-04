import { FEED_LIST_HEADER, TASTE_HEADER, type VaultWriteCommand, VaultWriteCommandSchema } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createFeedProject, feedRunner, feedSchedule, item } from './helpers/feeds.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let feedId: string;
let vaultId: string;
let run: ReturnType<typeof feedRunner>;
let ratingDesk: any;
let items: any[];
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  feedId = await createFeedProject(w);
  await w.hire('Scout', 'scout', 'junior');
  await w.hire('Cora', 'curator', 'junior');
  const vault = await ok<any>(
    w.t.req('POST', '/api/vaults', {
      cookie: w.owner.cookie,
      body: { kind: 'personal', remoteUrl: 'git@example.test:srv/personal.git' },
    }),
    201,
  );
  vaultId = vault.id;
  await q(
    `INSERT INTO workstation_vaults (workstation_id, vault_id, local_path) VALUES ($1,$2,'/vaults/p')`,
    [w.workstationId, vaultId],
  );
  run = feedRunner(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
/** Every vault.write the runner received, once each (the server re-sends commands that are not completed yet). */
const writes = (): Array<{ commandId: string; cmd: VaultWriteCommand }> => {
  const seen = new Map<string, { commandId: string; cmd: VaultWriteCommand }>();
  for (const c of r.of('command').filter((x) => x.command === 'vault.write'))
    seen.set(c.commandId, { commandId: c.commandId, cmd: VaultWriteCommandSchema.parse(c.payload) });
  return [...seen.values()];
};
const acked = new Set<string>();
/** The runner completes every vault.write it receives (the server delivers them one at a time). */
const ackAll = () => {
  for (const x of writes()) {
    if (acked.has(x.commandId)) continue;
    acked.add(x.commandId);
    r.send('command.result', { commandId: x.commandId, ok: true, result: { committed: true, pushed: true } });
  }
};
const writesTo = (file: string) => {
  ackAll();
  return writes().filter((x) => x.cmd.path === `projects/news/${file}`);
};
const rate = (id: string, body: Record<string, unknown>, cookie = w.owner.cookie) =>
  w.t.req('POST', `/api/digest-items/${id}/rate`, { cookie, body });

describe('digest on the desk and ratings', () => {
  it('a posted digest appends its items to feed.md (oldest first) and raises one rating item', async () => {
    const s = await ok<any>(feedSchedule(w, feedId), 201);
    await ok(owner('POST', `/api/schedules/${s.id}/run`), 201);
    const { curator } = await run.scan([item(1), item(2), item(3)]);
    const res = await run.digest(curator.shiftId, {
      items: [item(1), item(2), item(3)],
      tasteRuleProposal: {
        rule: 'Prefer manufacturer announcements with load data',
        evidenceUrls: [item(1).url],
      },
    });
    expect(res.accepted).toBe(true);

    await until(async () => writesTo('feed.md').length === 1, 5000, 'feed.md write');
    const feedWrite = writesTo('feed.md')[0]?.cmd as VaultWriteCommand;
    expect(feedWrite).toMatchObject({ vaultId, mode: 'append', push: true, header: FEED_LIST_HEADER });
    const lines = feedWrite.content.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(
      `[${item(1).title}](${item(1).url}) (article, News Example, published 2026-10-02): Summary of story 1`,
    );
    expect(lines[2]).toContain(item(3).url);

    const desk = await ok<any>(owner('GET', '/api/desk'));
    ratingDesk = desk.items.find((i: any) => i.kind === 'rating');
    items = ratingDesk.digestItems;
    expect(items.map((i: any) => i.url)).toEqual([item(1).url, item(2).url, item(3).url]);
    expect(ratingDesk.status).toBe('open');
  });

  it('a verdict is written to taste.md as an explicit rule with its example and reason', async () => {
    const ratedA = await rate(items[0].id, { verdict: 'useful', reason: 'Has load data' });
    expect(ratedA.status).toBe(200);
    expect(ratedA.body).toMatchObject({ verdict: 'useful', verdictReason: 'Has load data' });
    const ratedB = await ok<any>(rate(items[1].id, { verdict: 'irrelevant', reason: 'Not about reloading' }));
    expect(ratedB.verdict).toBe('irrelevant');

    await until(async () => writesTo('taste.md').length === 2, 5000, 'taste.md writes');
    const [first, second] = writesTo('taste.md').map((x) => x.cmd);
    expect(first).toMatchObject({ mode: 'append', header: TASTE_HEADER });
    expect(first?.content).toBe(
      `- Prefer articles like "${item(1).title}" from News Example (rated useful). Reason: Has load data. Example: ${item(1).url}\n`,
    );
    expect(second?.content).toBe(
      `- Skip articles like "${item(2).title}" from News Example (rated irrelevant). Reason: Not about reloading. Example: ${item(2).url}\n`,
    );
    // The desk item stays open until every item has a verdict.
    expect(
      (await ok<any>(owner('GET', '/api/desk'))).items.find((i: any) => i.id === ratingDesk.id)?.status,
    ).toBe('open');

    await ok(rate(items[2].id, { verdict: 'boring' }));
    await until(async () => writesTo('taste.md').length === 3, 5000, 'third taste write');
    expect(writesTo('taste.md')[2]?.cmd.content).toMatch(
      /^- Deprioritise articles like .* \(rated boring\)\. Example: /,
    );
    const closed = (await ok<any>(owner('GET', '/api/desk?status=closed'))).items.find(
      (i: any) => i.id === ratingDesk.id,
    );
    expect(closed).toMatchObject({ status: 'answered', answerOption: 'acknowledged' });

    // taste.md preview rebuilt from the verdicts
    const taste = await ok<any>(owner('GET', `/api/projects/${feedId}/taste`));
    expect(taste.path).toBe('projects/news/taste.md');
    expect(taste.lines).toHaveLength(3);
    expect(taste.content.startsWith(TASTE_HEADER)).toBe(true);
    expect(taste.content).toContain('Skip articles like');
    const unrated = await ok<any>(owner('GET', `/api/digest-items?projectId=${feedId}&status=unrated`));
    expect(unrated.items).toEqual([]);
  });

  it('only members of the project can rate, and a bad verdict is rejected', async () => {
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    expect((await rate(items[0].id, { verdict: 'useful' }, stranger.cookie)).status).toBe(404);
    expect((await rate(items[0].id, { verdict: 'meh' })).status).toBe(400);
    expect((await w.t.req('GET', `/api/projects/${feedId}/taste`, { cookie: stranger.cookie })).status).toBe(
      404,
    );
  });

  it('a curator proposal lands on the desk as an approval; approving appends the (edited) rule to taste.md', async () => {
    const desk = await ok<any>(owner('GET', '/api/desk'));
    const proposal = desk.items.find((i: any) => i.kind === 'approval' && i.subkind === 'taste_rule');
    expect(proposal).toMatchObject({
      title: expect.stringContaining('taste rule'),
      body: 'Prefer manufacturer announcements with load data',
      status: 'open',
      askedBy: { role: 'curator' },
    });
    const ev = (await q(`SELECT payload FROM events WHERE type='TasteRuleProposed'`))[0]?.payload;
    expect(ev).toMatchObject({ projectId: feedId, deskItemId: proposal.id, evidenceItemIds: [items[0].id] });

    await ok(
      owner('POST', `/api/desk/${proposal.id}/resolve`, {
        resolution: 'approved',
        editedBody: 'Prefer manufacturer announcements that include load data',
      }),
    );
    await until(async () => writesTo('taste.md').length === 4, 5000, 'rule write');
    expect(writesTo('taste.md')[3]?.cmd.content).toBe(
      '- Rule: Prefer manufacturer announcements that include load data\n',
    );
    const taste = await ok<any>(owner('GET', `/api/projects/${feedId}/taste`));
    expect(taste.lines.at(-1)).toBe('- Rule: Prefer manufacturer announcements that include load data');
  });

  it('a rejected proposal writes nothing', async () => {
    const s = await ok<any>(feedSchedule(w, feedId, { name: 'second' }), 201);
    await ok(owner('POST', `/api/schedules/${s.id}/run`), 201);
    const { curator } = await run.scan([item(4)]);
    await run.digest(curator.shiftId, {
      items: [item(4)],
      tasteRuleProposal: { rule: 'Never show anything about shotguns' },
    });
    const before = writesTo('taste.md').length;
    const proposal = (await ok<any>(owner('GET', '/api/desk'))).items.find(
      (i: any) => i.subkind === 'taste_rule' && i.status === 'open',
    );
    expect(proposal.body).toBe('Never show anything about shotguns');
    await ok(owner('POST', `/api/desk/${proposal.id}/resolve`, { resolution: 'rejected' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(writesTo('taste.md')).toHaveLength(before);
    const taste = await ok<any>(owner('GET', `/api/projects/${feedId}/taste`));
    expect(taste.content).not.toContain('shotguns');
  });
});
