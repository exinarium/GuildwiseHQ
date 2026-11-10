import { hireDevopsForOrgIn } from '../commands/devops.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `missing-devops-2026-11`: active members that have no DevOps engineer on one of their active workstations serving the
 * organization (before GWP-110, the membership hook failed for a member with 2+ workstations and only logged a warning).
 * Each affected (member, organization) pair is repaired through `hireDevopsForOrgIn`, the hire path the membership hook
 * and invitation acceptance use. Additive only. A failing pair is logged and skipped; the migration never throws.
 */
export const MISSING_DEVOPS_MIGRATION = 'missing-devops-2026-11';

const LOCK_ID = 7354;

export interface MissingDevopsOrgReport {
  pairs: number;
  hired: number;
  failed: number;
  skipped: number;
}

export interface MissingDevopsReport {
  pairs: number;
  hired: number;
  failed: number;
  skipped: number;
  byOrg: Record<string, MissingDevopsOrgReport>;
}

export interface MissingDevopsPair {
  org_id: string;
  user_id: string;
  missing: number;
}

/** Read-only: the (member, organization) pairs with at least one serving workstation without an active DevOps engineer. */
export async function findMissingDevopsPairs(db: Queryable): Promise<MissingDevopsPair[]> {
  return rows<MissingDevopsPair>(
    db,
    `SELECT om.org_id, om.user_id, count(*)::int AS missing
       FROM org_members om
       JOIN organizations o ON o.id = om.org_id
       JOIN workstations w ON w.user_id = om.user_id AND w.status = 'active'
                          AND ${wsServesOrgSql('w', 'om.org_id')}
      WHERE om.status = 'active' AND o.status IN ('trial','active')
        AND NOT EXISTS (SELECT 1 FROM agents a
                         WHERE a.org_id = om.org_id AND a.workstation_id = w.id
                           AND a.is_devops AND a.status = 'active')
      GROUP BY om.org_id, om.user_id
      ORDER BY om.org_id, om.user_id`,
  );
}

export function formatMissingDevopsSummary(
  r: Pick<MissingDevopsReport, 'pairs' | 'hired' | 'failed' | 'skipped'>,
): string {
  return `${r.pairs} pair(s) found, ${r.hired} engineer(s) hired, ${r.failed} failed, ${r.skipped} skipped`;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function migrateMissingDevops(env: DataMigrationEnv): Promise<MissingDevopsReport | null> {
  const { pool, store, clock, log } = env;
  try {
    if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [MISSING_DEVOPS_MIGRATION]))
      return null;
    const lock = await pool.connect();
    try {
      await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
      if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [MISSING_DEVOPS_MIGRATION]))
        return null;
      const pairs = await findMissingDevopsPairs(pool);
      const report: MissingDevopsReport = { pairs: pairs.length, hired: 0, failed: 0, skipped: 0, byOrg: {} };
      for (const p of pairs) {
        const o = report.byOrg[p.org_id] ?? { pairs: 0, hired: 0, failed: 0, skipped: 0 };
        o.pairs++;
        report.byOrg[p.org_id] = o;
      }
      for (const [orgId, o] of Object.entries(report.byOrg))
        log(`${MISSING_DEVOPS_MIGRATION}: organization ${orgId}: ${o.pairs} affected member(s)`);
      for (const p of pairs) {
        const o = report.byOrg[p.org_id] as MissingDevopsOrgReport;
        try {
          const n = await withAppendTx(pool, (tx) => hireDevopsForOrgIn({ store }, tx, p.user_id, p.org_id));
          if (n > 0) {
            report.hired += n;
            o.hired += n;
          } else {
            // nothing hired (for example the organization has no devops role yet): retried on a later boot
            report.skipped++;
            o.skipped++;
          }
        } catch (err) {
          report.failed++;
          o.failed++;
          log(
            `${MISSING_DEVOPS_MIGRATION}: hire failed for member ${p.user_id} in organization ${p.org_id}: ${message(err)}`,
          );
        }
      }
      log(`${MISSING_DEVOPS_MIGRATION}: ${formatMissingDevopsSummary(report)}`);
      if (report.failed === 0 && report.skipped === 0)
        await exec(
          pool,
          `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
          [MISSING_DEVOPS_MIGRATION, clock.now(), JSON.stringify(report)],
        );
      return report;
    } finally {
      try {
        await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
      } finally {
        lock.release();
      }
    }
  } catch (err) {
    // a data migration that throws would stop the server from booting
    try {
      log(`${MISSING_DEVOPS_MIGRATION}: aborted: ${message(err)}`);
    } catch {
      // nothing more to do
    }
    return null;
  }
}
