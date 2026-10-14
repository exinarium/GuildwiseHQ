import { ensureOrgInbox } from '../commands/mail-inboxes.ts';
import { rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `org-inboxes-2026-10` (backlog #67): every organisation has an inbound inbox address. New organisations get theirs
 * when they are created (`ensureOrgInbox` in sign-up and invitation acceptance); this gives the existing ones without
 * any inbox a "Main inbox" (`MailInboxCreated` by the system actor, the same event a person's "New inbox" writes).
 *
 * Unlike the other data migrations it is not recorded as done: it runs on every boot and only acts on organisations with
 * no inbox at all, so setting `AOM_INBOUND_DOMAIN` later and restarting creates the missing inboxes then. Without a
 * domain it does nothing (no address can be made). It never touches an organisation that already has an inbox, including
 * one a person switched off, and never creates a second one. A projection rebuild reproduces the result.
 */
export const ORG_INBOXES_MIGRATION = 'org-inboxes-2026-10';
const LOCK_ID = 7339;

export async function migrateOrgInboxes(env: DataMigrationEnv): Promise<{ created: number } | null> {
  const { pool, store, clock, log } = env;
  const domain = env.inboundDomain;
  if (!domain) return null;
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    const orgs = await rows<{ id: string }>(
      pool,
      `SELECT o.id FROM organizations o
        WHERE NOT EXISTS (SELECT 1 FROM mail_inboxes i WHERE i.org_id = o.id) ORDER BY o.created_at`,
    );
    let created = 0;
    for (const o of orgs)
      if (await withAppendTx(pool, (tx) => ensureOrgInbox({ store, clock }, tx, o.id, domain))) created++;
    if (created) log(`${ORG_INBOXES_MIGRATION}: ${created} organisation(s) got an inbound inbox`);
    return { created };
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    lock.release();
  }
}
