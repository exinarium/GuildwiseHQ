import { randomUUID } from 'node:crypto';
import {
  DESK_SUBKIND,
  type EventOf,
  effectiveSubworkflowStart,
  expandMapping,
  fieldCatalogue,
  getStage,
  MAX_SUBWORKFLOW_DEPTH,
  type Outcome,
  outcomeApplies,
  requiredChildFields,
  resolveOutcome,
  type Stage,
  type SubworkflowConfig,
  type SubworkflowSource,
  streamId,
  type WorkflowCardView,
  type WorkflowDefinition,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadWorkflowById, resolveWorkflow } from '../catalogue/loader.ts';
import { enabledWorkflows } from '../catalogue/project-workflows.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { HttpError } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { createCardIn, workflowView } from './cards.ts';
import { cardMessage, projectScope, SYSTEM_ACTOR } from './common.ts';

/**
 * Sub-workflows (docs/design/workflow-builder.md section 4, docs/ARCHITECTURE.md section 6.6): the server, never an
 * agent, runs a `subworkflow` stage. A reactor follows the event log after a stored cursor (`workflow_reactor_cursor`),
 * like the schedule triggers do (`schedule-triggers.ts`), and does two things:
 *
 *  - ENTER: a card that moved into a `subworkflow` stage gets a child card in the named workflow (same or another
 *    project of the organisation). Wait mode: the parent waits; continue mode: it takes its success outcome at once.
 *  - RESOLVE: when a child ends (finished or cancelled) its waiting parent takes the `done` or `failed` outcome, with
 *    the mapped fields copied back.
 *
 * Both are idempotent per card, decided from the projected state under the global append lock and the parent's row
 * lock: a run is keyed `(parent, stage, entry_seq)` (the move that brought the parent into the stage), so a replayed
 * event, a second pass or a crash between the start and the cursor update starts the stage once, while a later re-entry
 * (rework, the manager moving the card back) starts a new child. The cursor only moves after its events were handled, and
 * an event whose handling fails is retried by the next sweep.
 */

/** Events after which a card may sit in a sub-workflow stage (and a blocked one may have been released). */
const ENTRY_EVENTS = new Set(['StageCompleted', 'CardSpecified', 'CardMovedByManager', 'DeskItemResolved']);
/** Events after which a card may have ended (a child of a waiting parent). */
const END_EVENTS = new Set(['StageCompleted', 'CardFinalized', 'CardCancelled', 'CardMovedByManager']);
const INTEREST = [...new Set([...ENTRY_EVENTS, ...END_EVENTS])];

async function readCursor(ctx: Ctx): Promise<bigint> {
  await ctx.pool.query(
    'INSERT INTO workflow_reactor_cursor (id, last_seq) VALUES (1, 0) ON CONFLICT (id) DO NOTHING',
  );
  const r = await one<{ last_seq: string }>(
    ctx.pool,
    'SELECT last_seq FROM workflow_reactor_cursor WHERE id=1',
  );
  return BigInt(r?.last_seq ?? 0);
}

const failures = new Map<string, number>();
const MAX_ATTEMPTS = 5;

/** One pass over the new events. Returns how many sub-workflow starts and resolutions it made. */
export async function sweepSubworkflows(ctx: Ctx): Promise<number> {
  const cursor = await readCursor(ctx);
  const head = BigInt(
    (await one<{ m: string | null }>(ctx.pool, 'SELECT max(seq) AS m FROM events'))?.m ?? 0,
  );
  if (head <= cursor) return 0;
  // Are there sub-workflow stages at all? Most deployments have none: skip the read, still move the cursor.
  const any = await one(ctx.pool, `SELECT 1 FROM workflow_stages WHERE kind = 'subworkflow' LIMIT 1`);
  let done = 0;
  let at = cursor;
  let stoppedAt: bigint | null = null;
  if (any) {
    scan: for (;;) {
      const batch = await rows(
        ctx.pool,
        `SELECT seq, type, payload FROM events
          WHERE seq > $1 AND seq <= $2 AND type = ANY($3::text[]) ORDER BY seq LIMIT 100`,
        [at.toString(), head.toString(), INTEREST],
      );
      for (const e of batch) {
        try {
          done += await handleEvent(ctx, e);
          failures.delete(String(e.seq));
        } catch (err) {
          const n = (failures.get(String(e.seq)) ?? 0) + 1;
          failures.set(String(e.seq), n);
          ctx.log.error({ err, seq: e.seq, attempt: n }, 'sub-workflow reactor failed');
          // Retried by the next sweep; after repeated failures the event is skipped so one bad card cannot stall the rest.
          if (n < MAX_ATTEMPTS) {
            stoppedAt = BigInt(e.seq) - 1n;
            break scan;
          }
        }
        at = BigInt(e.seq);
      }
      if (batch.length < 100) break;
    }
  }
  const next = stoppedAt ?? head;
  if (next > cursor)
    await ctx.pool.query('UPDATE workflow_reactor_cursor SET last_seq=$1 WHERE id=1 AND last_seq < $1', [
      next.toString(),
    ]);
  return done;
}

