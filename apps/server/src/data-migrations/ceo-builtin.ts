import { CEO_ROLE_KEY, streamId } from '@aom/shared';
import { ceoProvisionEvents } from '../ceo/provision.ts';
import { loadCeo } from '../ceo/state.ts';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { exec, one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `ceo-builtin-2026-10` (docs/design/ceo-front-door.md section 2.3): the CEO is built in. Every organization gets one when
 * it has none (also when the old Disable retired it: the old agent stays retired, its history kept); a CEO that is still in
 * its training period graduates ("built-in CEO, no training"). (A CEO on an older role version follows the current one
 * through `rebaseAgentsToCurrentRoles` at boot.) An organization that already has an active CEO (the
 * production case) keeps that agent, its memories, policy and settings untouched.
 *
 * Idempotent and safe to run at every boot: each step only acts on the state it fixes, so a second run appends nothing
 * (an organization created later already has its CEO from the same append). The first run is recorded in
 * `data_migrations` for the audit trail.
 */
export const CEO_BUILTIN_MIGRATION = 'ceo-builtin-2026-10';

export interface CeoBuiltinReport {
  provisioned: string[];
  graduated: string[];
}

export async function migrateCeoBuiltin(env: DataMigrationEnv): Promise<CeoBuiltinReport> {
  const { pool, store, clock, log } = env;
  const report: CeoBuiltinReport = { provisioned: [], graduated: [] };
  const orgs = await rows<{ id: string; owner_user_id: string; simulation: boolean }>(
    pool,
    'SELECT id, owner_user_id, simulation FROM organizations ORDER BY created_at, id',
  );
  for (const o of orgs) {
    await withAppendTx(pool, async (tx) => {
      const events: AppendInput[] = [];
      const live = await one<{ id: string }>(
        tx,
        `SELECT id FROM agents WHERE org_id=$1 AND role_key=$2 AND status <> 'retired'`,
        [o.id, CEO_ROLE_KEY],
      );
      if (!live) {
        const provision = await ceoProvisionEvents(tx, { pool }, o.id, o.owner_user_id, {
          simulation: o.simulation,
        });
        if (provision.length) {
          events.push(...provision);
          report.provisioned.push(o.id);
        }
      } else {
        const ceo = await loadCeo(tx, o.id);
        if (ceo?.training.on) {
          events.push({
            streamId: streamId.ceo(o.id),
            event: {
              type: 'CeoTrainingChanged',
              payload: {
                orgId: o.id,
                action: 'graduate',
                training: { ...ceo.training, on: false, graduatedAt: clock.now().toISOString() },
                by: o.owner_user_id,
                reason: 'built-in CEO, no training',
                scores: [],
              },
            },
            actor: SYSTEM_ACTOR,
            scope: orgScope(o.id),
          });
          report.graduated.push(o.id);
        }
      }
      if (events.length) await store.append(events, { tx });
    });
  }
  if (report.provisioned.length || report.graduated.length)
    log(
      `${CEO_BUILTIN_MIGRATION}: ${report.provisioned.length} CEO(s) provisioned, ${report.graduated.length} graduated`,
    );
  await exec(
    pool,
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
    [CEO_BUILTIN_MIGRATION, clock.now(), JSON.stringify(report)],
  );
  return report;
}
