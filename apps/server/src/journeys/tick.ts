import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { enterServerStep } from './enter.ts';
import { fireDueWaits, resolveFormWait } from './waits.ts';
import { callDue } from './webhook-calls.ts';

/**
 * The journey timers and server-run steps, one pass: enter steps that have no wait or call yet, resolve form waits whose
 * link was used, fire due waits, send due webhook calls. Everything is a table row, moved in its own transaction, so a
 * restart loses nothing and a second pass does nothing twice.
 */
export async function journeyTick(ctx: Ctx, only?: { projectId: string }): Promise<number> {
  const pid = only?.projectId ?? null;
  let n = 0;
  const attempt = async (what: string, fn: () => Promise<boolean | number>): Promise<void> => {
    try {
      const r = await fn();
      if (r) n += typeof r === 'number' ? r : 1;
    } catch (err) {
      ctx.log.error({ err, what }, 'journey tick step failed');
    }
  };
  const enter = await rows(
    ctx.pool,
    `SELECT r.instance_id, r.visit FROM journey_step_runs r JOIN journey_instances i ON i.id = r.instance_id
      WHERE r.status='waiting' AND i.status='waiting' AND i.current_visit = r.visit AND ($1::uuid IS NULL OR i.project_id = $1)
        AND NOT EXISTS (SELECT 1 FROM journey_waits w WHERE w.instance_id = r.instance_id AND w.visit = r.visit)
        AND NOT EXISTS (SELECT 1 FROM journey_webhook_calls c WHERE c.instance_id = r.instance_id AND c.visit = r.visit)
      ORDER BY r.entered_at LIMIT 100`,
    [pid],
  );
  for (const r of enter)
    await attempt(`enter:${r.instance_id}:${r.visit}`, () => enterServerStep(ctx, r.instance_id, r.visit));
  const forms = await rows(
    ctx.pool,
    `SELECT w.id FROM journey_waits w JOIN form_client_links l ON l.id = w.link_id
      JOIN journey_instances i ON i.id = w.instance_id
      WHERE w.kind='form' AND w.status IN ('open','escalated') AND l.used_by_submission IS NOT NULL
        AND i.status='waiting' AND i.current_visit = w.visit
        AND ($1::uuid IS NULL OR w.project_id = $1) LIMIT 100`,
    [pid],
  );
  for (const f of forms) await attempt(`form:${f.id}`, () => resolveFormWait(ctx, f.id));
  await attempt('due waits', () => fireDueWaits(ctx, pid));
  await attempt('due calls', () => callDue(ctx, pid));
  return n;
}
