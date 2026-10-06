import { type VaultWriteCommand, VaultWriteCommandSchema } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createFeedProject, feedRunner, item } from './helpers/feeds.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let feedId: string;
let researchId: string;
let vaultId: string;
let run: ReturnType<typeof feedRunner>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  feedId = await createFeedProject(w);
  researchId = (
    await ok<any>(
      w.t.req('POST', '/api/projects', {
        cookie: w.owner.cookie,
        body: { key: 'RES', name: 'Research', workflowKey: 'research', domain: 'personal' },
      }),
      201,
    )
  ).project.id;
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
const acked = new Set<string>();
const writes = (): Array<{ commandId: string; cmd: VaultWriteCommand }> => {
  const seen = new Map<string, { commandId: string; cmd: VaultWriteCommand }>();
  for (const c of r.of('command').filter((x) => x.command === 'vault.write')) {
    seen.set(c.commandId, { commandId: c.commandId, cmd: VaultWriteCommandSchema.parse(c.payload) });
    if (!acked.has(c.commandId)) {
      acked.add(c.commandId);
      r.send('command.result', {
        commandId: c.commandId,
        ok: true,
        result: { committed: true, pushed: true },
      });
    }
  }
  return [...seen.values()];
};
const sectionWrites = () => writes().filter((x) => x.cmd.mode === 'section');

let rustId: string;
let otherId: string;

describe('explicit taste rules', () => {
  it('versions every set, merges per interest and mirrors one section write per set', async () => {
    rustId = (
      await ok<any>(
        owner('POST', '/api/interests', {
          name: 'Rust async',
          feedProjectId: feedId,
          researchProjectId: researchId,
        }),
        201,
      )
    ).id;
    otherId = (
      await ok<any>(owner('POST', '/api/interests', { name: 'Reloading', feedProjectId: feedId }), 201)
    ).id;

    await ok(
      owner('PUT', `/api/interests/${rustId}/taste`, {
        rules: ['Skip beginner tutorials', 'skip beginner tutorials', 'Prefer primary sources'],
      }),
    );
    let seed = await ok<any>(owner('GET', `/api/projects/${feedId}/taste-seed`));
    expect(seed.version).toBe(1);
    expect(seed.hasVault).toBe(true);
    expect(seed.rules).toEqual([
      { text: 'Skip beginner tutorials', interestId: rustId },
      { text: 'Prefer primary sources', interestId: rustId },
    ]);
    // another interest's call only replaces its own rules
    await ok(owner('PUT', `/api/interests/${otherId}/taste`, { rules: ['Skip "Boring headline"'] }));
    seed = await ok<any>(owner('GET', `/api/projects/${feedId}/taste-seed`));
    expect(seed.version).toBe(2);
    expect(seed.rules).toHaveLength(3);
    // project-wide rules keep the tagged ones when the client sends them back
    await ok(
      owner('PUT', `/api/projects/${feedId}/taste-seed`, {
        rules: [{ text: 'General rule', interestId: null }, ...seed.rules],
      }),
    );
    expect((await ok<any>(owner('GET', `/api/projects/${feedId}/taste-seed`))).version).toBe(3);

    await until(async () => sectionWrites().length === 3, 5000, 'three section writes');
    const last = sectionWrites().at(-1)?.cmd as VaultWriteCommand;
    expect(last).toMatchObject({
      vaultId,
      path: 'projects/news/taste.md',
      mode: 'section',
      section: { id: 'seed', version: 3 },
    });
    expect(last.content).toContain('- Rule: General rule');
    expect(last.content).toContain('### Rust async (interest)');
    expect(last.content).toContain('- Rule: Skip beginner tutorials');
    expect(last.content).toContain('### Reloading (interest)');
    expect(last.content.indexOf('General rule')).toBeLessThan(last.content.indexOf('### Rust async'));
  });

  it('the taste preview lists explicit rules first, and the detail shows the interest rules', async () => {
    const taste = await ok<any>(owner('GET', `/api/projects/${feedId}/taste`));
    expect(taste.seedCount).toBe(4);
    expect(taste.lines[0]).toBe('- Rule: General rule');
    const d = await ok<any>(owner('GET', `/api/interests/${rustId}`));
    expect(d.taste.rules).toEqual(['Skip beginner tutorials', 'Prefer primary sources']);
    expect(d.interest.tasteRuleCount).toBe(2);
  });

  it('renaming re-renders the heading; deleting an interest drops its rules', async () => {
    const before = (await ok<any>(owner('GET', `/api/projects/${feedId}/taste-seed`))).version;
    await ok(owner('PATCH', `/api/interests/${otherId}`, { name: 'Reloading powders' }));
    const afterRename = await ok<any>(owner('GET', `/api/projects/${feedId}/taste-seed`));
    expect(afterRename.version).toBe(before + 1);
    await until(
      async () => sectionWrites().at(-1)?.cmd.content.includes('### Reloading powders (interest)') === true,
      5000,
      'renamed heading',
    );
    await ok(owner('DELETE', `/api/interests/${otherId}`));
    const afterDelete = await ok<any>(owner('GET', `/api/projects/${feedId}/taste-seed`));
    expect(afterDelete.rules.some((x: any) => x.interestId === otherId)).toBe(false);
    expect(afterDelete.version).toBe(before + 2);
  });

  it('rejects rules tagged with an interest of another project and a research project', async () => {
    const bad = await owner('PUT', `/api/projects/${feedId}/taste-seed`, {
      rules: [{ text: 'x', interestId: '00000000-0000-4000-8000-000000000000' }],
    });
    expect(bad.status).toBe(400);
    const notFeed = await owner('PUT', `/api/projects/${researchId}/taste-seed`, { rules: [] });
    expect(notFeed.status).toBe(400);
    expect(notFeed.body.error.code).toBe('not_a_feed_project');
  });

  it('resync re-sends the same rules at the next version', async () => {
    const before = (await ok<any>(owner('GET', `/api/projects/${feedId}/taste-seed`))).version;
    const res = await ok<any>(owner('POST', `/api/projects/${feedId}/taste-seed/resync`));
    expect(res.version).toBe(before + 1);
    await until(
      async () => sectionWrites().at(-1)?.cmd.section?.version === before + 1,
      5000,
      'resync write',
    );
  });
});

