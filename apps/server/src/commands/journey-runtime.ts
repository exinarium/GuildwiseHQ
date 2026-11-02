import { randomUUID } from 'node:crypto';
import {
  DESK_SUBKIND,
  expandRecordTemplate,
  fieldCatalogue,
  getJourneyStep,
  type JourneyDefinition,
  JourneyDefinitionSchema,
  MAX_INSTANCE_VISITS,
  MAX_STEP_VISITS,
  nextMove,
  streamId,
  type EventOf,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { resolveWorkflow } from '../catalogue/loader.ts';
import { enabledWorkflows } from '../catalogue/project-workflows.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { HttpError } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { createCardIn, workflowView } from './cards.ts';
import { cardMessage, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';

/**
 * Journey runtime. State lives in the projected `journey_step_runs` rows, not in a cursor: a `pending` run is a step whose
 * card is not started yet, an `open` run whose card has ended is a step to complete. Every transition runs in one
 * append transaction that locks the instance row and checks the visit and the run's status it expects, so a second pass,
 * a replay, a restart or a second server process does it once. Nothing is held in memory.
 */

type Refusal = EventOf<'JourneyStepRefused'>['payload']['reason'];
class Refused extends Error {
  constructor(
    readonly reason: Refusal,
    readonly detail: string,
  ) {
    super(detail);
  }
}

const REASON: Record<Refusal, string> = {
  not_enabled: 'the workflow is not enabled in the project',
  not_found: 'the workflow or project could not be found',
  not_member: 'the person who started the journey is no longer a member of the project',
  invalid_mapping: 'the card could not be filled in',
  visit_limit: 'the step ran too many times',
};

export async function loadDefinition(db: Queryable, journeyId: string, version: number): Promise<JourneyDefinition> {
  const r = await one(db, 'SELECT definition FROM journey_versions WHERE journey_id=$1 AND version=$2', [
    journeyId,
    version,
  ]);
  if (!r) throw new Error(`journey ${journeyId} version ${version} not found`);
  return JourneyDefinitionSchema.parse(r.definition);
}

const kindOf = (def: JourneyDefinition, stepId: string): 'workflow' | 'wait' | 'gate' =>
  getJourneyStep(def, stepId)?.kind ?? 'workflow';

function alert(
  inst: Row,
  title: string,
  body: string,
): { deskItemId: string; event: AppendInput } {
  const deskItemId = randomUUID();
  return {
    deskItemId,
    event: {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: DESK_SUBKIND.journeyStepRefused,
          title,
          body,
          options: [],
          blocking: false,
          pinned: false,
          projectId: inst.project_id,
          affectedCardIds: [],
          askedBy: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(inst.org_id, inst.project_id),
    },
  };
}

const ev = (inst: Row, event: AppendInput['event']): AppendInput => ({
  streamId: streamId.journeyInstance(inst.id),
  event,
  actor: SYSTEM_ACTOR,
  scope: projectScope(inst.org_id, inst.project_id),
});

/** Locks the instance and checks it is still where the caller expects. */
async function lockInstance(tx: Tx, instanceId: string, visit: number, status: string): Promise<Row | null> {
  const inst = await one(tx, 'SELECT * FROM journey_instances WHERE id=$1 FOR UPDATE', [instanceId]);
  if (!inst || inst.status !== status || inst.current_visit !== visit) return null;
  return inst;
}

/**
 * Ends the current run with `result` and moves along the matching handoff: the next step is entered, the instance
 * completes, or it is stuck with a desk alert. The caller holds the instance lock and has checked the run.
 */
async function advance(
  ctx: Ctx,
  tx: Tx,
  inst: Row,
  def: JourneyDefinition,
  run: Row,
  result: 'done' | 'cancelled' | 'skipped',
  card: Row | null,
): Promise<void> {
  const record = (await one(tx, 'SELECT * FROM journey_records WHERE id=$1', [inst.record_id])) as Row;
  const visits = Number(
    (
      await one(tx, 'SELECT count(*)::int AS n FROM journey_step_runs WHERE instance_id=$1 AND step_id=$2', [
        inst.id,
        run.step_id,
      ])
    )?.n ?? 1,
  );
  const events: AppendInput[] = [
    ev(inst, {
      type: 'JourneyStepCompleted',
      payload: {
        instanceId: inst.id,
        visit: run.visit,
        result,
        ...(card ? { cardId: card.id } : {}),
      },
    }),
  ];
  const move = nextMove(def, run.step_id, {
    result: result === 'cancelled' ? 'cancelled' : 'done',
    card: card ? workflowView(card) : null,
    record: { type: record.record_type, status: record.status },
    visits,
  });
  if (move.kind === 'next') {
    events.push(
      ev(inst, {
        type: 'JourneyStepEntered',
        payload: {
          instanceId: inst.id,
          visit: run.visit + 1,
          stepId: move.handoff.to,
          kind: kindOf(def, move.handoff.to),
          fromVisit: run.visit,
          handoffId: move.handoff.id,
        },
      }),
    );
  } else if (move.kind === 'end') {
    events.push(ev(inst, { type: 'JourneyInstanceCompleted', payload: { instanceId: inst.id, visit: run.visit } }));
  } else {
    const a = alert(
      inst,
      `Journey for ${record.display_name} is stuck after "${run.step_id}"`,
      `${move.reason} Add a handoff for this result in the journey designer, or cancel the instance.`,
    );
    events.push(
      ev(inst, {
        type: 'JourneyInstanceStuck',
        payload: { instanceId: inst.id, visit: run.visit, reason: move.reason, deskItemId: a.deskItemId },
      }),
      a.event,
    );
  }
  await ctx.store.append(events, { tx });
}

// ------------------------------------------------------------------------------------------------ start a step

/** Creates the card of a pending run. True when something was done (a card started or the step refused). */
export async function startStep(ctx: Ctx, instanceId: string, visit: number): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const inst = await lockInstance(tx, instanceId, visit, 'running');
    if (!inst) return false;
    const run = await one(tx, 'SELECT * FROM journey_step_runs WHERE instance_id=$1 AND visit=$2', [
      instanceId,
      visit,
    ]);
    if (!run || run.status !== 'pending') return false;
    const def = await loadDefinition(tx, inst.journey_id, inst.journey_version);
    try {
      const started = await createStepCard(ctx, tx, inst, def, run);
      await ctx.store.append(
        [
          ev(inst, {
            type: 'JourneyStepCardStarted',
            payload: {
              instanceId,
              visit,
              cardId: started.cardId,
              workflowKey: started.workflowKey,
              workflowVersion: started.workflowVersion,
            },
          }),
        ],
        { tx },
      );
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
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
            payload: { instanceId, visit, reason: err.reason, detail: err.detail.slice(0, 1000), deskItemId: a.deskItemId },
          }),
          ev(inst, {
            type: 'JourneyInstanceStuck',
            payload: { instanceId, visit, reason: `Step "${run.step_id}" could not start: ${err.detail}`.slice(0, 1000) },
          }),
          a.event,
        ],
        { tx },
      );
    }
    return true;
  });
}

