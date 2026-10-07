import { INTEREST_DOC_FILE, type VaultWriteCommand, VaultWriteCommandSchema } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createFeedInterest, feedRunner, item, runNow } from './helpers/feeds.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let vaultId: string;
let run: ReturnType<typeof feedRunner>;
let rust: { id: string; projectId: string };
let other: { id: string; projectId: string };
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  await w.hire('Scout', 'scout', 'junior');
  await w.hire('Cora', 'curator', 'junior');
  const vault = await ok<any>(
    w.t.req('POST', '/api/vaults', {
      cookie: w.owner.cookie,
      body: { kind: 'org', remoteUrl: 'git@example.test:srv/org.git' },
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
const sectionWrites = (file: string) =>
  writes().filter((x) => x.cmd.mode === 'section' && x.cmd.path.endsWith(`/${file}`));

describe('taste rules built into the interest', () => {
  it('versions every set and mirrors one section write per set into interests/<slug>/taste.md', async () => {
    rust = await createFeedInterest(w, { name: 'Rust async', tasteRules: ['Skip beginner tutorials'] });
    other = await createFeedInterest(w, { name: 'Reloading' });
    await until(async () => sectionWrites('taste.md').length === 1, 5000, 'first taste section');
    await ok(
      owner('PUT', `/api/interests/${rust.id}/taste`, {
        rules: ['Skip beginner tutorials', 'skip beginner tutorials', 'Prefer primary sources'],
      }),
    );
    const d = await ok<any>(owner('GET', `/api/interests/${rust.id}`));
    expect(d.taste).toMatchObject({
      rules: ['Skip beginner tutorials', 'Prefer primary sources'],
      version: 2,
      hasVault: true,
    });
    expect(d.interest.tasteRuleCount).toBe(2);
    // another interest keeps its own rules
    await ok(owner('PUT', `/api/interests/${other.id}/taste`, { rules: ['Skip "Boring headline"'] }));
    expect((await ok<any>(owner('GET', `/api/interests/${rust.id}`))).taste.rules).toHaveLength(2);

    await until(async () => sectionWrites('taste.md').length === 3, 5000, 'three taste sections');
    const mine = sectionWrites('taste.md').filter((x) => x.cmd.path === 'interests/rust-async/taste.md');
    const last = mine.at(-1)?.cmd as VaultWriteCommand;
    expect(last).toMatchObject({ vaultId, section: { id: 'seed', version: 2 } });
    expect(last.content).toContain('- Rule: Skip beginner tutorials');
    expect(last.content).toContain('- Rule: Prefer primary sources');
  });

  it('writes INTEREST.md when the interest is created and again when it changes', async () => {
    await until(
      async () =>
        sectionWrites(INTEREST_DOC_FILE).some((x) => x.cmd.path === 'interests/rust-async/INTEREST.md'),
      5000,
      'INTEREST.md',
    );
    const before = sectionWrites(INTEREST_DOC_FILE).length;
    await ok(
      owner('PATCH', `/api/interests/${rust.id}`, {
        description: 'Tokio internals',
        preferredSites: ['lobste.rs'],
      }),
    );
    await until(async () => sectionWrites(INTEREST_DOC_FILE).length > before, 5000, 'INTEREST.md update');
    const last = sectionWrites(INTEREST_DOC_FILE).at(-1)?.cmd as VaultWriteCommand;
    expect(last.section?.id).toBe('interest');
    expect(last.content).toContain('# Rust async');
    expect(last.content).toContain('Tokio internals');
    expect(last.content).toContain('Preferred sites: lobste.rs');
  });

  it('resync re-sends the same rules at the next version', async () => {
    const before = (await ok<any>(owner('GET', `/api/interests/${rust.id}`))).taste.version;
    await ok(owner('POST', `/api/interests/${rust.id}/taste/resync`));
    const after = (await ok<any>(owner('GET', `/api/interests/${rust.id}`))).taste;
    expect(after.version).toBe(before + 1);
    expect(after.rules).toHaveLength(2);
    await until(
      async () =>
        sectionWrites('taste.md')
          .filter((x) => x.cmd.path === 'interests/rust-async/taste.md')
          .at(-1)?.cmd.section?.version ===
        before + 1,
      5000,
      'resync write',
    );
  });
});

describe('the brief and the digest', () => {
  it('carries only the rules of the card interest, and cards of the interest count in its stats', async () => {
    await runNow(w, rust.id);
    const { curator } = await run.scan([item(1), item(2)]);
    expect(curator.brief.feed?.tasteSeed).toEqual(['Skip beginner tutorials', 'Prefer primary sources']);
    const res = await run.digest(curator.shiftId, { items: [item(1), item(2)] });
    expect(res.accepted).toBe(true);

    const desk = await ok<any>(owner('GET', '/api/desk'));
    const rating = desk.items.find((i: any) => i.kind === 'rating');
    await ok(owner('POST', `/api/digest-items/${rating.digestItems[0].id}/rate`, { verdict: 'useful' }));
    await ok(owner('POST', `/api/digest-items/${rating.digestItems[1].id}/rate`, { verdict: 'boring' }));

    const d = await ok<any>(owner('GET', `/api/interests/${rust.id}`));
    expect(d.interest.stats).toMatchObject({
      runs30d: 1,
      items: { total: 2, last30d: 2, lastRun: 2, held: 0 },
      ratings: { useful: 1, irrelevant: 0, boring: 1, unrated: 0 },
      lastRun: { kind: 'scan', status: 'published', found: 2, published: 2 },
    });
    const filtered = await ok<any>(
      owner('GET', `/api/digest-items?projectId=${rust.projectId}&interestId=${rust.id}`),
    );
    expect(filtered.items).toHaveLength(2);
    const none = await ok<any>(
      owner('GET', `/api/digest-items?projectId=${rust.projectId}&interestId=${other.id}`),
    );
    expect(none.items).toHaveLength(0);
  });

  it('a card of another interest gets only its own rules', async () => {
    await runNow(w, other.id);
    const { curator } = await run.scan([item(3)]);
    expect(curator.brief.feed?.tasteSeed).toEqual(['Skip "Boring headline"']);
  });

  it('writes the rating line into the interest folder, and a run line into runs.md', async () => {
    await until(
      async () =>
        writes().some((x) => x.cmd.path === 'interests/rust-async/taste.md' && x.cmd.mode === 'append'),
      5000,
      'rating line',
    );
    await until(
      async () =>
        writes().some((x) => x.cmd.path === 'interests/rust-async/runs.md' && x.cmd.mode === 'append'),
      5000,
      'runs.md',
    );
    const line = writes().find((x) => x.cmd.path === 'interests/rust-async/runs.md')?.cmd.content;
    expect(line).toMatch(/scan \(manual\): found 2 -> published 2, published, [A-Z0-9]+-1/);
    expect(writes().some((x) => x.cmd.path === 'interests/rust-async/feed.md')).toBe(true);
  });
});

describe('research this', () => {
  it('starts a research run in the interest, with the question and the depth, notes under notes/', async () => {
    const res = await ok<any>(
      owner('POST', `/api/interests/${rust.id}/run`, {
        kind: 'research',
        question: 'Is the new scheduler faster?',
        depth: 'deep',
      }),
      201,
    );
    const card = (await q('SELECT * FROM cards WHERE id=$1', [res.cardId]))[0];
    expect(card).toMatchObject({
      card_type: 'research',
      stage: 'research',
      origin: 'interest',
      interest_id: rust.id,
    });
    expect(card?.fields).toMatchObject({
      question: 'Is the new scheduler faster?',
      depth: 'deep',
      subCategory: 'notes',
    });
    const runRow = (await q('SELECT kind, trigger FROM interest_runs WHERE id=$1', [res.runId]))[0];
    expect(runRow).toMatchObject({ kind: 'research', trigger: 'manual' });
    const d = await ok<any>(owner('GET', `/api/interests/${rust.id}`));
    expect(d.interest.stats.research.open).toBe(1);
    // "Research this" on an item starts from its page
    const item1 = (
      await q(
        `SELECT id FROM digest_items WHERE card_id IN (SELECT id FROM cards WHERE interest_id=$1 AND card_type='feed') LIMIT 1`,
        [rust.id],
      )
    )[0];
    const fromItem = await ok<any>(
      owner('POST', `/api/interests/${rust.id}/run`, { kind: 'research', sourceItemId: item1?.id }),
      201,
    );
    const c2 = (await q('SELECT fields FROM cards WHERE id=$1', [fromItem.cardId]))[0];
    expect(c2?.fields.question).toMatch(/Start from this source: .* \(https:\/\/news\.example\.test\/story-/);
    const missing = await owner('POST', `/api/interests/${rust.id}/run`, {
      kind: 'research',
      sourceItemId: '00000000-0000-4000-8000-000000000000',
    });
    expect(missing.status).toBe(404);
  });
});
