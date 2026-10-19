import { randomUUID } from 'node:crypto';
import {
  fieldCatalogue,
  missingForSpecify,
  NON_FIELD_COLUMNS,
  type RunnerToServerOf,
  SPEC_CARD_OUTCOME,
  SpecCardDataSchema,
  type SpecCardTask,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadWorkflowById } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { cardView, patchCardIn, specifyCardIn } from './cards.ts';
import { agentActor, orgScope, projectScope, SYSTEM_ACTOR } from './common.ts';
import type { ReportResult } from './shifts.ts';

/**
 * `spec_card` BA tasks (docs/design/ceo-front-door.md section 2.4). A draft card with empty required fields waits for
 * someone to complete it. The CEO's `specify` verb (and `intake`) queue this task when the missing keys are text fields; the
 * BA writes them in a background shift, the server applies them as the card's owner and specifies the card.
 */

/**
 * The text and list fields among `missing` (the BA can write them) and the rest: a repository, a title, a switch or a choice,
 * which someone must decide.
 */
export async function splitMissing(
  db: Queryable,
  card: Row,
  missing: string[],
): Promise<{ fields: string[]; lists: string[]; other: string[] }> {
  const wf = await loadWorkflowById(db, card.workflow_version_id);
  const catalogue = fieldCatalogue(wf?.definition.fieldSet ?? 'code');
  const out = { fields: [] as string[], lists: [] as string[], other: [] as string[] };
  for (const k of missing) {
    const kind = catalogue[k]?.kind;
    if (NON_FIELD_COLUMNS.includes(k) || !kind || !['text', 'markdown', 'list'].includes(kind))
      out.other.push(k);
    else {
      out.fields.push(k);
      if (kind === 'list') out.lists.push(k);
    }
  }
  return out;
}

export const MISSING_LABEL: Record<string, string> = {
  repoId: 'repository',
  completionAction: 'completion action',
};
export const missingText = (missing: string[]): string =>
  missing.map((k) => MISSING_LABEL[k] ?? k).join(', ');

export async function cardMissing(db: Queryable, card: Row): Promise<string[]> {
  const wf = await loadWorkflowById(db, card.workflow_version_id);
  return wf ? missingForSpecify(wf.definition, cardView(card)) : [];
}

export async function hasActiveBa(db: Queryable, orgId: string): Promise<boolean> {
  return !!(await one(
    db,
    `SELECT 1 FROM agents WHERE org_id=$1 AND role_key='ba' AND status='active' AND NOT is_devops LIMIT 1`,
    [orgId],
  ));
}

/** Queues the task for `card` (one open task per card: asking again returns it). Appends in `tx`. */
export async function queueSpecCardTask(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  actor: Parameters<Ctx['store']['append']>[0][number]['actor'],
): Promise<{ taskId: string; existing: boolean }> {
  const open = await one(
    tx,
    `SELECT id FROM ba_tasks WHERE card_id=$1 AND kind='spec_card' AND status IN ('queued','running') LIMIT 1`,
    [card.id],
  );
  if (open) return { taskId: open.id as string, existing: true };
  const taskId = randomUUID();
  await ctx.store.append(
    [
      {
        streamId: streamId.baTask(taskId),
        event: {
          type: 'BaTaskQueued',
          payload: { taskId, projectId: card.project_id, kind: 'spec_card', cardId: card.id },
        },
        actor,
        scope: projectScope(card.org_id, card.project_id),
      },
    ],
    { tx },
  );
  return { taskId, existing: false };
}