describe('the brief and the digest', () => {
  it('carries the project-wide rules and the card interest rules only, and cards of the interest count in its stats', async () => {
    await ok(owner('PUT', `/api/interests/${rustId}/taste`, { rules: ['Skip beginner tutorials'] }));
    await ok(owner('POST', `/api/interests/${rustId}/run`), 201);
    const { scout, curator } = await run.scan([item(1), item(2)]);
    const feed = curator.brief.feed;
    expect(feed?.tasteSeed).toEqual(['General rule', 'Skip beginner tutorials']);
    expect(scout).toBeTruthy();
    const res = await run.digest(curator.shiftId, { items: [item(1), item(2)] });
    expect(res.accepted).toBe(true);

    const desk = await ok<any>(owner('GET', '/api/desk'));
    const rating = desk.items.find((i: any) => i.kind === 'rating');
    await ok(owner('POST', `/api/digest-items/${rating.digestItems[0].id}/rate`, { verdict: 'useful' }));
    await ok(owner('POST', `/api/digest-items/${rating.digestItems[1].id}/rate`, { verdict: 'boring' }));

    const d = await ok<any>(owner('GET', `/api/interests/${rustId}`));
    expect(d.interest.stats).toMatchObject({
      scans30d: 1,
      items: { total: 2, last30d: 2, lastScan: 2 },
      ratings: { useful: 1, irrelevant: 0, boring: 1, unrated: 0 },
    });
    expect(d.scans[0]).toMatchObject({ items: 2, nothingQualified: false });
    // the digest filter by interest
    const filtered = await ok<any>(
      owner('GET', `/api/digest-items?projectId=${feedId}&interestId=${rustId}`),
    );
    expect(filtered.items).toHaveLength(2);
    const none = await ok<any>(owner('GET', `/api/digest-items?projectId=${feedId}&interestId=${otherId}`));
    expect(none.items).toHaveLength(0);
  });

  it('a card of another interest gets only the project-wide rules', async () => {
    const third = (
      await ok<any>(owner('POST', '/api/interests', { name: 'Third', feedProjectId: feedId }), 201)
    ).id;
    await ok(owner('POST', `/api/interests/${third}/run`), 201);
    const { curator } = await run.scan([item(3)]);
    const feed = curator.brief.feed;
    expect(feed?.tasteSeed).toEqual(['General rule']);
  });
});

describe('research this and the research stats', () => {
  it('validates the interest id against the card project and counts the card as open research', async () => {
    const fields = { question: 'What now?', depth: 'standard' };
    const good = await owner('POST', '/api/cards', {
      projectId: researchId,
      title: 'Research: Rust async',
      cardType: 'research',
      fields,
      interestId: rustId,
    });
    expect(good.status).toBe(201);
    const card = (await q('SELECT interest_id FROM cards WHERE id=$1', [good.body.card.id]))[0];
    expect(card?.interest_id).toBe(rustId);
    const wrong = await owner('POST', '/api/cards', {
      projectId: researchId,
      title: 'x',
      cardType: 'research',
      fields,
      interestId: (
        await ok<any>(owner('POST', '/api/interests', { name: 'Feed only', feedProjectId: feedId }), 201)
      ).id,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('interest_project_mismatch');
    const missing = await owner('POST', '/api/cards', {
      projectId: researchId,
      title: 'x',
      cardType: 'research',
      fields,
      interestId: '00000000-0000-4000-8000-000000000000',
    });
    expect(missing.status).toBe(404);
    const d = await ok<any>(owner('GET', `/api/interests/${rustId}`));
    expect(d.interest.stats.research.open).toBe(1);
  });
});