async function createStepCard(
  ctx: Ctx,
  tx: Tx,
  inst: Row,
  def: JourneyDefinition,
  run: Row,
): Promise<{ cardId: string; workflowKey: string; workflowVersion: number }> {
  const step = getJourneyStep(def, run.step_id);
  if (!step || step.kind !== 'workflow' || !step.workflowKey)
    throw new Refused('invalid_mapping', `Step "${run.step_id}" has no workflow.`);
  const stepVisits = Number(
    (
      await one(tx, 'SELECT count(*)::int AS n FROM journey_step_runs WHERE instance_id=$1 AND step_id=$2', [
        inst.id,
        run.step_id,
      ])
    )?.n ?? 1,
  );
  if (stepVisits > MAX_STEP_VISITS || run.visit > MAX_INSTANCE_VISITS)
    throw new Refused('visit_limit', `The limit is ${MAX_STEP_VISITS} visits of one step and ${MAX_INSTANCE_VISITS} in all.`);
  const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [inst.project_id]);
  if (!project || project.status !== 'active') throw new Refused('not_found', 'The project is archived or gone.');
  if (
    !(await one(tx, `SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2 AND status='active'`, [
      inst.project_id,
      inst.started_by,
    ]))
  )
    throw new Refused('not_member', `Project ${project.key}.`);
  const wf = await resolveWorkflow(tx, project.org_id, step.workflowKey, project.id);
  if (!wf) throw new Refused('not_found', `There is no workflow ${step.workflowKey}.`);
  if (!(await enabledWorkflows(tx, project)).some((e) => e.workflowKey === step.workflowKey))
    throw new Refused('not_enabled', `${step.workflowKey} is not enabled in project ${project.key}.`);
  const t = wf.definition;
  const cardType = step.cardType ?? t.cardTypes[0];
  if (!cardType || !t.cardTypes.includes(cardType as never))
    throw new Refused('invalid_mapping', `${step.workflowKey} does not run card type ${cardType}.`);
  const record = (await one(tx, 'SELECT * FROM journey_records WHERE id=$1', [inst.record_id])) as Row;
  const vars = {
    name: record.display_name as string,
    type: record.record_type as string,
    externalId: (record.external_id ?? null) as string | null,
    stepLabel: step.label,
  };
  const cat = fieldCatalogue(t.fieldSet, t.customFields);
  const fields: Record<string, unknown> = {};
  for (const m of step.fieldsIn) {
    if (!cat[m.to]) throw new Refused('invalid_mapping', `${step.workflowKey} has no field ${m.to}.`);
    fields[m.to] = expandRecordTemplate(m.template, vars);
  }
  try {
    const created = await createCardIn(
      ctx,
      tx,
      { id: inst.started_by } as AuthSession['user'],
      {
        projectId: inst.project_id,
        title: `${step.label}: ${record.display_name}`.slice(0, 300),
        cardType,
        fields,
        specify: true,
        workflowKey: step.workflowKey,
      } as never,
      { origin: 'journey', actor: SYSTEM_ACTOR },
    );
    return { cardId: created.cardId, workflowKey: step.workflowKey, workflowVersion: wf.version };
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    throw new Refused(
      err.code === 'workflow_not_enabled' ? 'not_enabled' : err.status === 404 ? 'not_member' : 'invalid_mapping',
      err.message,
    );
  }
}

