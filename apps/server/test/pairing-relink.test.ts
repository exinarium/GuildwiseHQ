import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, pairWorkstation, type World } from './helpers/world.ts';

/**
 * UAT 1.10.0 finding 5: re-running the installer with a fresh link created a NEW workstation, so the old one's DevOps
 * engineer was retired and the new one started with every switch off. A runner that proves its current workstation now
 * re-links that same workstation when the link is from the same account; anything else is refused (code not spent) so
 * the installer can ask first, and a link of one account never takes over another account's workstation.
 */
let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const body = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  name: 'Desk',
  platform: 'linux',
  hostname: 'host-Desk',
  runnerVersion: '0.0.0-test',
  ...extra,
});

describe('re-linking the same workstation', () => {
  it('a fresh link of the same account keeps the workstation, its DevOps engineer, switches and agents', async () => {
    const { t, owner } = w;
    const first = await pairWorkstation(t, owner, 'Relink');
    const engineers = await q(`SELECT id, status FROM agents WHERE is_devops AND workstation_id=$1`, [
      first.workstationId,
    ]);
    expect(engineers.length).toBeGreaterThan(0);
    await ok(
      t.req('PATCH', `/api/workstations/${first.workstationId}/devops-access`, {
        cookie: owner.cookie,
        body: { allowInstall: true },
      }),
    );
    const before = await q(`SELECT count(*)::int AS n FROM workstations WHERE user_id=$1`, [owner.id]);
    const { code } = await ok<{ code: string }>(
      t.req('POST', '/api/workstations/pairing-codes', { cookie: owner.cookie }),
      201,
    );
    const r = await t.req('POST', '/api/runner/pair', {
      body: body(code, { previous: { workstationId: first.workstationId, runnerToken: first.runnerToken } }),
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ workstationId: first.workstationId, relinked: true });
    expect(r.body.runnerToken).not.toBe(first.runnerToken);
    const ws = await q(`SELECT status, token_hash, devops_access FROM workstations WHERE id=$1`, [
      first.workstationId,
    ]);
    expect(ws[0]).toMatchObject({ status: 'active', token_hash: sha(r.body.runnerToken) });
    expect(ws[0]?.devops_access.allowInstall).toBe(true);
    expect(
      await q(`SELECT id, status FROM agents WHERE is_devops AND workstation_id=$1`, [first.workstationId]),
    ).toEqual(engineers);
    expect(await q(`SELECT count(*)::int AS n FROM workstations WHERE user_id=$1`, [owner.id])).toEqual(
      before,
    );
    expect(r.body.setupOffers).toBeDefined();
  });

  it('a link of another account is refused without spending the code, and never takes the workstation over', async () => {
    const { t, owner } = w;
    const mine = await pairWorkstation(t, owner, 'Mine');
    const other = await t.userSession(uniqueEmail('other-account'));
    const { code } = await ok<{ code: string }>(
      t.req('POST', '/api/workstations/pairing-codes', { cookie: other.cookie }),
      201,
    );
    const refused = await t.req('POST', '/api/runner/pair', {
      body: body(code, { previous: { workstationId: mine.workstationId, runnerToken: mine.runnerToken } }),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'relink_refused',
      details: { reason: 'other_account' },
    });
    const still = await q(`SELECT user_id, status, token_hash FROM workstations WHERE id=$1`, [
      mine.workstationId,
    ]);
    expect(still[0]).toMatchObject({
      user_id: owner.id,
      status: 'active',
      token_hash: sha(mine.runnerToken),
    });
    // the person said yes: the same code makes a NEW workstation for the other account; the old one is untouched
    const fresh = await t.req('POST', '/api/runner/pair', {
      body: body(code, {
        previous: { workstationId: mine.workstationId, runnerToken: mine.runnerToken },
        newWorkstation: true,
      }),
    });
    expect(fresh.status).toBe(200);
    expect(fresh.body.workstationId).not.toBe(mine.workstationId);
    expect(fresh.body.relinked).toBeUndefined();
    expect(
      (await q(`SELECT user_id FROM workstations WHERE id=$1`, [fresh.body.workstationId]))[0]?.user_id,
    ).toBe(other.id);
    expect(
      (await q(`SELECT user_id, status FROM workstations WHERE id=$1`, [mine.workstationId]))[0],
    ).toMatchObject({
      user_id: owner.id,
      status: 'active',
    });
  });

  it('without a valid token nothing is re-linked and nothing about the workstation is revealed', async () => {
    const { t, owner } = w;
    const mine = await pairWorkstation(t, owner, 'Guarded');
    const { code } = await ok<{ code: string }>(
      t.req('POST', '/api/workstations/pairing-codes', { cookie: owner.cookie }),
      201,
    );
    const r = await t.req('POST', '/api/runner/pair', {
      body: body(code, { previous: { workstationId: mine.workstationId, runnerToken: 'aomr_guessed' } }),
    });
    expect(r.status).toBe(409);
    expect(r.body.error.details).toEqual({ reason: 'gone' });
    expect(JSON.stringify(r.body)).not.toContain('Guarded');
    expect(
      (await q(`SELECT token_hash FROM workstations WHERE id=$1`, [mine.workstationId]))[0]?.token_hash,
    ).toBe(sha(mine.runnerToken));
  });

  it('an unlinked workstation is not brought back: the runner must ask for a new one', async () => {
    const { t, owner } = w;
    const gone = await pairWorkstation(t, owner, 'Unlinked');
    await ok(t.req('POST', `/api/workstations/${gone.workstationId}/unlink`, { cookie: owner.cookie }));
    const { code } = await ok<{ code: string }>(
      t.req('POST', '/api/workstations/pairing-codes', { cookie: owner.cookie }),
      201,
    );
    const r = await t.req('POST', '/api/runner/pair', {
      body: body(code, { previous: { workstationId: gone.workstationId, runnerToken: gone.runnerToken } }),
    });
    expect(r.status).toBe(409);
    expect(r.body.error.details).toEqual({ reason: 'gone' });
  });
});
