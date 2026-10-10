import { exec, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';

/**
 * Deleting the rows of one organization (and of the accounts that only existed in it) without a hand-kept table list:
 * the schema itself says what belongs to it.
 *
 * - a table with an `org_id` column loses the rows of the organization;
 * - a table with a `user_id` column loses the rows of the deleted accounts;
 * - any table with a foreign key to a table that loses rows loses the rows pointing at them (recursively), so
 *   project children, transcripts, runner commands, desk items, chats, support messages, installer sessions, ... all go;
 * - tables are emptied child-first by retrying on foreign-key violations until nothing is left to delete.
 *
 * A test (simulation-wipe.test.ts) scans every table for the organization's ids afterwards, so a table that this
 * discovery misses fails the build instead of leaking data.
 */

/** Tables never touched here: the event log is handled separately and the audit log is cleaned by event sequence. */
const SKIP = new Set(['events', 'schema_migrations', 'data_migrations']);

interface Fk {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

export async function deleteOrgRows(
  tx: Tx,
  orgId: string,
  userIds: string[],
): Promise<Record<string, number>> {
  const cols = await rows<{ t: string; c: string }>(
    tx,
    `SELECT c.table_name AS t, c.column_name AS c
       FROM information_schema.columns c JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public'`,
  );
  const tables = new Map<string, Set<string>>();
  for (const { t, c } of cols) {
    if (SKIP.has(t)) continue;
    if (!tables.has(t)) tables.set(t, new Set());
    tables.get(t)?.add(c);
  }
  const fks = await rows<Fk>(
    tx,
    `SELECT cl.relname AS "table", a.attname AS "column", rcl.relname AS "refTable", ra.attname AS "refColumn"
       FROM pg_constraint k
       JOIN pg_class cl ON cl.oid = k.conrelid AND cl.relnamespace = 'public'::regnamespace
       JOIN pg_class rcl ON rcl.oid = k.confrelid AND rcl.relnamespace = 'public'::regnamespace
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
       JOIN pg_attribute ra ON ra.attrelid = k.confrelid AND ra.attnum = k.confkey[1]
      WHERE k.contype = 'f' AND cardinality(k.conkey) = 1`,
  );

  // $1 = organization id, $2 = deleted user ids.
  const memo = new Map<string, string | null>();
  const visiting = new Set<string>();
  const pred = (table: string): string | null => {
    if (memo.has(table)) return memo.get(table) ?? null;
    if (visiting.has(table) || !tables.has(table)) return null;
    visiting.add(table);
    const own = tables.get(table) as Set<string>;
    const parts: string[] = [];
    if (table === 'organizations') parts.push('id = $1::uuid');
    if (table === 'users') parts.push('id = ANY($2::uuid[])');
    if (own.has('org_id')) parts.push('org_id = $1::uuid');
    if (own.has('user_id')) parts.push('user_id = ANY($2::uuid[])');
    for (const fk of fks) {
      if (fk.table !== table) continue;
      const parent = pred(fk.refTable);
      if (parent)
        parts.push(`"${fk.column}" IN (SELECT "${fk.refColumn}" FROM "${fk.refTable}" WHERE ${parent})`);
    }
    visiting.delete(table);
    const out = parts.length ? parts.join(' OR ') : null;
    memo.set(table, out);
    return out;
  };

  const counts: Record<string, number> = {};
  let pending = [...tables.keys()].filter((t) => pred(t) !== null);
  while (pending.length > 0) {
    const failed: string[] = [];
    for (const t of pending) {
      await exec(tx, 'SAVEPOINT wipe_row');
      try {
        const n = await exec(
          tx,
          `DELETE FROM "${t}" WHERE (${pred(t)}) AND $1::uuid IS NOT NULL AND $2::uuid[] IS NOT NULL`,
          [orgId, userIds],
        );
        await exec(tx, 'RELEASE SAVEPOINT wipe_row');
        if (n > 0) counts[t] = (counts[t] ?? 0) + n;
      } catch (err) {
        await exec(tx, 'ROLLBACK TO SAVEPOINT wipe_row');
        if ((err as { code?: string }).code !== '23503') throw err;
        failed.push(t);
      }
    }
    if (failed.length === pending.length)
      throw new Error(`wipe: foreign keys block the deletion of ${failed.join(', ')}`);
    pending = failed;
  }
  return counts;
}
