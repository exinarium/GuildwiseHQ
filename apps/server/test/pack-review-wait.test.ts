import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * Owner decision Q67: the server keeps no copy of an authored pack's text, so a review waits for the author's workstation, and the
 * reviewer is told on their desk when it comes online.
 */
// biome-ignore lint/suspicious/noExplicitAny: rows
const q = async (sql: string, params: unknown[] = []): Promise<any[]> => rawQ(sql, params) as Promise<any[]>;
let w: World;
let r: FakeRunner;
let packId = '';
let member: { id: string; cookie: string };
const replyKey = 'A'.repeat(80);

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  member = await w.t.userSession(uniqueEmail('member'));
  await w.t.addOrgMember(w.owner.id, member.id, 'member');
  packId = randomUUID();
  // an authored organization pack whose author's workstation is the world's (its text lives only there)
  await q(
    `INSERT INTO packs (id, org_id, name, url, ref, source, visibility, workstation_ids, owner_user_id, added_at)
     VALUES ($1,$2,'crew','authored:crew','v1','authored','org',ARRAY[$3]::uuid[],$4, now())`,
    [packId, w.owner.id, w.workstationId, member.id],
  );
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

// biome-ignore lint/suspicious/noExplicitAny: response bodies
const asOwner = (method: string, url: string, body?: unknown, expected = 200): Promise<any> =>
  ok(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), expected);
const connected = async () =>
  (await q('SELECT connected FROM workstations WHERE id=$1', [w.workstationId]))[0]?.connected === true;
const waits = () => q('SELECT * FROM pack_review_waits WHERE pack_id=$1', [packId]);
const deskItems = () =>
  q(`SELECT * FROM desk_items WHERE subkind='pack_review_ready' AND data->>'packId'=$1`, [packId]);

describe('a review waits for the author workstation (Q67)', () => {
  it('with the workstation online there is nothing to wait for', async () => {
    await until(connected);
    const res = await asOwner('POST', `/api/packs/${packId}/review-read`, { replyKey }, 202);
    expect(res.wait).toEqual({ waiting: false });
    expect(await waits()).toEqual([]);
    expect(await asOwner('GET', `/api/packs/${packId}/review-wait`)).toEqual({ waiting: false });
  });

  it('with it offline the request is remembered, says so, and carries no text', async () => {
    r.close();
    await until(async () => !(await connected()));
    const res = await asOwner('POST', `/api/packs/${packId}/review-read`, { replyKey }, 202);
    expect(res.wait).toMatchObject({ waiting: true, workstationName: expect.any(String) });
    expect(await asOwner('GET', `/api/packs/${packId}/review-wait`)).toMatchObject({ waiting: true });
    const rows = await waits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reviewer_user_id: w.owner.id,
      workstation_id: w.workstationId,
      notified_at: null,
    });
    // a second request is the same wait
    await asOwner('POST', `/api/packs/${packId}/review-read`, { replyKey }, 202);
    expect(await waits()).toHaveLength(1);
    // only Owners and Admins can ask, and see someone else's wait as none
    expect(
      (
        await w.t.req('GET', `/api/packs/${packId}/review-wait`, {
          cookie: member.cookie,
          headers: { 'x-aom-org': w.owner.id },
        })
      ).status,
    ).toBe(403);
    // nothing about it is told yet
    expect(await deskItems()).toEqual([]);
  });

  it('tells the reviewer on their desk, once, when the author workstation comes online', async () => {
    r = await w.connectRunner();
    await until(async () => (await deskItems()).length === 1);
    const [item] = await deskItems();
    expect(item).toMatchObject({ addressee_user_id: w.owner.id, subkind: 'pack_review_ready' });
    expect(item.title).toContain('crew');
    expect(item.body).toContain('server keeps no copy');
    expect((await waits())[0].notified_at).not.toBeNull();
    expect(await asOwner('GET', `/api/packs/${packId}/review-wait`)).toEqual({ waiting: false });
    // coming online again does not tell them again
    r.close();
    await until(async () => !(await connected()));
    r = await w.connectRunner();
    await until(connected);
    await new Promise((res) => setTimeout(res, 200));
    expect(await deskItems()).toHaveLength(1);
  });

  it('a wait for a pack that is no longer an authored organization pack is dropped without a word', async () => {
    r.close();
    await until(async () => !(await connected()));
    await asOwner('POST', `/api/packs/${packId}/review-read`, { replyKey }, 202);
    expect(await waits()).toHaveLength(1);
    await q(`UPDATE packs SET visibility='private' WHERE id=$1`, [packId]);
    const before = (await deskItems()).length;
    r = await w.connectRunner();
    await until(connected);
    await new Promise((res) => setTimeout(res, 200));
    expect(await deskItems()).toHaveLength(before);
    await q(`UPDATE packs SET visibility='org' WHERE id=$1`, [packId]);
  });
});
