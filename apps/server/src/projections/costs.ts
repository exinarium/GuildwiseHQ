import { costUsdMicros, type EventOf, isCostUnknown } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

const ev = <T>(e: { event: unknown }) => e.event as T;

/**
 * Cost tracking (docs/design/restructure.md roadmap): one `shift_costs` row per ended shift, priced by the default table
 * in `packages/shared/src/costs` unless the event carries the price it was stamped with. Runs after `shiftProjectors`
 * (the shifts row already holds the model and the tokens). Budgets: the monthly amount and the month keys that say
 * which month a warning, a pause or an override belongs to.
 */
export const costProjectors: Record<string, Projector> = {
  ShiftEnded: async (tx, e) => {
    const p = ev<EventOf<'ShiftEnded'>>(e).payload;
    const s = await one(
      tx,
      `SELECT s.org_id, s.agent_id, CASE WHEN s.kind = 'chat' AND ag.role_key = 'ceo' THEN 'ceo_chat' ELSE s.kind END AS kind, s.card_id, s.model,
              COALESCE(s.project_id, c.project_id, bt.project_id) AS project_id, bt.phase_id
         FROM shifts s
         LEFT JOIN agents ag ON ag.id = s.agent_id
         LEFT JOIN cards c ON c.id = s.card_id
         LEFT JOIN ba_tasks bt ON bt.id = s.ba_task_id
        WHERE s.id = $1`,
      [p.shiftId],
    );
    if (!s) return;
    const model = p.usage.model ?? s.model;
    const cost = p.costMicros ?? costUsdMicros(model, { ...p.usage });
    await exec(
      tx,
      `INSERT INTO shift_costs (shift_id, org_id, agent_id, project_id, card_id, phase_id, kind, model,
         tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost_usd_micros, reported_usd_micros, ended_at, cost_stamped,
         key_source, key_provider, cost_unknown)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (shift_id) DO NOTHING`,
      [
        p.shiftId,
        s.org_id,
        s.agent_id,
        s.project_id ?? null,
        s.card_id ?? null,
        s.phase_id ?? null,
        s.kind,
        model,
        p.usage.inputTokens,
        p.usage.outputTokens,
        p.usage.cacheReadTokens,
        p.usage.cacheWriteTokens,
        cost,
        p.usage.costUsd === undefined ? null : Math.round(p.usage.costUsd * 1_000_000),
        e.createdAt,
        p.costMicros !== undefined,
        p.usage.keySource ?? null,
        p.usage.keyProvider ?? null,
        // a shift on a stored key whose model has no price: counted as unknown, not as free (the cap cannot count it)
        p.usage.keySource !== undefined && isCostUnknown(model),
      ],
    );
  },

  /** Usage that arrived after the shift was closed at zero: tokens and price are filled in (a stamped price is kept). */
  ShiftUsageRecorded: async (tx, e) => {
    const p = ev<EventOf<'ShiftUsageRecorded'>>(e).payload;
    const row = await one(
      tx,
      `SELECT model, cost_stamped, tokens_input + tokens_output + tokens_cache_read + tokens_cache_write AS had
         FROM shift_costs WHERE shift_id=$1`,
      [p.shiftId],
    );
    if (!row || Number(row.had) > 0) return;
    const model = p.usage.model ?? row.model;
    await exec(
      tx,
      `UPDATE shift_costs SET model=$2, tokens_input=$3, tokens_output=$4, tokens_cache_read=$5, tokens_cache_write=$6,
              cost_usd_micros=$7, reported_usd_micros=$8,
              key_source = COALESCE(key_source, $9), key_provider = COALESCE(key_provider, $10)
        WHERE shift_id=$1`,
      [
        p.shiftId,
        model,
        p.usage.inputTokens,
        p.usage.outputTokens,
        p.usage.cacheReadTokens,
        p.usage.cacheWriteTokens,
        p.costMicros ?? costUsdMicros(model, { ...p.usage }),
        p.usage.costUsd === undefined ? null : Math.round(p.usage.costUsd * 1_000_000),
        p.usage.keySource ?? null,
        p.usage.keyProvider ?? null,
      ],
    );
  },

  OrgCostSettingsChanged: async (tx, e) => {
    const p = ev<EventOf<'OrgCostSettingsChanged'>>(e).payload;
    await exec(tx, 'UPDATE organizations SET currency=$2, usd_rate=$3 WHERE id=$1', [
      p.orgId,
      p.currency,
      p.usdRate,
    ]);
  },

  OrgValueSettingsChanged: async (tx, e) => {
    const p = ev<EventOf<'OrgValueSettingsChanged'>>(e).payload;
    await exec(tx, 'UPDATE organizations SET value_settings=$2 WHERE id=$1', [
      p.orgId,
      JSON.stringify({ hoursByType: p.hoursByType, hourlyValue: p.hourlyValue }),
    ]);
  },

  ProjectBudgetSet: async (tx, e) => {
    const p = ev<EventOf<'ProjectBudgetSet'>>(e).payload;
    await exec(
      tx,
      `UPDATE projects SET budget_micros = $2, budget_set_by = $3, budget_set_at = $4,
              budget_warned_month = CASE WHEN $5::boolean OR $2::bigint IS NULL THEN NULL ELSE budget_warned_month END,
              budget_paused_month = CASE WHEN $6::boolean OR $2::bigint IS NULL THEN NULL ELSE budget_paused_month END,
              budget_override_month = CASE WHEN $2::bigint IS NULL THEN NULL ELSE budget_override_month END,
              budget_desk_item_id = CASE WHEN $6::boolean OR $2::bigint IS NULL THEN NULL ELSE budget_desk_item_id END
        WHERE id = $1`,
      [p.projectId, p.monthlyMicros, p.by, e.createdAt, p.clearWarned, p.clearPaused],
    );
  },

  ProjectBudgetThresholdReached: async (tx, e) => {
    const p = ev<EventOf<'ProjectBudgetThresholdReached'>>(e).payload;
    if (p.level === 'warning')
      await exec(tx, 'UPDATE projects SET budget_warned_month = $2 WHERE id = $1', [p.projectId, p.month]);
    else
      await exec(
        tx,
        `UPDATE projects SET budget_warned_month = $2, budget_paused_month = $2, budget_desk_item_id = $3 WHERE id = $1`,
        [p.projectId, p.month, p.deskItemId ?? null],
      );
  },

  ProjectBudgetOverridden: async (tx, e) => {
    const p = ev<EventOf<'ProjectBudgetOverridden'>>(e).payload;
    await exec(
      tx,
      'UPDATE projects SET budget_override_month = $2, budget_desk_item_id = NULL WHERE id = $1',
      [p.projectId, p.month],
    );
  },
};
