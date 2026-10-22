import { streamId } from '@aom/shared';
import { orgOwnerId } from '../auth/org-context.ts';
import { loadCeo } from '../ceo/state.ts';
import { agentActor, orgScope, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { exec, one, rows as selectRows } from '../db/sql.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `ceo-authority-2026-10`: the CEO releases loops, parks and stop-loss items on its own. The new default policy gives those
 * desk keys the mode `decide`; an organization created before has a stored policy with `escalation:*` = recommend, so the
 * keys are added once, as a new policy version by the system on behalf of the owner. A key the owner already set is left
 * alone, and since this runs only once the owner can take it back in the Authority tab. (New action classes such as
 * `card.move` need no migration: a class missing from a stored policy takes its default, `withNewClasses`.)
 */
export const CEO_AUTHORITY_MIGRATION = 'ceo-authority-2026-10';

const LOOP_DESK_KEYS = [
  'escalation:loop_parked',
  'escalation:repeat_question',
  'escalation:stop_loss',
  'escalation:loop_backoff',
  'question:stop_loss',
  'question:repeat_question',
  'alert:loop_backoff',
  'alert:loop_parked',
] as const;

export async function migrateCeoAuthority(env: DataMigrationEnv): Promise<{ changed: string[] } | null> {
  const { pool, store, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [CEO_AUTHORITY_MIGRATION])) return null;
  const report = { changed: [] as string[] };
  const orgs = await selectRows<{ org_id: string }>(pool, 'SELECT org_id FROM ceo_settings ORDER BY org_id');
  for (const o of orgs) {
    const ceo = await loadCeo(pool, o.org_id);
    const by = await orgOwnerId(pool, o.org_id);
    if (!ceo || !by) continue;
    const missing = LOOP_DESK_KEYS.filter((k) => !(k in ceo.policy.desk));
    if (missing.length === 0) continue;
    const next = {
      ...ceo.policy,
      version: ceo.policyVersion + 1,
      desk: { ...ceo.policy.desk, ...Object.fromEntries(missing.map((k) => [k, 'decide' as const])) },
    };
    await store.append([
      {
        streamId: streamId.ceo(o.org_id),
        event: {
          type: 'CeoPolicyChanged',
          payload: {
            orgId: o.org_id,
            version: next.version,
            previousVersion: ceo.policyVersion,
            policy: next,
            by,
            note: 'the CEO releases loops, parks and stop-loss items on its own (new default; take it back in the Authority tab)',
          },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(o.org_id),
      },
    ]);
    report.changed.push(o.org_id);
    log(`${CEO_AUTHORITY_MIGRATION}: ${o.org_id} may release loops on its own`);
  }
  await exec(
    pool,
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
    [CEO_AUTHORITY_MIGRATION, clock.now(), JSON.stringify(report)],
  );
  return report;
}

/**
 * `ceo-decision-dedupe-2026-10`: the CEO's answer used to add a second, informational `ceo_decision` item next to the
 * question it answered. Those still open next to an already resolved question are merged: the decision moves onto the
 * resolved question (`CeoDecisionRecorded`, open for the owner's review there) and the duplicate is dismissed, so the owner
 * sees one item, not two. Duplicates the owner already reviewed are closed and left as they are. Idempotent.
 */
export const CEO_DECISION_DEDUPE_MIGRATION = 'ceo-decision-dedupe-2026-10';

export async function migrateCeoDecisionDedupe(
  env: DataMigrationEnv,
): Promise<{ merged: number; skipped: number } | null> {
  const { pool, store, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [CEO_DECISION_DEDUPE_MIGRATION]))
    return null;
  const dupes = await selectRows(
    pool,
    `SELECT dup.*, q.status AS q_status, q.data AS q_data, q.project_id AS q_project_id
       FROM desk_items dup JOIN desk_items q ON q.id = (dup.data->'ceoDecision'->>'questionItemId')::uuid
      WHERE dup.subkind = 'ceo_decision' AND dup.status = 'open' AND q.status <> 'open'
      ORDER BY dup.created_at, dup.id`,
  );
  const report = { merged: 0, skipped: 0 };
  for (const d of dupes) {
    const dec = d.data?.ceoDecision as Record<string, any> | undefined;
    const qid = dec?.questionItemId as string | undefined;
    if (!dec || !qid || !dec.ceoAgentId) {
      report.skipped++;
      continue;
    }
    const scope = d.q_project_id ? projectScope(d.org_id, d.q_project_id) : orgScope(d.org_id);
    await store.append([
      // The decision moves onto the resolved question (unless it carries one already), ...
      ...(d.q_data?.ceoDecision
        ? []
        : [
            {
              streamId: streamId.desk(qid),
              event: {
                type: 'CeoDecisionRecorded' as const,
                payload: {
                  orgId: d.org_id,
                  deskItemId: qid,
                  ceoAgentId: dec.ceoAgentId,
                  ceoName: dec.ceoName ?? 'CEO',
                  class: dec.class ?? 'desk.answer_question',
                  source: dec.source === 'chain' ? ('chain' as const) : ('act' as const),
                  actionId: dec.actionId ?? null,
                  question: String(dec.question ?? '').slice(0, 1000),
                  decision: String(dec.decision ?? '').slice(0, 4000),
                  reason: String(dec.reason ?? '').slice(0, 4000),
                  confidence: dec.confidence ?? null,
                },
              },
              actor: agentActor(dec.ceoAgentId),
              scope,
            },
          ]),
      // ...and the second card closes.
      {
        streamId: streamId.desk(d.id),
        event: {
          type: 'DeskItemResolved' as const,
          payload: {
            deskItemId: d.id,
            resolution: 'dismissed' as const,
            note: 'The CEO decision now shows on the resolved question itself.',
            by: { kind: 'system' as const },
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      },
    ]);
    report.merged++;
  }
  log(
    `${CEO_DECISION_DEDUPE_MIGRATION}: merged ${report.merged} duplicate CEO decision(s), skipped ${report.skipped}`,
  );
  await exec(
    pool,
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
    [CEO_DECISION_DEDUPE_MIGRATION, clock.now(), JSON.stringify(report)],
  );
  return report;
}
