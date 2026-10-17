import { DEFAULT_CEO_MODELS, OLD_CEO_MODELS, streamId } from '@aom/shared';
import { orgOwnerId } from '../auth/org-context.ts';
import { loadCeo } from '../ceo/state.ts';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { exec, one, rows as selectRows } from '../db/sql.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `ceo-models-2026-10` (Lean Team v3): the CEO runs on Sonnet for wake, review and chat, and on Opus for the `handover`.
 * Organizations created before have the old defaults stored (wake Sonnet, review and chat Opus). This moves each purpose
 * to the new default only where the stored model and effort still equal the old default: an owner's own choice stays. The
 * handover model is added when missing. One `CeoSettingsChanged` per organization that changes, by the system on behalf of
 * the organization's owner. Idempotent; recorded once in `data_migrations`.
 */
export const CEO_MODELS_MIGRATION = 'ceo-models-2026-10';

export interface CeoModelsReport {
  changed: Array<{ orgId: string; purposes: string[] }>;
}

type Pair = { model: string; effort: string };
const same = (a: Pair | undefined, b: Pair) => !!a && a.model === b.model && a.effort === b.effort;

export async function migrateCeoModels(env: DataMigrationEnv): Promise<CeoModelsReport | null> {
  const { pool, store, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [CEO_MODELS_MIGRATION])) return null;
  const report: CeoModelsReport = { changed: [] };
  const orgs = await selectRows<{ org_id: string; settings: { models?: Record<string, Pair> } }>(
    pool,
    'SELECT org_id, settings FROM ceo_settings ORDER BY org_id',
  );
  for (const o of orgs) {
    const stored = o.settings?.models ?? {};
    const next: Record<string, Pair> = {};
    const purposes: string[] = [];
    for (const k of ['wake', 'review', 'chat'] as const) {
      if (same(stored[k], OLD_CEO_MODELS[k]) && !same(stored[k], DEFAULT_CEO_MODELS[k])) {
        next[k] = DEFAULT_CEO_MODELS[k];
        purposes.push(k);
      }
    }
    if (!stored.handover) {
      next.handover = DEFAULT_CEO_MODELS.handover;
      purposes.push('handover');
    }
    if (purposes.length === 0) continue;
    const ceo = await loadCeo(pool, o.org_id);
    const by = await orgOwnerId(pool, o.org_id);
    if (!ceo || !by) continue;
    await store.append([
      {
        streamId: streamId.ceo(o.org_id),
        event: {
          type: 'CeoSettingsChanged',
          payload: {
            orgId: o.org_id,
            settings: { ...ceo.settings, models: { ...ceo.settings.models, ...next } },
            by,
          },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(o.org_id),
      },
    ]);
    report.changed.push({ orgId: o.org_id, purposes });
    log(`${CEO_MODELS_MIGRATION}: ${o.org_id} moved ${purposes.join(', ')}`);
  }
  await exec(
    pool,
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
    [CEO_MODELS_MIGRATION, clock.now(), JSON.stringify(report)],
  );
  return report;
}