/** What the BA is given: the card's text fields and the keys to write. */
export async function buildSpecCardTask(db: Queryable, task: Row): Promise<SpecCardTask | null> {
  const card = await one(
    db,
    'SELECT c.*, p.key AS project_key FROM cards c JOIN projects p ON p.id = c.project_id WHERE c.id=$1',
    [task.card_id],
  );
  if (!card) return null;
  const split = await splitMissing(db, card, await cardMissing(db, card));
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries((card.fields ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string') fields[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) fields[k] = v.join('\n');
  }
  return {
    cardId: card.id,
    ref: card.ref,
    title: card.title,
    cardType: card.card_type,
    projectKey: card.project_key,
    fields,
    missing: split.fields,
    listFields: split.lists,
  };
}

const completed = (task: Row, status: 'done' | 'failed' | 'fallback' | 'cancelled', note?: string) => ({
  streamId: streamId.baTask(task.id),
  event: {
    type: 'BaTaskCompleted' as const,
    payload: { taskId: task.id, status, ...(note ? { note } : {}) },
  },
  actor: SYSTEM_ACTOR,
  scope: projectScope(task.org_id, task.project_id),
});

/** A pinned alert: the card stays a draft and a person has to say what it needs. Appends in `tx`. */
async function needsSpecifyingItem(ctx: Ctx, tx: Tx, task: Row, card: Row, why: string): Promise<void> {
  const deskItemId = randomUUID();
  await ctx.store.append(
    [
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'alert',
            subkind: 'spec_needed',
            title: `${card.ref} needs specifying: ${why}`.slice(0, 280),
            body: `${card.ref} "${card.title}" is still a draft. ${why}\n\nSpecify it by hand (add the missing text, then Specify), or cancel it.`,
            options: [],
            blocking: false,
            pinned: true,
            cardId: card.id,
            projectId: card.project_id,
            affectedCardIds: [card.id],
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(task.org_id, task.project_id),
      },
    ],
    { tx },
  );
}

/** The terminal report of a `spec_card` shift: the fields (applied, then the card is specified) or "cannot". */
export async function applySpecCardReport(
  ctx: Ctx,
  tx: Tx,
  task: Row,
  shift: Row,
  msg: RunnerToServerOf<'shift.report'>,
): Promise<ReportResult> {
  const report = msg.report;
  if (report.kind === 'comment') return { accepted: true };
  if (report.kind !== 'outcome')
    return {
      accepted: false,
      error:
        'there are no questions in a background task: write the fields or report that the card cannot be specified',
    };
  const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [task.card_id]);
  if (!card || card.status !== 'draft') {
    await ctx.store.append([completed(task, 'cancelled', 'the card is not a draft any more')], { tx });
    return {
      accepted: false,
      error: 'the card is not a draft any more; there is nothing left to do. Finish now.',
    };
  }
  if (report.outcomeId === SPEC_CARD_OUTCOME.fail) {
    const why =
      (report.note ?? '').trim().slice(0, 500) || 'the BA could not specify the card from what it says';
    await needsSpecifyingItem(ctx, tx, task, card, why);
    await ctx.store.append([completed(task, 'done', why)], { tx });
    return { accepted: true };
  }
  if (report.outcomeId !== SPEC_CARD_OUTCOME.done)
    return {
      accepted: false,
      error: `outcome '${report.outcomeId}' is not available (allowed: ${SPEC_CARD_OUTCOME.done}, ${SPEC_CARD_OUTCOME.fail})`,
    };
  const data = SpecCardDataSchema.safeParse(report.data);
  if (!data.success) return { accepted: false, error: `invalid fields: ${data.error.message}` };
  const owner = { id: card.owner_user_id } as AuthSession['user'];
  const acting = { actor: agentActor(shift.agent_id) };
  try {
    await patchCardIn(ctx, tx, owner, card.id, { fields: data.data.fields }, acting);
  } catch (err) {
    return {
      accepted: false,
      error: `the fields were refused: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const fresh = (await one(tx, 'SELECT * FROM cards WHERE id=$1', [card.id])) as Row;
  const stillMissing = await cardMissing(tx, fresh);
  if (stillMissing.length)
    return {
      accepted: false,
      error: `${card.ref} still lacks ${missingText(stillMissing)}: write ${stillMissing.length === 1 ? 'it' : 'them'} and report again`,
    };
  await specifyCardIn(ctx, tx, owner, card.id, acting);
  await ctx.store.append([completed(task, 'done')], { tx });
  return { accepted: true };
}

/** No BA took the task in time, or it failed twice: the card stays a draft and a pinned alert says so. */
export async function runSpecCardFallback(ctx: Ctx, tx: Tx, task: Row): Promise<void> {
  const card = await one(tx, 'SELECT * FROM cards WHERE id=$1', [task.card_id]);
  if (card && card.status === 'draft')
    await needsSpecifyingItem(ctx, tx, task, card, 'no BA was available to complete it');
  await ctx.store.append([completed(task, 'fallback', 'no BA was available to complete the card')], { tx });
}

void orgScope;
