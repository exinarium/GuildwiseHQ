import { branchName } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cardFactsRpc } from '../src/commands/card-facts.ts';
import { cardTicket } from '../src/commands/drafts.ts';
import { claim, uniqueCardBranch } from '../src/dispatcher/claim.ts';
import { briefWorkRef, buildShiftStart } from '../src/runner-gateway/brief.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, fullFields, markOnline, type World } from './helpers/world.ts';

let w: World;
let builders: Array<{ id: string }>;
let next = 0;
beforeAll(async () => {
  w = await createWorld({ listen: false, env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
  builders = await Promise.all(
    ['Ann', 'Bob', 'Cy'].map((n) => w.hire(n, 'builder', 'junior', { capacity: 8 })),
  );
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const claimIt = async (cardId: string) => {
  const r = await claim(w.t.app.ctx, {
    cardId,
    agentId: (builders[next++ % builders.length] as { id: string }).id,
    expectedStage: 'build',
  });
  if (!r) throw new Error('claim failed');
  return r;
};
const intakeCard = (title: string, externalRef: string) =>
  w.card({ title, fields: fullFields({ externalRef }) });
const facts = async (cardId: string) => {
  const [okay, body] = await cardFactsRpc(w.t.app.ctx, { card_id: cardId, workstation_id: null }, {});
  expect(okay).toBe(true);
  return body as { ref: string; workRef: string; isClientRef: boolean; branch: { name: string } };
};

describe('work reference: branch names, card facts and the brief', () => {
  it('an intake card is named by its ticket, everywhere a branch is chosen, and keeps its internal ref', async () => {
    const card = await intakeCard('Fix login', 'abc-1');
    expect(card.ref).toMatch(/^TOY-\d+$/);
    const f = await facts(card.id);
    expect(f).toMatchObject({ ref: card.ref, workRef: 'ABC-1', isClientRef: true });
    expect(f.branch.name).toBe('guildwise/ABC-1-fix-login');

    const r = await claimIt(card.id);
    expect(r.worktree?.branchName).toBe('guildwise/ABC-1-fix-login');
    expect(r.worktree?.branchName).not.toContain(card.ref.toLowerCase());
    const row = (await q('SELECT ref, branch_name FROM cards WHERE id=$1', [card.id]))[0];
    expect(row).toEqual({ ref: card.ref, branch_name: 'guildwise/ABC-1-fix-login' });

    const start = await buildShiftStart(w.t.app.ctx, r);
    expect(start?.brief.card).toMatchObject({ ref: card.ref, workRef: 'ABC-1', isClientRef: true });
    expect(start?.brief.project.branchPrefix).toBe('guildwise/');
    expect(start?.worktree?.branchName).toBe('guildwise/ABC-1-fix-login');
  });

  it('a card without an intake reference gets exactly the same branch as before', async () => {
    const card = await w.card({ title: 'Add login page' });
    const project = (await q('SELECT branch_prefix FROM projects WHERE id=$1', [w.projectId]))[0];
    const legacy = branchName(project?.branch_prefix, card.ref, 'Add login page');
    expect(legacy).toBe(`guildwise/${card.ref.toLowerCase()}-add-login-page`);
    expect(await facts(card.id)).toMatchObject({
      ref: card.ref,
      workRef: card.ref,
      isClientRef: false,
      branch: { name: legacy },
    });
    const r = await claimIt(card.id);
    expect(r.worktree?.branchName).toBe(legacy);
    const start = await buildShiftStart(w.t.app.ctx, r);
    expect(start?.brief.card).toMatchObject({ workRef: card.ref, isClientRef: false });
  });

  it('a card in flight keeps its branch, even when it has a ticket', async () => {
    const card = await intakeCard('Old work', 'ABC-9');
    await q('UPDATE cards SET branch_name=$2 WHERE id=$1', [card.id, 'guildwise/toy-9-old']);
    expect((await facts(card.id)).branch.name).toBe('guildwise/toy-9-old');
    const r = await claimIt(card.id);
    expect(r.worktree?.branchName).toBe('guildwise/toy-9-old');
    expect((await q('SELECT branch_name FROM cards WHERE id=$1', [card.id]))[0]?.branch_name).toBe(
      'guildwise/toy-9-old',
    );
    // The work reference still follows the ticket.
    expect((await facts(card.id)).workRef).toBe('ABC-9');
  });

  it('two cards from the same ticket never share a branch: the second gets a suffix', async () => {
    const a = await intakeCard('Same title', 'ABC-5');
    const b = await intakeCard('Same title', 'see abc-5');
    const c = await intakeCard('Same title', 'https://acme.atlassian.net/browse/ABC-5');
    expect((await claimIt(a.id)).worktree?.branchName).toBe('guildwise/ABC-5-same-title');
    expect((await claimIt(b.id)).worktree?.branchName).toBe('guildwise/ABC-5-same-title-2');
    // Case-insensitive: a branch someone stored in another case counts as taken.
    await q('UPDATE cards SET branch_name=$2 WHERE id=$1', [b.id, 'guildwise/abc-5-SAME-TITLE-2']);
    expect((await claimIt(c.id)).worktree?.branchName).toBe('guildwise/ABC-5-same-title-3');
    expect(await uniqueCardBranch(w.t.app.ctx.pool, w.projectId, a.id, 'guildwise/ABC-5-same-title')).toBe(
      'guildwise/ABC-5-same-title',
    );
  });

  it('a ticket that cannot be a branch name falls back to the internal ref with one card message', async () => {
    const before = (await q('SELECT branch_prefix FROM projects WHERE id=$1', [w.projectId]))[0]
      ?.branch_prefix;
    const prefix = `${'p'.repeat(176)}/`;
    await q('UPDATE projects SET branch_prefix=$2 WHERE id=$1', [w.projectId, prefix]);
    try {
      const key = 'ABCDEFGHIJ-1234567890123';
      const card = await intakeCard('X', key);
      const r = await claimIt(card.id);
      expect(r.worktree?.branchName).toBe(branchName(prefix, card.ref, 'X'));
      const msgs = await q(
        `SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='system' AND body LIKE $2`,
        [card.id, `%${key}%`],
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.body).toContain(card.ref);
    } finally {
      await q('UPDATE projects SET branch_prefix=$2 WHERE id=$1', [w.projectId, before]);
    }
  });

  it('briefWorkRef and cardTicket read the same normalised ticket', () => {
    expect(briefWorkRef({ ref: 'TOY-1', fields: { externalRef: 'abc-1' } })).toEqual({
      workRef: 'ABC-1',
      isClientRef: true,
    });
    expect(briefWorkRef({ ref: 'TOY-1', fields: {} })).toEqual({ workRef: 'TOY-1', isClientRef: false });
    expect(cardTicket({ fields: { externalRef: 'abc-1' } })).toMatchObject({ system: 'jira', key: 'ABC-1' });
    expect(cardTicket({ fields: { externalRef: 'acme/web#3' } })).toMatchObject({ key: 'acme/web#3' });
    expect(cardTicket({ fields: {} })).toBeNull();
  });
});