async function handleEvent(ctx: Ctx, e: Row): Promise<number> {
  const p = e.payload as Record<string, any>;
  let cardId: string | undefined = p.cardId;
  if (e.type === 'DeskItemResolved') {
    const item = await one(ctx.pool, 'SELECT card_id FROM desk_items WHERE id=$1', [p.deskItemId]);
    cardId = item?.card_id ?? undefined;
  }
  if (!cardId) return 0;
  let n = 0;
  if (ENTRY_EVENTS.has(e.type) && (await enterSubworkflow(ctx, cardId))) n++;
  if (END_EVENTS.has(e.type) && (await resolveSubworkflow(ctx, cardId))) n++;
  return n;
}

// ------------------------------------------------------------------------------------------------ enter

type Refusal = { reason: EventOf<'SubworkflowRefused'>['payload']['reason']; detail: string };

const fail = (reason: Refusal['reason'], detail: string): Refusal => ({ reason, detail });
const isRefusal = (x: unknown): x is Refusal => !!x && typeof x === 'object' && 'reason' in x;

/** What a `{field}` / literal / `{template}` mapping gives for the parent card; undefined: leave the child's field alone. */
function sourceValue(src: SubworkflowSource, parent: Row): unknown {
  const fields = (parent.fields ?? {}) as Record<string, unknown>;
  if ('field' in src) {
    const v = fields[src.field];
    return v === null ? undefined : v;
  }
  if ('value' in src) return src.value === null ? undefined : src.value;
  const values: Record<string, string> = { 'card.ref': parent.ref, 'card.title': parent.title };
  for (const [k, v] of Object.entries(fields))
    values[`card.fields.${k}`] =
      typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
  return expandMapping(src.template, values);
}

const successOutcome = (stage: Stage, view: WorkflowCardView): Outcome | undefined =>
  stage.outcomes.find((o) => o.kind === 'success' && outcomeApplies(o, view));
const failureOutcome = (stage: Stage, view: WorkflowCardView): Outcome | undefined => {
  const all = stage.outcomes.filter((o) => o.kind === 'failure' && outcomeApplies(o, view));
  return all.find((o) => o.id === 'failed') ?? all[0];
};

/** Sub-workflow ancestors of a card: the workflow keys above it and how many levels it is nested. */
async function ancestry(db: Queryable, card: Row): Promise<{ depth: number; keys: string[] }> {
  const keys: string[] = [];
  let depth = 0;
  let cur: Row | undefined = card;
  while (cur?.parent_card_id && cur.origin === 'subworkflow' && depth < 50) {
    cur = await one(db, 'SELECT * FROM cards WHERE id=$1', [cur.parent_card_id]);
    if (!cur) break;
    depth++;
    const w = await loadWorkflowById(db, cur.workflow_version_id);
    if (w) keys.push(w.key);
  }
  return { depth, keys };
}

