import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findContradictions, findNearDuplicate, isNearDuplicate } from '../src/commands/ledger-checks.ts';
import { searchLedger, standingOrdersFor } from '../src/queries/ledger.ts';
import { ledgerRetireRpc } from '../src/runner-gateway/ledger-rpc.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// Lean Team v3 (S1b): retiring ledger entries, and the duplicate / contradiction check when a standing order is saved.

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const call = (method: string, url: string, body?: unknown, status = 200) =>
  ok<any>(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), status);
const post = (body: Record<string, unknown>, status = 201) => call('POST', '/api/ledger', body, status);
const order = (title: string, body: string, extra: Record<string, unknown> = {}, status = 201) =>
  post({ scope: 'standing_order', title, body, ...extra }, status);
const orgOf = async () =>
  (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;

describe('the text checks', () => {
  it('near-duplicates are found by title or by nearly the same words, not by a shared topic', () => {
    expect(
      isNearDuplicate({ title: 'Working Branch', body: 'a' }, { title: 'working  branch!', body: 'b' }),
    ).toBe(true);
    expect(
      isNearDuplicate(
        { title: 'Retry with back-off', body: 'Retry failed network calls with exponential back-off.' },
        {
          title: 'Back-off on retries',
          body: 'Retry failed network calls with exponential back-off, then give up.',
        },
      ),
    ).toBe(true);
    expect(
      isNearDuplicate(
        { title: 'Branches', body: 'Always branch from the working branch of the project.' },
        { title: 'Tests', body: 'Run the unit tests before every handoff and quote the output.' },
      ),
    ).toBe(false);
    expect(findNearDuplicate({ title: 'x', body: 'y' }, [])).toBeUndefined();
  });

  it('trivial variants (hyphens, articles, plurals) are still near-duplicates; different orders are not', () => {
    expect(
      isNearDuplicate(
        { title: 'User-facing copy', body: 'Write the user-facing error messages in plain language.' },
        { title: 'User facing copy', body: 'Write user facing error message in a plain language.' },
      ),
    ).toBe(true);
    expect(
      isNearDuplicate(
        { title: 'Check the tests', body: 'Run the unit tests before every handoff.' },
        { title: 'Check tests', body: 'Run unit test before every hand_off.' },
      ),
    ).toBe(true);
    expect(
      isNearDuplicate({ title: 'The Working Branch', body: 'a' }, { title: 'working branch', body: 'b' }),
    ).toBe(true);
    // genuinely different orders about nearby subjects still pass
    expect(
      isNearDuplicate(
        { title: 'User-facing copy', body: 'Write the user-facing error messages in plain language.' },
        { title: 'Error logging', body: 'Log internal errors with the request id, never the user email.' },
      ),
    ).toBe(false);
    expect(
      isNearDuplicate(
        { title: 'Branch naming', body: 'Name every branch after the card reference and a short slug.' },
        { title: 'Branch cleanup', body: 'Delete merged branches once the card is finalized.' },
      ),
    ).toBe(false);
  });

  it('a contradiction is the same subject with an opposing instruction', () => {
    const ask = {
      title: 'Test Environment',
      body: 'Ask DevOps for a test environment and wait for it before testing.',
    };
    const dont = { title: 'Test mode', body: 'Do not wait for a test environment; test without one.' };
    expect(findContradictions(ask, [{ id: '1', ...dont }]).map((x) => x.id)).toEqual(['1']);
    const other = { id: '2', title: 'Naming', body: 'Never use abbreviations in table names.' };
    expect(findContradictions(ask, [other])).toEqual([]);
    // two orders that agree are not flagged
    expect(
      findContradictions(ask, [
        {
          id: '3',
          title: 'Environment first',
          body: 'Always ask DevOps for a test environment before testing.',
        },
      ]),
    ).toEqual([]);
  });
});

describe('duplicate check on save', () => {
  it('refuses a near-duplicate standing order with a pointer to the existing one', async () => {
    const first = await order('Run the linter', 'Run the linter before every handoff and quote its output.');
    const again = await order(
      'Linter before handoff',
      'Run the linter before every handoff and quote its output in your note.',
      {},
      409,
    );
    expect(again.error?.code ?? again.code).toBe('duplicate_order');
    expect(JSON.stringify(again)).toContain(first.entry.id);
    const n = await q(`SELECT count(*)::int AS n FROM ledger_entries WHERE title LIKE '%inter%'`);
    expect(n[0]?.n).toBe(1);
  });

  it('merges into the existing order when asked: the wording is replaced, no second order exists', async () => {
    const first = await order(
      'Commit messages',
      'Write commit messages in the imperative mood with a short subject.',
    );
    const merged = await order(
      'Commit messages',
      'Write commit messages in the imperative mood with a short subject and a body.',
      { onDuplicate: 'merge' },
      200,
    );
    expect(merged.merged).toBe(true);
    expect(merged.entry.id).toBe(first.entry.id);
    expect(merged.entry.version).toBe(2);
    expect(merged.entry.body).toContain('and a body');
  });

  it('a project order duplicating an organization-wide one is refused; a different order is fine', async () => {
    await order('Reply language', 'Reply to the manager in the language they wrote in.');
    await order(
      'Reply language',
      'Reply to the manager in the language they wrote in.',
      { projectId: w.projectId },
      409,
    );
    await order('Unrelated rule', 'Keep every function under fifty lines.', { projectId: w.projectId });
  });
});

describe('contradiction check on save', () => {
  it('saves a possibly contradicting order, flags it and raises one desk item', async () => {
    const a = await order(
      'Test Environment',
      'Ask DevOps for a test environment and wait for it before the tester starts.',
      { projectId: w.projectId },
    );
    const b = await order('Test mode', 'Do not wait for a test environment; the tester starts without one.', {
      projectId: w.projectId,
    });
    expect(b.conflictsWith).toEqual([a.entry.id]);
    const flagged = (await q('SELECT conflicts_with FROM ledger_entries WHERE id=$1', [b.entry.id]))[0];
    expect(flagged?.conflicts_with).toEqual([a.entry.id]);
    const items = await q(
      `SELECT subkind, status, subject_key FROM desk_items WHERE subkind='ledger_conflict'`,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.subject_key).toBe(`ledger_conflict:${b.entry.id}`);
    const list = await call('GET', `/api/ledger?scope=standing_order&projectId=${w.projectId}`);
    expect(list.entries.find((e: any) => e.id === b.entry.id).conflictsWith).toEqual([a.entry.id]);
  });
});

describe('contradiction desk item wording by org mode', () => {
  it('reads standing order and ledger in a dev org, rule and Rules & decisions in a business org, and keeps entry titles', async () => {
    const item = async () =>
      (
        await q(
          `SELECT title, body FROM desk_items WHERE subkind='ledger_conflict' ORDER BY created_at DESC LIMIT 1`,
        )
      )[0]!;
    // Two pairs on subjects no other live order in this file shares, so neither save is refused as a near-duplicate,
    // and each second order of a pair contradicts the first.
    const devAsk = {
      title: 'Changelog first',
      body: 'Always write a changelog entry for each release before tagging it.',
    };
    const devSkip = {
      title: 'Changelog skip',
      body: 'Never write a changelog entry for a release; tagging it is enough.',
    };
    const bizAsk = {
      title: 'Database backup',
      body: 'Always take a database backup before running migrations.',
    };
    const bizSkip = {
      title: 'Backup skip',
      body: 'Do not take a database backup before migrations; snapshots cover it.',
    };
    const seeds = [devAsk, devSkip, bizAsk, bizSkip];
    for (const [i, a] of seeds.entries())
      for (const b of seeds.slice(i + 1)) expect(isNearDuplicate(a, b)).toBe(false);
    expect(findContradictions(devSkip, [{ id: 'a', ...devAsk }])).toHaveLength(1);
    expect(findContradictions(bizSkip, [{ id: 'a', ...bizAsk }])).toHaveLength(1);
    const orgId = await orgOf();
    try {
      await order(devAsk.title, devAsk.body, { projectId: w.projectId });
      const devSaved = await order(devSkip.title, devSkip.body, { projectId: w.projectId });
      expect(devSaved.conflictsWith).toHaveLength(1);
      const dev = await item();
      expect(dev.title).toBe('A new standing order may contradict an existing one: Changelog skip');
      expect(dev.body).toContain('Open the ledger');
      await q(`UPDATE organizations SET mode='business' WHERE id=$1`, [orgId]);
      await order(bizAsk.title, bizAsk.body, { projectId: w.projectId });
      const bizSaved = await order(bizSkip.title, bizSkip.body, { projectId: w.projectId });
      expect(bizSaved.conflictsWith).toHaveLength(1);
      const biz = await item();
      expect(biz.title).toBe('A new rule may contradict an existing one: Backup skip');
      expect(biz.body).toContain('"Backup skip"');
      expect(biz.body).toContain('"Database backup"');
      expect(biz.body).toContain('Open Rules & decisions');
      expect(`${biz.title} ${biz.body}`).not.toMatch(/ledger|standing order/i);
    } finally {
      await q(`UPDATE organizations SET mode='dev' WHERE id=$1`, [orgId]);
    }
  });
});

describe('retiring an entry', () => {
  it('the owner retires an entry with a reason: gone from briefs, search and the default list, kept when asked', async () => {
    const e = await order('Build P5-25 now', 'Build P5-25 now, before anything else.', {
      projectId: w.projectId,
    });
    const orgId = await orgOf();
    expect(
      (await standingOrdersFor(w.t.app.ctx.pool, orgId, w.projectId)).some(
        (o) => o.title === 'Build P5-25 now',
      ),
    ).toBe(true);
    expect((await searchLedger(w.t.app.ctx.pool, 'build P5-25', { orgId })).length).toBeGreaterThan(0);

    await call('POST', `/api/ledger/${e.entry.id}/retire`, { reason: '' }, 400);
    const r = await call('POST', `/api/ledger/${e.entry.id}/retire`, { reason: 'one-off order' });
    expect(r.entry).toMatchObject({ retiredReason: 'one-off order', canRetire: false });
    expect(r.entry.retiredAt).toBeTruthy();

    expect(
      (await standingOrdersFor(w.t.app.ctx.pool, orgId, w.projectId)).some(
        (o) => o.title === 'Build P5-25 now',
      ),
    ).toBe(false);
    expect(await searchLedger(w.t.app.ctx.pool, 'build P5-25', { orgId })).toEqual([]);
    expect(
      (await call('GET', '/api/ledger?scope=standing_order')).entries.some((x: any) => x.id === e.entry.id),
    ).toBe(false);
    const withRetired = await call('GET', '/api/ledger?scope=standing_order&includeRetired=true');
    const row = withRetired.entries.find((x: any) => x.id === e.entry.id);
    expect(row.retiredReason).toBe('one-off order');
    // it can no longer be edited, and retiring twice does nothing
    await call('PATCH', `/api/ledger/${e.entry.id}`, { body: 'Build P5-26 now.' }, 409);
    await call('POST', `/api/ledger/${e.entry.id}/retire`, { reason: 'again' });
    expect(
      (await q(`SELECT count(*)::int AS n FROM events WHERE type='LedgerEntryRetired'`))[0]?.n,
    ).toBeGreaterThanOrEqual(1);
    // a retired order frees its wording: the same order can be added again
    await order('Build P5-25 now', 'Build P5-25 now, before anything else.', { projectId: w.projectId });
  });

  it('a retired card decision is not injected into the brief of the card', async () => {
    const card = await w.card({ title: 'Cap test card' });
    const dec = await post({
      scope: 'decision',
      cardId: card.id,
      title: 'Use tabs',
      body: 'Use tabs for indentation.',
    });
    const { cardLedgerEntries } = await import('../src/queries/ledger.ts');
    expect((await cardLedgerEntries(w.t.app.ctx.pool, card.id)).entries.map((x) => x.title)).toEqual([
      'Use tabs',
    ]);
    await call('POST', `/api/ledger/${dec.entry.id}/retire`, { reason: 'wrong' });
    expect((await cardLedgerEntries(w.t.app.ctx.pool, card.id)).total).toBe(0);
  });

  it('the BA can retire through the rpc; other roles cannot', async () => {
    const e = await order('Bwrap order', 'Wrap every command in bwrap yourself.');
    const orgId = await orgOf();
    const other = (await q(`SELECT id FROM agents WHERE org_id=$1 AND role_key <> 'ba' LIMIT 1`, [orgId]))[0];
    if (other) {
      const [okOther, , err] = await ledgerRetireRpc(
        w.t.app.ctx,
        { agent_id: other.id },
        { id: e.entry.id, reason: 'x' },
      );
      expect(okOther).toBe(false);
      expect(err).toMatch(/only the BA/);
    }
    const ba = (await q(`SELECT id FROM agents WHERE org_id=$1 AND role_key='ba' LIMIT 1`, [orgId]))[0];
    if (ba) {
      const [okBa] = await ledgerRetireRpc(
        w.t.app.ctx,
        { agent_id: ba.id },
        { id: e.entry.id, reason: 'one-off' },
      );
      expect(okBa).toBe(true);
      expect(
        (await q('SELECT retired_by FROM ledger_entries WHERE id=$1', [e.entry.id]))[0]?.retired_by,
      ).toBe('ba');
    }
  });
});
