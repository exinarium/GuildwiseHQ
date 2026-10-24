import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

const ev = <T>(e: { event: unknown }) => e.event as T;

/**
 * Organization-wide provider keys (docs/ARCHITECTURE.md section 38.5): `org_providers` holds the facts about a key (never the key,
 * which is only ever a sealed copy per workstation in `org_provider_key_shares`, outside the event store) and the cap state.
 */
export const providerKeyProjectors: Record<string, Projector> = {
  OrgModelPriceSet: async (tx, e) => {
    const p = ev<EventOf<'OrgModelPriceSet'>>(e).payload;
    await exec(
      tx,
      `INSERT INTO org_model_prices (org_id, provider, model, input_per_mtok, output_per_mtok, cache_read_per_mtok, set_by, set_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id, provider, model) DO UPDATE
         SET input_per_mtok = EXCLUDED.input_per_mtok, output_per_mtok = EXCLUDED.output_per_mtok,
             cache_read_per_mtok = EXCLUDED.cache_read_per_mtok, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
      [p.orgId, p.provider, p.model, p.inputPerMtok, p.outputPerMtok, p.cacheReadPerMtok, p.by, e.createdAt],
    );
  },

  OrgModelPriceRemoved: async (tx, e) => {
    const p = ev<EventOf<'OrgModelPriceRemoved'>>(e).payload;
    await exec(tx, 'DELETE FROM org_model_prices WHERE org_id=$1 AND provider=$2 AND model=$3', [
      p.orgId,
      p.provider,
      p.model,
    ]);
  },

  OrgProviderKeySet: async (tx, e) => {
    const p = ev<EventOf<'OrgProviderKeySet'>>(e).payload;
    await exec(
      tx,
      `INSERT INTO org_providers (org_id, provider, configured, detail, base_url, models, set_by, set_at, key_generation)
       VALUES ($1, $2, true, $3, $4, $5, $6, $7, 1)
       ON CONFLICT (org_id, provider) DO UPDATE
         SET configured = true, detail = EXCLUDED.detail, base_url = EXCLUDED.base_url, models = EXCLUDED.models,
             set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at, key_generation = org_providers.key_generation + 1`,
      [p.orgId, p.provider, p.detail, p.baseUrl, JSON.stringify(p.models), p.by, e.createdAt],
    );
  },

  OrgProviderKeyRevoked: async (tx, e) => {
    const p = ev<EventOf<'OrgProviderKeyRevoked'>>(e).payload;
    await exec(
      tx,
      `UPDATE org_providers SET configured = false, detail = NULL, base_url = NULL, models = '[]'::jsonb WHERE org_id = $1 AND provider = $2`,
      [p.orgId, p.provider],
    );
  },

  OrgProviderCapSet: async (tx, e) => {
    const p = ev<EventOf<'OrgProviderCapSet'>>(e).payload;
    await exec(
      tx,
      `INSERT INTO org_providers (org_id, provider, cap_micros, cap_set_by, cap_set_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, provider) DO UPDATE
         SET cap_micros = EXCLUDED.cap_micros, cap_set_by = EXCLUDED.cap_set_by, cap_set_at = EXCLUDED.cap_set_at,
             cap_warned_month = CASE WHEN $6::boolean OR EXCLUDED.cap_micros IS NULL THEN NULL ELSE org_providers.cap_warned_month END,
             cap_paused_month = CASE WHEN $7::boolean OR EXCLUDED.cap_micros IS NULL THEN NULL ELSE org_providers.cap_paused_month END,
             cap_override_month = CASE WHEN EXCLUDED.cap_micros IS NULL THEN NULL ELSE org_providers.cap_override_month END,
             cap_desk_item_id = CASE WHEN $7::boolean OR EXCLUDED.cap_micros IS NULL THEN NULL ELSE org_providers.cap_desk_item_id END`,
      [p.orgId, p.provider, p.monthlyMicros, p.by, e.createdAt, p.clearWarned, p.clearPaused],
    );
  },

  OrgProviderCapThresholdReached: async (tx, e) => {
    const p = ev<EventOf<'OrgProviderCapThresholdReached'>>(e).payload;
    if (p.level === 'warning')
      await exec(tx, 'UPDATE org_providers SET cap_warned_month = $3 WHERE org_id = $1 AND provider = $2', [
        p.orgId,
        p.provider,
        p.month,
      ]);
    else
      await exec(
        tx,
        `UPDATE org_providers SET cap_warned_month = $3, cap_paused_month = $3, cap_desk_item_id = $4 WHERE org_id = $1 AND provider = $2`,
        [p.orgId, p.provider, p.month, p.deskItemId ?? null],
      );
  },

  OrgProviderCapOverridden: async (tx, e) => {
    const p = ev<EventOf<'OrgProviderCapOverridden'>>(e).payload;
    await exec(
      tx,
      'UPDATE org_providers SET cap_override_month = $3, cap_desk_item_id = NULL WHERE org_id = $1 AND provider = $2',
      [p.orgId, p.provider, p.month],
    );
  },
};