/** Starts the child of the sub-workflow stage `card` is in. Returns true when a child was started or the stage refused. */
export async function enterSubworkflow(ctx: Ctx, cardId: string): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [cardId]);
    if (!card || card.status !== 'queued' || card.claim_id) return false;
    const st = await one(
      tx,
      'SELECT kind FROM workflow_stages WHERE workflow_version_id=$1 AND stage_id=$2',
      [card.workflow_version_id, card.stage],
    );
    if (st?.kind !== 'subworkflow') return false;
    const wf = await loadWorkflowById(tx, card.workflow_version_id);
    const stage = wf ? getStage(wf.definition, card.stage) : undefined;
    const cfg = stage?.subworkflow;
    if (!wf || !stage || !cfg) return false;

    const entry = await one<{ event_seq: string }>(
      tx,
      `SELECT event_seq FROM card_transitions
        WHERE card_id=$1 AND to_stage=$2 AND from_stage IS DISTINCT FROM to_stage ORDER BY id DESC LIMIT 1`,
      [card.id, card.stage],
    );
    if (
      entry &&
      (await one(
        tx,
        'SELECT 1 FROM subworkflow_runs WHERE parent_card_id=$1 AND stage_id=$2 AND entry_seq=$3',
        [card.id, card.stage, entry.event_seq],
      ))
    )
      return false;
    // One open child per step: a card moved back into a stage whose child still runs waits on that child again
    // (no second child). When the child ends, the usual resolution takes the parent on.
    const open = await one(
      tx,
      `SELECT r.child_card_id, ch.ref AS child_ref FROM subworkflow_runs r JOIN cards ch ON ch.id = r.child_card_id
        WHERE r.parent_card_id=$1 AND r.stage_id=$2 AND r.status='open' ORDER BY r.started_at DESC LIMIT 1`,
      [card.id, card.stage],
    );
    if (open) {
      await ctx.store.append(
        [
          {
            streamId: streamId.card(card.id),
            event: {
              type: 'SubworkflowAttached',
              payload: {
                cardId: card.id,
                stageId: stage.id,
                childCardId: open.child_card_id,
                reworkRound: card.rework_round,
              },
            },
            actor: SYSTEM_ACTOR,
            scope: projectScope(card.org_id, card.project_id),
          },
          cardMessage(
            card,
            { kind: 'system' },
            'system',
            `Step "${stage.label}" already has ${open.child_ref} running from an earlier visit: this card waits for it instead of starting another.`,
          ),
        ],
        { tx },
      );
      return true;
    }

    const started = await startChild(ctx, tx, card, wf.definition, stage, cfg);
    if (isRefusal(started)) await ctx.store.append(refusalEvents(card, stage, cfg, started), { tx });
    return true;
  });
}

function refusalEvents(card: Row, stage: Stage, cfg: SubworkflowConfig, r: Refusal): AppendInput[] {
  const scope = projectScope(card.org_id, card.project_id);
  const deskItemId = randomUUID();
  const REASON: Record<Refusal['reason'], string> = {
    depth: `sub-workflows are nested too deep (at most ${MAX_SUBWORKFLOW_DEPTH} levels)`,
    cycle: 'the workflow would start itself',
    not_found: 'the workflow or project could not be found',
    not_approved: 'the workflow has no approved version',
    not_enabled: 'the workflow is not enabled in that project',
    not_member: 'the card owner is not a member of that project',
    invalid_mapping: 'the fields could not be filled in',
  };
  return [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'SubworkflowRefused',
        payload: {
          cardId: card.id,
          stageId: stage.id,
          workflowKey: cfg.workflowKey,
          reason: r.reason,
          detail: r.detail.slice(0, 1000),
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    },
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      `Step "${stage.label}" could not start ${cfg.workflowKey}: ${REASON[r.reason]}.${r.detail ? ` ${r.detail}` : ''}`,
    ),
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: DESK_SUBKIND.subworkflowRefused,
          title: `${card.ref}: step "${stage.label}" could not start ${cfg.workflowKey}`,
          body: `${REASON[r.reason].charAt(0).toUpperCase()}${REASON[r.reason].slice(1)}.${r.detail ? ` ${r.detail}` : ''} ${card.ref} is blocked until you have looked at it: fix the cause (or move the card by hand), then acknowledge this notice and the step is tried again.`,
          options: [],
          blocking: true,
          pinned: false,
          cardId: card.id,
          projectId: card.project_id,
          affectedCardIds: [],
          askedBy: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    },
  ];
}

