import type { JourneyDefinition } from '@aom/shared';
import {
  alert,
  ev,
  loadDefinition,
  lockInstance,
  Refused,
  REASON,
} from '../commands/journey-runtime.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { EXECUTORS } from './executors.ts';
import { manualWait } from './waits.ts';

const configured = (def: JourneyDefinition, stepId: string): boolean => {
  const s = def.steps.find((x) => x.id === stepId);
  if (!s) return false;
  if (s.kind === 'wait') return !!s.waitFor;
  if (s.kind === 'gate') return !!s.approver;
  return s.kind === 'webhook_call';
};

/**
 * Enters a wait, gate or webhook-call step that has no wait/call row yet (the run is `waiting`). A refusal becomes a
 * `JourneyStepRefused` + stuck + desk alert, exactly like a workflow step that cannot start. An unconfigured placeholder
 * (an instance started before waits existed) becomes a `manual` wait that only Continue ends.
 */
export async function enterServerStep(ctx: Ctx, instanceId: string, visit: number): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const inst = await lockInstance(tx, instanceId, visit, 'waiting');
    if (!inst) return false;
    const run = await one(tx, 'SELECT * FROM journey_step_runs WHERE instance_id=$1 AND visit=$2', [instanceId, visit]);
    if (!run || run.status !== 'waiting') return false;
    const has =
      (await one(tx, 'SELECT 1 AS x FROM journey_waits WHERE instance_id=$1 AND visit=$2', [instanceId, visit])) ||
      (await one(tx, 'SELECT 1 AS x FROM journey_webhook_calls WHERE instance_id=$1 AND visit=$2', [instanceId, visit]));
    if (has) return false;
    const def = await loadDefinition(tx, inst.journey_id, inst.journey_version);
    const step = def.steps.find((s) => s.id === run.step_id);
    if (!step || step.kind === 'workflow') return false;
    try {
      const events = configured(def, run.step_id)
        ? await EXECUTORS[step.kind](ctx, tx, inst, def, run)
        : manualWait(inst, run, ctx.clock.now());
      await ctx.store.append(events, { tx });
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      await refuse(ctx, tx, inst, run, err);
    }
    return true;
  });
}

async function refuse(ctx: Ctx, tx: Parameters<Parameters<typeof withAppendTx>[1]>[0], inst: Row, run: Row, err: Refused) {
  const record = (await one(tx, 'SELECT display_name FROM journey_records WHERE id=$1', [inst.record_id])) as Row;
  const a = alert(
    inst,
    `Journey for ${record.display_name}: step "${run.step_id}" could not start`,
    `${REASON[err.reason].charAt(0).toUpperCase()}${REASON[err.reason].slice(1)}. ${err.detail} Fix the cause and acknowledge this notice: the step is tried again.`,
  );
  await ctx.store.append(
    [
      ev(inst, {
        type: 'JourneyStepRefused',
        payload: { instanceId: inst.id, visit: run.visit, reason: err.reason, detail: err.detail.slice(0, 1000), deskItemId: a.deskItemId },
      }),
      ev(inst, {
        type: 'JourneyInstanceStuck',
        payload: { instanceId: inst.id, visit: run.visit, reason: `Step "${run.step_id}" could not start: ${err.detail}`.slice(0, 1000) },
      }),
      a.event,
    ],
    { tx },
  );
}
