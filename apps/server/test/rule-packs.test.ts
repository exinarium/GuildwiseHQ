import { randomUUID } from 'node:crypto';
import { RULE_PACKS, rulePackById } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installRulePack } from '../src/commands/rule-packs.ts';
import { standingOrdersFor, standingOrdersForProjects } from '../src/queries/ledger.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// GWP-31: rule packs for business organizations. Needs the test database, like the other ledger suites.

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const orgId = () => w.owner.id;
const call = (method: string, url: string, body?: unknown, status = 200) =>
  ok<any>(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), status);
const raw = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) });
const install = (id: string, status = 200) =>
  call('POST', `/api/ledger/rule-packs/${id}/install`, {}, status);
const remove = (id: string, status = 200) => call('POST', `/api/ledger/rule-packs/${id}/remove`, {}, status);
const rowsOf = (packId: string) =>
  q(
    `SELECT id, rule_pack_rule_id, version, review_date, retired_at, retired_reason FROM ledger_entries
      WHERE org_id=$1 AND rule_pack_id=$2 ORDER BY created_at, id`,
    [orgId(), packId],
  );
const ledger = async () => (await call('GET', '/api/ledger?scope=standing_order')).entries as any[];
const core = rulePackById('core');
if (!core) throw new Error('core pack missing');

describe('rule packs in a developer organization', () => {
  it('are refused by every route with 409 business_only, and nothing changes', async () => {
    for (const [m, u] of [
      ['GET', '/api/ledger/rule-packs'],
      ['GET', '/api/ledger/rule-packs/core'],
      ['POST', '/api/ledger/rule-packs/core/install'],
      ['POST', '/api/ledger/rule-packs/core/remove'],
    ] as const) {
      const r = await raw(m, u, m === 'POST' ? {} : undefined);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('business_only');
      expect(r.body.error.message).toMatch(/business organizations/);
    }
    expect(await q('SELECT 1 FROM ledger_entries WHERE org_id=$1', [orgId()])).toHaveLength(0);
  });
});

