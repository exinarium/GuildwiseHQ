import { INDUSTRY_BUNDLES, type IndustryBundle, rulePackById } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// GWP-233: one install or uninstall for an industry's rule pack, playbooks, knowledge templates, sample data and
// journey templates. Needs the test database, like the other ledger suites.

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  await q(`UPDATE organizations SET mode='business' WHERE id=$1`, [w.owner.id]);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const orgId = () => w.owner.id;
const raw = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) });
const call = (method: string, url: string, body?: unknown, status = 200) =>
  ok<any>(raw(method, url, body), status);
const install = (id: string, status = 200) => call('POST', `/api/industry-bundles/${id}/install`, {}, status);
const remove = (id: string, status = 200) => call('POST', `/api/industry-bundles/${id}/remove`, {}, status);

const bundleOf = (id: string): IndustryBundle => {
  const b = INDUSTRY_BUNDLES.find((x) => x.id === id);
  if (!b) throw new Error(`no bundle ${id}`);
  return b;
};
const eventCount = async () => Number((await q('SELECT count(*)::int AS n FROM events'))[0]?.n);
const bundleEvents = async (id: string) =>
  Number(
    (
      await q('SELECT count(*)::int AS n FROM events WHERE stream_id=$1', [
        `industry-bundle-${orgId()}-${id}`,
      ])
    )[0]?.n,
  );
const packRows = (packId: string) =>
  q(
    `SELECT id, rule_pack_rule_id, retired_at FROM ledger_entries WHERE org_id=$1 AND rule_pack_id=$2 ORDER BY created_at, id`,
    [orgId(), packId],
  );
const bundleSchedules = (key: string) =>
  q(`SELECT id, enabled, action FROM schedules WHERE org_id=$1 AND action->'playbook'->>'key'=$2`, [
    orgId(),
    key,
  ]);
const bundleDocs = (tag: string) =>
  q(
    `SELECT id, kind, status, title, tags, current_version FROM documents WHERE org_id=$1 AND $2 = ANY(tags)`,
    [orgId(), tag],
  );

describe.each(['accounting', 'law'])('the %s bundle', (id) => {
  const b = bundleOf(id);
  const pack = rulePackById(b.rulePackId);
  if (!pack) throw new Error('pack missing');

  it('is listed as not installed, and previewed without writing anything', async () => {
    const list = await call('GET', '/api/industry-bundles');
    const row = list.bundles.find((x: any) => x.id === id);
    expect(row).toMatchObject({ installed: false, installedAt: null });
    expect(row.counts).toEqual({
      rules: pack.rules.length,
      playbooks: b.playbookKeys.length,
      knowledgeTemplates: b.knowledgeTemplates.length,
      sampleData: b.sampleData.length,
      journeyTemplates: b.journeyTemplateIds.length,
    });
    const before = await eventCount();
    const pv = await call('GET', `/api/industry-bundles/${id}`);
    expect(pv.rulePack.rules).toHaveLength(pack.rules.length);
    expect(pv.playbooks.every((p: any) => p.status === 'new')).toBe(true);
    expect(pv.knowledgeTemplates.every((d: any) => d.status === 'new')).toBe(true);
    expect(pv.sampleData.every((d: any) => d.status === 'new')).toBe(true);
    expect(pv.blockers).toEqual([]);
    expect(await eventCount()).toBe(before);
    expect(await packRows(pack.id)).toHaveLength(0);
    expect((await raw('GET', '/api/industry-bundles/nope')).status).toBe(404);
  });

  it('installs every member in one action, with one bundle event', async () => {
    const r = await install(id);
    expect(r.status).toBe('installed');
    expect(r.rulePack.added).toHaveLength(pack.rules.length);
    expect(r.playbooks.added.map((p: any) => p.key)).toEqual(b.playbookKeys);
    expect(r.documents.added).toHaveLength(b.knowledgeTemplates.length + b.sampleData.length);
    expect(r.journeyTemplates).toEqual(b.journeyTemplateIds);

    const rules = (await call('GET', '/api/ledger?scope=standing_order')).entries.filter(
      (e: any) => e.rulePack?.id === pack.id,
    );
    expect(rules).toHaveLength(pack.rules.length);
    for (const key of b.playbookKeys) {
      const s = await bundleSchedules(key);
      expect(s).toHaveLength(1);
      expect(s[0]?.enabled).toBe(false);
      expect(s[0]?.action.deliverOutput).toBeUndefined();
    }
    const templates = await bundleDocs('industry-template');
    expect(templates.filter((d) => d.tags.includes(id))).toHaveLength(b.knowledgeTemplates.length);
    expect(
      templates
        .filter((d) => d.tags.includes(id))
        .every((d) => d.kind === 'template' && d.status === 'draft'),
    ).toBe(true);
    const samples = await bundleDocs('sample');
    expect(samples.filter((d) => d.tags.includes(id))).toHaveLength(b.sampleData.length);
    expect(samples.every((d) => d.kind === 'sample' && d.title.startsWith('Sample:'))).toBe(true);

    const row = (await call('GET', '/api/industry-bundles')).bundles.find((x: any) => x.id === id);
    expect(row.installed).toBe(true);
    expect(await bundleEvents(id)).toBe(1);
  });

  it('an installed bundle installs again as a no-op', async () => {
    const before = await eventCount();
    const docs = Number((await q('SELECT count(*)::int AS n FROM documents'))[0]?.n);
    const r = await install(id);
    expect(r.status).toBe('already_installed');
    expect(r.documents.added).toEqual([]);
    expect(await eventCount()).toBe(before);
    expect(Number((await q('SELECT count(*)::int AS n FROM documents'))[0]?.n)).toBe(docs);
  });

  it('removes exactly what it created, with one more bundle event', async () => {
    const r = await remove(id);
    expect(r.removed.ruleEntries).toHaveLength(pack.rules.length);
    expect(r.removed.schedules).toHaveLength(b.playbookKeys.length);
    expect(r.removed.documents).toHaveLength(b.knowledgeTemplates.length + b.sampleData.length);
    expect(r.kept).toEqual([]);
    expect((await packRows(pack.id)).filter((x) => !x.retired_at)).toHaveLength(0);
    for (const key of b.playbookKeys) expect(await bundleSchedules(key)).toHaveLength(0);
    expect((await bundleDocs(id)).filter((d) => d.status !== 'archived')).toHaveLength(0);
    expect(await bundleEvents(id)).toBe(2);
    const err = await remove(id, 409);
    expect(err.code ?? err.error?.code).toBe('bundle_not_installed');
  });

  it('keeps a rule and a template the organization edited, and lists them', async () => {
    await install(id);
    const [rule] = await packRows(pack.id).then((r) => r.filter((x) => !x.retired_at));
    await call('PATCH', `/api/ledger/${rule?.id}`, { body: 'Our own wording of this rule.' });
    const [tpl] = (await bundleDocs('industry-template')).filter(
      (d) => d.tags.includes(id) && d.status === 'draft' && d.current_version === 1,
    );
    await call(
      'POST',
      `/api/documents/${tpl?.id}/versions`,
      { content: 'Filled in by the firm', baseVersion: 1 },
      201,
    );
    const r = await remove(id);
    const kept = r.kept.map((k: any) => `${k.kind}:${k.id}:${k.reason}`);
    expect(kept).toContain(`document:${tpl?.id}:edited`);
    expect(r.kept.some((k: any) => k.kind === 'rule' && k.reason === 'edited')).toBe(true);
    expect((await bundleDocs('industry-template')).find((d) => d.id === tpl?.id)?.status).toBe('draft');
    expect((await packRows(pack.id)).find((x) => x.id === rule?.id)?.retired_at).toBeNull();
  });

  it('replays to the same bundle state', async () => {
    const { rebuildProjections } = await import('../src/projections/rebuild.ts');
    const read = () =>
      q(
        'SELECT bundle_id, bundle_version, items, removed_at IS NULL AS live FROM org_industry_bundles WHERE org_id=$1 ORDER BY bundle_id',
        [orgId()],
      );
    const before = await read();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await read()).toEqual(before);
  });
});