// ---------------------------------------------------------------------------------------------- complete a step

/** A step whose card ended: record the result and follow the handoff. True when it did something. */
export async function completeStep(ctx: Ctx, instanceId: string, visit: number): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const inst = await lockInstance(tx, instanceId, visit, 'running');
    if (!inst) return false;
    const run = await one(tx, 'SELECT * FROM journey_step_runs WHERE instance_id=$1 AND visit=$2', [
      instanceId,
      visit,
    ]);
    if (!run || run.status !== 'open' || !run.card_id) return false;
    const card = await one(tx, 'SELECT * FROM cards WHERE id=$1', [run.card_id]);
    if (!card || (card.status !== 'done' && card.status !== 'cancelled')) return false;
    const def = await loadDefinition(tx, inst.journey_id, inst.journey_version);
    await advance(ctx, tx, inst, def, run, card.status === 'done' ? 'done' : 'cancelled', card);
    return true;
  });
}

/** A placeholder (wait or gate) step is continued by a person. Returns false when it already moved on. */
export async function continuePlaceholder(ctx: Ctx, instanceId: string, visit: number): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const inst = await lockInstance(tx, instanceId, visit, 'waiting');
    if (!inst) return false;
    const run = await one(tx, 'SELECT * FROM journey_step_runs WHERE instance_id=$1 AND visit=$2', [
      instanceId,
      visit,
    ]);
    if (!run || run.status !== 'waiting') return false;
    const def = await loadDefinition(tx, inst.journey_id, inst.journey_version);
    await advance(ctx, tx, inst, def, run, 'skipped', null);
    return true;
  });
}