describe('rule packs in a business organization', () => {
  beforeAll(async () => {
    await q(`UPDATE organizations SET mode='business' WHERE id=$1`, [orgId()]);
  });

  it('lists every shipped pack, none installed, and previews each rule as new', async () => {
    const list = await call('GET', '/api/ledger/rule-packs');
    expect(list.packs.map((p: any) => p.id)).toEqual(RULE_PACKS.map((p) => p.id));
    expect(list.packs.every((p: any) => p.installed === false)).toBe(true);
    for (const p of RULE_PACKS) {
      const pv = await call('GET', `/api/ledger/rule-packs/${p.id}`);
      expect(pv.rules).toHaveLength(p.rules.length);
      expect(
        pv.rules.every((r: any) => r.enforcedBy === 'agent_instruction' || r.enforcedBy === 'server_check'),
      ).toBe(true);
    }
    expect((await raw('GET', '/api/ledger/rule-packs/nope')).status).toBe(404);
  });

  it('installs a pack as organization-wide standing orders: linked, no review date, badged, one pack row', async () => {
    const r = await install('core');
    expect(r.added).toHaveLength(core.rules.length);
    expect(r.kept).toEqual([]);
    const rows = await rowsOf('core');
    expect(rows.map((x) => x.rule_pack_rule_id)).toEqual(core.rules.map((x) => x.id));
    expect(rows.every((x) => x.review_date === null && x.version === 1)).toBe(true);
    const [pack] = await q('SELECT * FROM org_rule_packs WHERE org_id=$1 AND pack_id=$2', [orgId(), 'core']);
    expect(pack?.removed_at).toBeNull();
    const entries = (await ledger()).filter((e) => e.rulePack?.id === 'core');
    expect(entries).toHaveLength(core.rules.length);
    for (const e of entries) {
      expect(e.rulePack.name).toBe('Core rules');
      expect(e.enforcedBy).toBe('agent_instruction');
      expect(e.projectId).toBeNull();
    }
    expect(
      (await call('GET', '/api/ledger/rule-packs')).packs.find((p: any) => p.id === 'core').installed,
    ).toBe(true);
  });

  it('reaches agents like a hand-written standing order', async () => {
    const orders = await standingOrdersFor(w.t.app.ctx.pool, orgId(), w.projectId);
    const multi = await standingOrdersForProjects(w.t.app.ctx.pool, orgId(), [w.projectId]);
    for (const rule of core.rules) {
      expect(orders.map((o) => o.title)).toContain(rule.title);
      expect(multi.map((o) => o.title)).toContain(rule.title);
    }
  });

  it('is idempotent: installing again adds nothing', async () => {
    const before = (await ledger()).length;
    const r = await install('core');
    expect(r.added).toEqual([]);
    expect(r.kept).toHaveLength(core.rules.length);
    expect((await ledger()).length).toBe(before);
  });

  it('removes only unedited rules: an edited one stays, a date-only change does not count as an edit', async () => {
    const rows = await rowsOf('core');
    const [edited, dated] = rows;
    await call('PATCH', `/api/ledger/${edited?.id}`, { body: 'Our own wording: ask before any message.' });
    await call('PATCH', `/api/ledger/${dated?.id}`, { reviewDate: '2099-01-01' });
    const e = (await ledger()).find((x) => x.id === edited?.id);
    expect(e.enforcedBy).toBe('agent_instruction');
    expect(e.rulePack.id).toBe('core');

    const r = await remove('core');
    expect(r.kept).toEqual([edited?.id]);
    expect([...r.retired].sort()).toEqual(
      rows
        .slice(1)
        .map((x) => x.id)
        .sort(),
    );
    const after = await rowsOf('core');
    expect(after.find((x) => x.id === edited?.id)?.retired_at).toBeNull();
    for (const x of after.filter((y) => y.id !== edited?.id)) {
      expect(x.retired_at).not.toBeNull();
      expect(x.retired_reason).toMatch(/Removed with the rule pack "Core rules"/);
    }
    const [pack] = await q('SELECT removed_at FROM org_rule_packs WHERE org_id=$1 AND pack_id=$2', [
      orgId(),
      'core',
    ]);
    expect(pack?.removed_at).not.toBeNull();
    // retired rules are no longer briefed, the edited one is
    const orders = await standingOrdersFor(w.t.app.ctx.pool, orgId(), w.projectId);
    expect(orders.map((o) => o.title)).toContain(core.rules[0]?.title);
    expect(orders.map((o) => o.title)).not.toContain(core.rules[1]?.title);
  });

  it('installs again after a remove: retired rules come back as new rows, the edited one is kept', async () => {
    const r = await install('core');
    expect(r.added).toHaveLength(core.rules.length - 1);
    expect(r.kept).toHaveLength(1);
    const live = (await rowsOf('core')).filter((x) => !x.retired_at);
    expect(live).toHaveLength(core.rules.length);
  });

  it('skips a rule the organization already has in its own words, and leaves it unlinked', async () => {
    const own = await call(
      'POST',
      '/api/ledger',
      { scope: 'standing_order', title: 'Never: cold WhatsApp', body: 'Never: cold WhatsApp' },
      201,
    );
    const r = await install('outbound');
    expect(r.skipped.map((s: any) => s.ruleId)).toContain('never-cold-whatsapp');
    expect(r.skipped.find((s: any) => s.ruleId === 'never-cold-whatsapp').existingId).toBe(own.entry.id);
    const [row] = await q('SELECT rule_pack_id, version FROM ledger_entries WHERE id=$1', [own.entry.id]);
    expect(row?.rule_pack_id).toBeNull();
    expect(row?.version).toBe(1);
    const linked = (await rowsOf('outbound')).map((x) => x.rule_pack_rule_id);
    expect(linked).not.toContain('never-cold-whatsapp');
  });

  it('cannot be forged through POST /api/ledger, and a stranger cannot install', async () => {
    const r = await call(
      'POST',
      '/api/ledger',
      {
        scope: 'standing_order',
        title: 'Hand written about parking',
        body: 'Park the company car in the yard.',
        rulePack: { packId: 'core', ruleId: 'x', packVersion: 1 },
      },
      201,
    );
    const [row] = await q('SELECT rule_pack_id, rule_pack_rule_id FROM ledger_entries WHERE id=$1', [
      r.entry.id,
    ]);
    expect(row?.rule_pack_id).toBeNull();
    expect(row?.rule_pack_rule_id).toBeNull();
    expect(r.entry.enforcedBy).toBe('agent_instruction');
    expect(r.entry.rulePack ?? null).toBeNull();
    const stranger = { id: randomUUID(), displayName: 'x', email: 'x@example.test' } as any;
    await expect(installRulePack(w.t.app.ctx, stranger, orgId(), 'law')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('replays to the same state', async () => {
    const { rebuildProjections } = await import('../src/projections/rebuild.ts');
    const before = await q('SELECT pack_id FROM org_rule_packs WHERE org_id=$1 ORDER BY pack_id', [orgId()]);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const after = await q('SELECT pack_id FROM org_rule_packs WHERE org_id=$1 ORDER BY pack_id', [orgId()]);
    expect(after).toEqual(before);
    expect((await rowsOf('core')).filter((x) => !x.retired_at)).toHaveLength(core.rules.length);
  });
});
