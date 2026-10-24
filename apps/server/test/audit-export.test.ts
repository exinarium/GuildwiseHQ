import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

let t: TestApp;
let owner: { id: string; cookie: string };
let admin: { id: string; cookie: string };
let member: { id: string; cookie: string };
let other: { id: string; cookie: string };
let org = '';
let otherOrg = '';
beforeAll(async () => {
  t = await createTestApp();
  owner = await t.userSession(uniqueEmail('owner'));
  admin = await t.userSession(uniqueEmail('admin'));
  member = await t.userSession(uniqueEmail('member'));
  other = await t.userSession(uniqueEmail('other'));
  org = await t.createOrg(owner.id, 'Acme');
  otherOrg = await t.createOrg(other.id, 'Other');
  await t.addOrgMember(org, admin.id, 'admin');
  await t.addOrgMember(org, member.id, 'member');
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const get = (who: { cookie: string }, qs = '', orgId = org) =>
  t.req('GET', `/api/org/audit/export${qs}`, { cookie: who.cookie, headers: { 'x-aom-org': orgId } });

/** An event a person caused, with free text we can look for. */
async function ledger(by: string, orgId: string, title: string, body = 'body') {
  const entryId = randomUUID();
  await t.app.ctx.store.append([
    {
      streamId: streamId.ledger(entryId),
      event: {
        type: 'LedgerEntryAdded',
        payload: { entryId, scope: 'decision', title, body, tags: [] },
      } as never,
      actor: { kind: 'user', id: by } as never,
      scope: { orgId, projectId: null, audience: 'org' },
    },
  ]);
}

describe('audit export', () => {
  it('is for the Owner and Admins only', async () => {
    expect((await get(member)).status).toBe(403);
    expect((await get(admin)).status).toBe(200);
    expect((await get(owner)).status).toBe(200);
    expect((await t.req('GET', '/api/org/audit/export')).status).toBe(401);
  });

  it('exports CSV with a header, the actor and the type, as an attachment', async () => {
    await ledger(admin.id, org, 'We use Postgres');
    const r = await get(admin);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toMatch(
      /attachment; filename="audit-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(r.headers['cache-control']).toBe('no-store');
    const text = String(r.body);
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe('at,type,actor_kind,actor_id,actor_name,stream,project_id,summary,payload');
    expect(text).toContain('LedgerEntryAdded');
    expect(text).toContain('We use Postgres');
    expect(text).toContain(admin.id);
  });

  it('exports JSON as an array of rows', async () => {
    const r = await get(admin, '?format=json');
    expect(r.headers['content-type']).toContain('application/json');
    const rows = (typeof r.body === 'string' ? JSON.parse(r.body) : r.body) as Array<Record<string, any>>;
    expect(Array.isArray(rows)).toBe(true);
    const row = rows.find((x) => x.type === 'LedgerEntryAdded');
    expect(row).toMatchObject({ actor_kind: 'user', actor_id: admin.id, summary: 'ledger entry added' });
    expect(row?.payload.title).toBe('We use Postgres');
  });

  it('keeps secrets out of it', async () => {
    await ledger(
      owner.id,
      org,
      'Deploy notes',
      'the key is api_key=sk-abcdefghijklmnop1234 and password: hunter2hunter2',
    );
    const r = await get(owner, '?format=json');
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    expect(text).toContain('Deploy notes');
    expect(text).not.toContain('abcdefghijklmnop1234');
    expect(text).not.toContain('hunter2hunter2');
  });

  it('filters by actor and by type, and by the date range', async () => {
    const byOwner = (await get(owner, `?format=json&actorUserId=${owner.id}`)).body as any[];
    expect(byOwner.length).toBeGreaterThan(0);
    expect(byOwner.every((x) => x.actor_id === owner.id)).toBe(true);
    const typed = (await get(owner, '?format=json&type=LedgerEntryAdded')).body as any[];
    expect(typed.every((x) => x.type === 'LedgerEntryAdded')).toBe(true);
    // a range in the past holds nothing
    const old = (await get(owner, '?format=json&from=2020-01-01&to=2020-01-31')).body as any[];
    expect(old).toEqual([]);
    // an end date covers that whole day
    const today = new Date().toISOString().slice(0, 10);
    const day = (await get(owner, `?format=json&from=${today}&to=${today}`)).body as any[];
    expect(day.length).toBeGreaterThan(0);
  });

  it('refuses a bad or a too long range', async () => {
    expect((await get(owner, '?from=yesterday')).status).toBe(400);
    expect((await get(owner, '?from=2024-01-01&to=2023-01-01')).status).toBe(400);
    const long = await get(owner, '?from=2020-01-01&to=2023-01-01');
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe('range_too_long');
  });

  it('holds only this organization’s events', async () => {
    await ledger(other.id, otherOrg, 'Secret of the other organization');
    const mine = JSON.stringify((await get(owner, '?format=json')).body);
    expect(mine).not.toContain('Secret of the other organization');
    expect(JSON.stringify((await get(other, '?format=json', otherOrg)).body)).toContain(
      'Secret of the other organization',
    );
  });

  it('leaves out content that is not audit (messages) and spreadsheet formulas are neutralised', async () => {
    const threadId = randomUUID();
    await q(
      `INSERT INTO threads (id, org_id, kind, title, created_by, created_at) VALUES ($1,$2,'chat','c',$3,now())`,
      [threadId, org, admin.id],
    );
    await t.app.ctx.store.append([
      {
        streamId: streamId.thread(threadId),
        event: {
          type: 'ThreadMessagePosted',
          payload: {
            threadId,
            messageId: randomUUID(),
            authorKind: 'user',
            authorUserId: admin.id,
            kind: 'comment',
            body: 'private chatter xyz',
            data: {},
          },
        } as never,
        actor: { kind: 'user', id: admin.id } as never,
        scope: { orgId: org, projectId: null, audience: 'org' },
      },
    ]);
    await ledger(admin.id, org, '=HYPERLINK("http://evil")');
    const text = String((await get(admin)).body);
    expect(text).not.toContain('private chatter xyz');
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('is itself audited', async () => {
    await get(admin, '?format=json');
    const ev = await q(
      `SELECT payload, actor_id FROM events WHERE type='AuditExported' AND org_id=$1 ORDER BY seq DESC LIMIT 1`,
      [org],
    );
    expect(ev[0]?.actor_id).toBe(admin.id);
    expect(ev[0]?.payload).toMatchObject({ orgId: org, by: admin.id, format: 'json' });
    // and shows up in the next export
    const rows = (await get(admin, '?format=json&type=AuditExported')).body as any[];
    expect(rows.length).toBeGreaterThan(0);
  });

  it('streams a long log in batches', async () => {
    for (let i = 0; i < 3; i++) await ledger(admin.id, org, `bulk ${i}`);
    const rows = (await get(admin, '?format=json&type=LedgerEntryAdded')).body as any[];
    expect(rows.filter((r) => String(r.payload?.title).startsWith('bulk')).length).toBe(3);
  });
});