/** The manager looked at a refused step: enter the same step again (a new visit). */
export async function retryRefused(ctx: Ctx, instanceId: string, visit: number): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const inst = await lockInstance(tx, instanceId, visit, 'stuck');
    if (!inst) return false;
    const run = await one(tx, 'SELECT * FROM journey_step_runs WHERE instance_id=$1 AND visit=$2', [
      instanceId,
      visit,
    ]);
    if (!run || run.status !== 'refused') return false;
    const def = await loadDefinition(tx, inst.journey_id, inst.journey_version);
    await ctx.store.append(
      [
        ev(inst, {
          type: 'JourneyStepEntered',
          payload: {
            instanceId,
            visit: visit + 1,
            stepId: run.step_id,
            kind: kindOf(def, run.step_id),
            fromVisit: visit,
          },
        }),
      ],
      { tx },
    );
    return true;
  });
}

// ------------------------------------------------------------------------------------------------ the sweep

const failures = new Map<string, number>();

/** One pass over the state tables. Returns how many transitions it made. Called from the scheduler's triggers. */
export async function sweepJourneys(ctx: Ctx): Promise<number> {
  let n = 0;
  const attempt = async (key: string, fn: () => Promise<boolean>): Promise<void> => {
    try {
      if (await fn()) n++;
      failures.delete(key);
    } catch (err) {
      const c = (failures.get(key) ?? 0) + 1;
      failures.set(key, c);
      ctx.log.error({ err, key, attempt: c }, 'journey step failed');
    }
  };
  const pending = await rows(
    ctx.pool,
    `SELECT r.instance_id, r.visit FROM journey_step_runs r JOIN journey_instances i ON i.id = r.instance_id
      WHERE r.status='pending' AND i.status='running' AND i.current_visit = r.visit ORDER BY r.entered_at LIMIT 100`,
  );
  for (const r of pending) await attempt(`s:${r.instance_id}:${r.visit}`, () => startStep(ctx, r.instance_id, r.visit));
  const ended = await rows(
    ctx.pool,
    `SELECT r.instance_id, r.visit FROM journey_step_runs r JOIN cards c ON c.id = r.card_id
       JOIN journey_instances i ON i.id = r.instance_id
      WHERE r.status='open' AND c.status IN ('done','cancelled') AND i.status='running' AND i.current_visit = r.visit
      ORDER BY r.entered_at LIMIT 100`,
  );
  for (const r of ended) await attempt(`c:${r.instance_id}:${r.visit}`, () => completeStep(ctx, r.instance_id, r.visit));
  const retry = await rows(
    ctx.pool,
    `SELECT r.instance_id, r.visit FROM journey_step_runs r JOIN journey_instances i ON i.id = r.instance_id
       JOIN desk_items d ON d.id = r.desk_item_id
      WHERE r.status='refused' AND i.status='stuck' AND i.current_visit = r.visit AND d.status <> 'open' LIMIT 100`,
  );
  for (const r of retry) await attempt(`r:${r.instance_id}:${r.visit}`, () => retryRefused(ctx, r.instance_id, r.visit));
  return n;
}

/** Cancels an instance. An open card is left alone; a message on it says the journey was cancelled. */
export async function cancelInstance(ctx: Ctx, instanceId: string, byUserId: string): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const inst = await one(tx, 'SELECT * FROM journey_instances WHERE id=$1 FOR UPDATE', [instanceId]);
    if (!inst || inst.status === 'completed' || inst.status === 'cancelled') return false;
    const events: AppendInput[] = [
      {
        streamId: streamId.journeyInstance(instanceId),
        event: { type: 'JourneyInstanceCancelled', payload: { instanceId, by: byUserId } },
        actor: userActor(byUserId),
        scope: projectScope(inst.org_id, inst.project_id),
      },
    ];
    const open = await one(
      tx,
      `SELECT c.* FROM journey_step_runs r JOIN cards c ON c.id=r.card_id
        WHERE r.instance_id=$1 AND r.status='open' AND c.status NOT IN ('done','cancelled')`,
      [instanceId],
    );
    if (open)
      events.push(
        cardMessage(open, { kind: 'system' }, 'system', 'The journey this card belongs to was cancelled. The card itself is unchanged.'),
      );
    await ctx.store.append(events, { tx });
    return true;
  });
}