describe('the bundle commands', () => {
  it('keeps a rule pack that was installed before the bundle', async () => {
    await remove('accounting', 409).catch(() => undefined);
    await call('POST', '/api/ledger/rule-packs/accounting/install', {});
    await install('accounting');
    const r = await remove('accounting');
    expect(r.removed.ruleEntries).toEqual([]);
    expect((await packRows('accounting')).filter((x) => !x.retired_at).length).toBeGreaterThan(0);
  });

  it('rolls everything back when one member fails', async () => {
    await call('POST', '/api/ledger/rule-packs/law/remove', {});
    await q(
      `CREATE OR REPLACE FUNCTION gwp233_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced'; END $$ LANGUAGE plpgsql`,
    );
    await q(
      `CREATE TRIGGER gwp233_fail BEFORE INSERT ON documents FOR EACH ROW WHEN (NEW.kind='sample') EXECUTE FUNCTION gwp233_fail()`,
    );
    try {
      const events = await eventCount();
      const liveBefore = (await packRows('law')).filter((x) => !x.retired_at).length;
      const state = await q(
        `SELECT bundle_id FROM org_industry_bundles WHERE org_id=$1 AND removed_at IS NULL`,
        [orgId()],
      );
      const res = await raw('POST', '/api/industry-bundles/law/install', {});
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect((await packRows('law')).filter((x) => !x.retired_at)).toHaveLength(liveBefore);
      expect(await bundleSchedules('law_matter_dates_brief')).toHaveLength(0);
      expect(
        await q(`SELECT 1 FROM org_rule_packs WHERE org_id=$1 AND pack_id='law' AND removed_at IS NULL`, [
          orgId(),
        ]),
      ).toHaveLength(0);
      expect(
        await q(`SELECT bundle_id FROM org_industry_bundles WHERE org_id=$1 AND removed_at IS NULL`, [
          orgId(),
        ]),
      ).toEqual(state);
      expect(await eventCount()).toBe(events);
    } finally {
      await q('DROP TRIGGER IF EXISTS gwp233_fail ON documents');
      await q('DROP FUNCTION IF EXISTS gwp233_fail()');
    }
  });

  it('lets a member list and preview, but not install or remove', async () => {
    const m = await w.t.userSession(uniqueEmail('member'));
    await w.t.addOrgMember(orgId(), m.id, 'member');
    const asMember = (method: string, url: string) =>
      w.t.req(method, url, { cookie: m.cookie, headers: { 'x-aom-org': w.owner.id }, body: {} });
    expect((await asMember('GET', '/api/industry-bundles')).status).toBe(200);
    expect((await asMember('GET', '/api/industry-bundles/law')).status).toBe(200);
    expect((await asMember('POST', '/api/industry-bundles/law/install')).status).toBe(403);
    expect((await asMember('POST', '/api/industry-bundles/accounting/remove')).status).toBe(403);
  });
});