async function startChild(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  def: WorkflowDefinition,
  stage: Stage,
  cfg: SubworkflowConfig,
): Promise<{ childCardId: string } | Refusal> {
  const success = successOutcome(stage, workflowView(card));
  if (!success) return fail('invalid_mapping', 'The step has no outcome that moves the card on.');

  // Depth and cycle, from the ancestry of this very card (a stored workflow may have changed since it was approved).
  const above = await ancestry(tx, card);
  if (above.depth >= MAX_SUBWORKFLOW_DEPTH)
    return fail('depth', `${card.ref} is already ${above.depth} sub-workflows deep.`);
  if (cfg.workflowKey === def.key || above.keys.includes(cfg.workflowKey))
    return fail('cycle', `${cfg.workflowKey} is already running above ${card.ref}.`);

  const projectId = cfg.project === 'same' ? card.project_id : cfg.project.projectId;
  const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [projectId]);
  if (!project || project.org_id !== card.org_id)
    return fail('not_found', 'The project is not in this organisation.');
  if (project.status !== 'active') return fail('not_found', `Project ${project.key} is archived.`);
  const owner = card.owner_user_id as string;
  if (
    !(await one(tx, `SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2 AND status='active'`, [
      projectId,
      owner,
    ]))
  )
    return fail('not_member', `The card owner is not a member of project ${project.key}.`);

  const target = await resolveWorkflow(tx, project.org_id, cfg.workflowKey, projectId);
  if (!target) {
    const inTheWorks = await one(
      tx,
      `SELECT 1 FROM workflow_versions WHERE key=$2 AND (org_id=$1 OR org_id IS NULL)
          AND status IN ('draft','pending_approval') LIMIT 1`,
      [project.org_id, cfg.workflowKey],
    );
    return inTheWorks
      ? fail('not_approved', `${cfg.workflowKey} waits for approval.`)
      : fail('not_found', `There is no workflow ${cfg.workflowKey}.`);
  }
  if (!(await enabledWorkflows(tx, project)).some((e) => e.workflowKey === cfg.workflowKey))
    return fail('not_enabled', `${cfg.workflowKey} is not enabled in project ${project.key}.`);

  const t = target.definition;
  const cardType = cfg.cardType ?? (t.cardTypes.includes(card.card_type) ? card.card_type : t.cardTypes[0]);
  if (!cardType || !t.cardTypes.includes(cardType))
    return fail(
      'invalid_mapping',
      `${cfg.workflowKey} does not run card type ${cfg.cardType ?? card.card_type}.`,
    );

  const childCat = fieldCatalogue(t.fieldSet, t.customFields);
  const fields: Record<string, unknown> = {};
  for (const m of cfg.fieldsIn) {
    if (!childCat[m.to]) return fail('invalid_mapping', `${cfg.workflowKey} has no field ${m.to}.`);
    const v = sourceValue(m.from, card);
    if (v !== undefined) fields[m.to] = v;
  }
  const start = effectiveSubworkflowStart(cfg, requiredChildFields(t));

  let created: { cardId: string; ref: string; missing?: string[] };
  try {
    created = await createCardIn(
      ctx,
      tx,
      { id: owner } as AuthSession['user'],
      {
        projectId,
        title: `${stage.label}: ${card.title}`.slice(0, 300),
        cardType,
        fields,
        priority: card.priority,
        specify: start === 'queued',
        workflowKey: cfg.workflowKey,
      },
      { origin: 'subworkflow', actor: SYSTEM_ACTOR, parentCardId: card.id },
    );
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    const reason: Refusal['reason'] =
      err.code === 'workflow_not_enabled'
        ? 'not_enabled'
        : err.status === 404
          ? 'not_member'
          : 'invalid_mapping';
    return fail(reason, err.message);
  }

  const child = (await one(tx, 'SELECT * FROM cards WHERE id=$1', [created.cardId])) as Row;
  const childWf = await loadWorkflowById(tx, child.workflow_version_id);
  const scope = projectScope(card.org_id, card.project_id);
  const events: AppendInput[] = [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'SubworkflowStarted',
        payload: {
          cardId: card.id,
          stageId: stage.id,
          childCardId: created.cardId,
          childProjectId: projectId,
          workflowKey: cfg.workflowKey,
          workflowVersion: childWf?.version ?? target.version,
          mode: cfg.mode,
          reworkRound: card.rework_round,
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    },
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      `Step "${stage.label}" started ${created.ref} (${cfg.workflowKey}${projectId === card.project_id ? '' : ` in project ${project.key}`})${
        created.missing?.length
          ? `. It stays a draft until these fields are filled in: ${created.missing.join(', ')}`
          : ''
      }${cfg.mode === 'wait' ? '. This card waits for it' : '. This card carries on'}.`,
    ),
  ];
  if (cfg.mode === 'continue') {
    const moved = resolveOutcome(def, workflowView(card), stage.id, success.id);
    events.push({
      streamId: streamId.card(card.id),
      event: {
        type: 'StageCompleted',
        payload: {
          cardId: card.id,
          fromStage: stage.id,
          toStage: moved.toStage,
          outcome: success.id,
          ...(success.rework ? { rework: true } : {}),
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    });
  }
  await ctx.store.append(events, { tx });
  return { childCardId: created.cardId };
}

// ---------------------------------------------------------------------------------------------- resolve

/** A child that ended (finished or cancelled): its waiting parent takes the `done` or `failed` outcome. */
export async function resolveSubworkflow(ctx: Ctx, childCardId: string): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const run = await one(
      tx,
      `SELECT * FROM subworkflow_runs WHERE child_card_id=$1 AND status='open' FOR UPDATE`,
      [childCardId],
    );
    if (!run) return false;
    const child = await one(tx, 'SELECT * FROM cards WHERE id=$1', [childCardId]);
    if (!child || (child.status !== 'done' && child.status !== 'cancelled')) return false;
    const parent = (await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [run.parent_card_id])) as Row;
    const result = child.status === 'done' ? ('done' as const) : ('cancelled' as const);
    const scope = projectScope(parent.org_id, parent.project_id);
    const resolved = (fields: Record<string, unknown>): AppendInput => ({
      streamId: streamId.card(parent.id),
      event: {
        type: 'SubworkflowResolved',
        payload: { cardId: parent.id, stageId: run.stage_id, childCardId, result, fields },
      },
      actor: SYSTEM_ACTOR,
      scope,
    });

    const wf = await loadWorkflowById(tx, parent.workflow_version_id);
    const stage = wf ? getStage(wf.definition, run.stage_id) : undefined;
    const cfg = stage?.subworkflow;
    // The parent was cancelled or moved on by hand: record that the child ended and leave the parent alone.
    if (!wf || !stage || !cfg || parent.status !== 'waiting' || parent.stage !== run.stage_id) {
      await ctx.store.append([resolved({})], { tx });
      return true;
    }

    // Copy the mapped fields back (a finished child only), keeping to fields the parent really has.
    const back: Record<string, unknown> = {};
    if (result === 'done') {
      const parentCat = fieldCatalogue(wf.definition.fieldSet, wf.definition.customFields);
      const childFields = (child.fields ?? {}) as Record<string, unknown>;
      for (const m of cfg.fieldsOut)
        if (parentCat[m.to] && childFields[m.from] !== undefined) back[m.to] = childFields[m.from];
    }
    const view = workflowView({ ...parent, fields: { ...(parent.fields ?? {}), ...back } });
    const outcome =
      result === 'done' || cfg.onFailure === 'continue'
        ? successOutcome(stage, view)
        : failureOutcome(stage, view);
    if (!outcome) {
      const r = fail(
        'invalid_mapping',
        `${child.ref} ${result === 'done' ? 'finished' : 'was cancelled'}, but the step has no outcome to take.`,
      );
      await ctx.store.append([resolved(back), ...refusalEvents(parent, stage, cfg, r)], { tx });
      return true;
    }
    const moved = resolveOutcome(wf.definition, view, stage.id, outcome.id);
    await ctx.store.append(
      [
        resolved(back),
        {
          streamId: streamId.card(parent.id),
          event: {
            type: 'StageCompleted',
            payload: {
              cardId: parent.id,
              fromStage: stage.id,
              toStage: moved.toStage,
              outcome: outcome.id,
              ...(outcome.rework ? { rework: true } : {}),
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
        cardMessage(
          parent,
          { kind: 'system' },
          'system',
          `${child.ref} ${result === 'done' ? 'finished' : 'was cancelled'}: step "${stage.label}" ended with "${outcome.label}".`,
        ),
      ],
      { tx },
    );
    return true;
  });
}
