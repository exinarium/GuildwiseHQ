import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections, unsavedCascadeTargets } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const count = async (sql: string, p: unknown[] = []) => Number((await q(sql, p))[0]?.n);

describe('projections:rebuild keeps operational data', () => {
  it('no table that TRUNCATE ... CASCADE would empty is left unsaved', async () => {
    expect(await unsavedCascadeTargets(w.t.app.ctx.pool)).toEqual([]);
  });

  it('billing, support, verification, reset, API key and cloud workstation rows survive a rebuild', async () => {
    const uid = w.owner.id;
    const org = (await q('SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1', [uid]))[0]
      ?.org_id as string;
    expect(org).toBeTruthy();

    await q(
      `INSERT INTO billing_subscriptions (org_id, plan_key, status, price_usd_cents, card_brand, card_last4, created_at, updated_at)
       VALUES ($1, 'team', 'active', 2900, 'visa', '4242', now(), now())`,
      [org],
    );
    await q(
      `INSERT INTO billing_invoices (org_id, number, kind, description, usd_cents, status, issued_at)
       VALUES ($1, 'GW-2026-9001', 'subscription', 'Team', 2900, 'paid', now())`,
      [org],
    );
    await q(`INSERT INTO billing_profiles (org_id, company_name, updated_at) VALUES ($1, 'Acme', now())`, [
      org,
    ]);
    await q(
      `INSERT INTO email_verifications (user_id, token_hash, created_at, expires_at) VALUES ($1, 'h-ev', now(), now() + interval '1 day')`,
      [uid],
    );
    await q(
      `INSERT INTO password_resets (user_id, requested_by, token_hash, created_at, expires_at)
       VALUES ($1, $1, 'h-pr', now(), now() + interval '1 day')`,
      [uid],
    );
    const ticket = (
      await q(
        `INSERT INTO support_tickets (ref, kind, subject, user_id, org_id, contact_name, contact_email, created_at, updated_at, last_message_at)
         VALUES ('SUP-9001', 'billing', 'Help', $1, $2, 'O', 'o@example.com', now(), now(), now()) RETURNING id`,
        [uid, org],
      )
    )[0]?.id as string;
    const msg = (
      await q(
        `INSERT INTO support_messages (ticket_id, author, author_name, body, created_at)
         VALUES ($1, 'user', 'O', 'hi', now()) RETURNING id`,
        [ticket],
      )
    )[0]?.id as string;
    await q(
      `INSERT INTO support_attachments (ticket_id, message_id, mime, size, data, created_at)
       VALUES ($1, $2, 'image/png', 1, '\\x00', now())`,
      [ticket, msg],
    );
    await q(
      `INSERT INTO blog_api_keys (id, name, prefix, key_hash, scopes, created_at)
       VALUES (gen_random_uuid(), 'k', 'gw_', 'h-key', ARRAY['posts:write'], now())`,
    );
    await q(
      `INSERT INTO cloud_workstations (org_id, user_id, provider, name, config, created_at, updated_at)
       VALUES ($1, $2, 'ssh', 'vps', '{}', now(), now())`,
      [org, uid],
    );

    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);

    expect(
      await count('SELECT count(*) n FROM billing_subscriptions WHERE org_id = $1 AND card_last4 = $2', [
        org,
        '4242',
      ]),
    ).toBe(1);
    expect(
      await count(`SELECT count(*) n FROM billing_invoices WHERE org_id = $1 AND number = 'GW-2026-9001'`, [
        org,
      ]),
    ).toBe(1);
    expect(await count('SELECT count(*) n FROM billing_profiles WHERE org_id = $1', [org])).toBe(1);
    expect(
      await count(`SELECT count(*) n FROM email_verifications WHERE user_id = $1 AND token_hash = 'h-ev'`, [
        uid,
      ]),
    ).toBe(1);
    expect(
      await count(`SELECT count(*) n FROM password_resets WHERE user_id = $1 AND token_hash = 'h-pr'`, [uid]),
    ).toBe(1);
    expect(
      await count(
        'SELECT count(*) n FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.id = $1',
        [ticket],
      ),
    ).toBe(1);
    expect(
      await count('SELECT count(*) n FROM support_messages WHERE id = $1 AND ticket_id = $2', [msg, ticket]),
    ).toBe(1);
    expect(await count('SELECT count(*) n FROM support_attachments WHERE message_id = $1', [msg])).toBe(1);
    expect(await count(`SELECT count(*) n FROM blog_api_keys WHERE key_hash = 'h-key'`)).toBe(1);
    expect(
      await count(`SELECT count(*) n FROM cloud_workstations WHERE org_id = $1 AND name = 'vps'`, [org]),
    ).toBe(1);
    expect(
      await count(
        'SELECT count(*) n FROM billing_subscriptions s JOIN organizations o ON o.id = s.org_id WHERE s.org_id = $1',
        [org],
      ),
    ).toBe(1);
  });
});
