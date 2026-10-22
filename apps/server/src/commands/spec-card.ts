import { randomUUID } from 'node:crypto';
import {
  type CreateCardRequest,
  emptyFields,
  fieldCatalogue,
  graphRepoKey,
  missingForSpecify,
  NON_FIELD_COLUMNS,
  parseCardFields,
  type RunnerToServerOf,
  SPEC_CARD_OUTCOME,
  type SpecCardData,
  SpecCardDataSchema,
  type SpecCardSplitChild,
  type SpecCardTask,
  streamId,
  workflowHasDesignStage,
  workflowSupportsInvestigationOnly,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadWorkflowById } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { BA_TASK_AGENT_FROM, baTaskAgentEligibleSql } from '../dispatcher/ba-agent-sql.ts';
import { needsRepoScoping, resolveRepo } from './card-repo.ts';
import {
  architectFlags,
  cancelCardIn,
  cardView,
  createCardIn,
  patchCardIn,
  resolveCardWorkflow,
  specifyCardIn,
} from './cards.ts';
import { agentActor, orgScope, projectScope, SYSTEM_ACTOR } from './common.ts';
import { graphsEnabled } from './graph.ts';
import type { ReportResult } from './shifts.ts';
import { vaultForProject } from './vaults.ts';

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
): Promise<{ fields: string[]; lists: string[]; other: string[]; scoping: boolean }> {
  const wf = await loadWorkflowById(db, card.workflow_version_id);
  const catalogue = fieldCatalogue(wf?.definition.fieldSet ?? 'code');
  // A missing repository is not "other" when the BA can find it: the card has none and the project has several.
  const scoping = missing.includes('repoId') && (await needsRepoScoping(db, card));
  const out = { fields: [] as string[], lists: [] as string[], other: [] as string[], scoping };
  for (const k of missing) {
    const kind = catalogue[k]?.kind;
    if (k === 'repoId' && scoping) continue;
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

/** The project's repositories as a scoping task lists them: with the graph key and whether the graph covers them. */
export async function scopingRepos(
  db: Queryable,
  projectId: string,
): Promise<NonNullable<SpecCardTask['repos']>> {
  const list = await rows(
    db,
    `SELECT r.id, r.name, r.remote_url_normalized, (g.status = 'indexed') AS indexed
       FROM project_repos r LEFT JOIN project_graphs g ON g.project_id = r.project_id AND g.repo_id = r.id
      WHERE r.project_id=$1 AND r.removed_at IS NULL ORDER BY r.name, r.id`,
    [projectId],
  );
  return list.map((r) => ({
    repoId: r.id as string,
    name: r.name as string,
    graphKey: graphRepoKey(r.remote_url_normalized as string),
    indexed: r.indexed === true,
  }));
}

/**
 * Who finds the repository of a repo-less card: the BA, who has no source access and works through the project code graph,
 * the project vault and the repository names; or, as the fallback, an architect, who may read the repositories. The architect
 * takes it when no BA is hired, when the graph does not cover every repository of the project, or when no BA works on a
 * workstation that can reach the project's vault. Null: neither is hired.
 */
export async function scopingAgentRole(
  ctx: Ctx,
  db: Queryable,
  card: Row,
): Promise<'ba' | 'architect' | null> {
  return (await scopingPlan(ctx, db, card))?.role ?? null;
}

/**
 * `scopingAgentRole` with whether the BA path is the full one (graph covers every repository and a BA reaches the vault):
 * only then does the dispatcher insist on a workstation with the vault. When the BA is the last resort (no architect), any
 * BA takes the task and does what it can.
 */
export async function scopingPlan(
  ctx: Ctx,
  db: Queryable,
  card: Row,
): Promise<{ role: 'ba' | 'architect'; vaultRequired: boolean } | null> {
  const agents = await rows(
    db,
    `SELECT a.role_key, ws.user_id FROM ${BA_TASK_AGENT_FROM}
      WHERE a.role_key IN ('ba','architect')
        AND ${baTaskAgentEligibleSql({ org: '$1', project: '$2', orgLevel: 'false' })}`,
    [card.org_id, card.project_id],
  );
  const bas = agents.filter((a) => a.role_key === 'ba');
  const hasArchitect = agents.some((a) => a.role_key === 'architect');
  if (bas.length && graphsEnabled(ctx)) {
    const graphOk = (await scopingRepos(db, card.project_id)).every((r) => r.indexed);
    let vaultOk = false;
    if (graphOk)
      for (const a of bas)
        if (a.user_id && (await vaultForProject(db, card.project_id, a.user_id))) {
          vaultOk = true;
          break;
        }
    if (graphOk && vaultOk) return { role: 'ba', vaultRequired: true };
  }
  if (hasArchitect) return { role: 'architect', vaultRequired: false };
  return bas.length ? { role: 'ba', vaultRequired: false } : null;
}

/** Queues the task for `card` (one open task per card: asking again returns it). Appends in `tx`. */
export async function queueSpecCardTask(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  actor: Parameters<Ctx['store']['append']>[0][number]['actor'],
): Promise<{ taskId: string; existing: boolean }> {
  // Under the card's lock, so two callers cannot both see "no open task" and queue two.
  await tx.query('SELECT 1 FROM cards WHERE id=$1 FOR UPDATE', [card.id]);
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
export async function buildSpecCardTask(
  db: Queryable,
  task: Row,
  by: 'ba' | 'architect' = 'ba',
): Promise<SpecCardTask | null> {
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
    ...(split.scoping ? { chooseRepo: true, repos: await scopingRepos(db, card.project_id), by } : {}),
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

/**
 * An alert: the card stays a draft and someone has to say what it needs. A card that lacks only a repository is first
 * the CEO's: the alert is not pinned, so the CEO (when it is active and reachable) triages it and the owner sees it only
 * if the CEO cannot decide. Any other card pins the alert for the owner. Appends in `tx`.
 */
async function needsSpecifyingItem(
  ctx: Ctx,
  tx: Tx,
  task: Row,
  card: Row,
  why: string,
  scoping = false,
): Promise<void> {
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
            title: `${card.ref} ${scoping ? 'needs a repository' : 'needs specifying'}: ${why}`.slice(0, 280),
            body: scoping
              ? `${card.ref} "${card.title}" is still a draft. Nobody could tell which of the project's repositories it touches: ${why}\n\nAdd what is missing to the card and send it to the BA again, set the repository by hand, or cancel it.`
              : `${card.ref} "${card.title}" is still a draft. ${why}\n\nSpecify it by hand (add the missing text, then Specify), or cancel it.`,
            options: [],
            blocking: false,
            pinned: !scoping,
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

/** A split child that cannot be created: what is wrong, by position (1 = the first). */
interface ChildPlan {
  child: SpecCardSplitChild;
  repoId: string;
  cardType: string;
  workflowKey: string | undefined;
  fields: Record<string, unknown>;
  designNeeded: boolean | undefined;
  investigationOnly: boolean | undefined;
}

/**
 * Checks every child of a split without writing anything: its repository exists, its card type is allowed, its fields
 * parse, `dependsOn` only names earlier children, and the card would be specified (`missingForSpecify`). Returns the plans,
 * or every problem found, so the BA can fix them in one go.
 */
async function planSplit(
  tx: Tx,
  card: Row,
  split: SpecCardSplitChild[],
): Promise<{ plans: ChildPlan[] } | { problems: string[] }> {
  const project = (await one(tx, 'SELECT * FROM projects WHERE id=$1', [card.project_id])) as Row;
  const parentWf = await loadWorkflowById(tx, card.workflow_version_id);
  const problems: string[] = [];
  const plans: ChildPlan[] = [];
  for (const [i, child] of split.entries()) {
    const at = `child ${i + 1} (${child.title.slice(0, 60)})`;
    let repoId: string;
    try {
      repoId = await resolveRepo(tx, card.project_id, child.repo);
    } catch (err) {
      problems.push(`${at}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const d of child.dependsOn ?? [])
      if (d > i) problems.push(`${at}: dependsOn ${d} is not an earlier child (children before it: ${i})`);
    const cardType = child.cardType ?? card.card_type;
    const sameType = cardType === card.card_type;
    const wf = await resolveCardWorkflow(
      tx,
      project,
      cardType,
      sameType ? parentWf?.definition.key : undefined,
    );
    if (!wf) {
      problems.push(`${at}: card type '${cardType}' is not allowed in this project`);
      continue;
    }
    const def = wf.definition;
    const merged = { ...((card.fields ?? {}) as Record<string, unknown>), ...child.fields };
    const parsed = parseCardFields(def.fieldSet, { ...emptyFields(def.fieldSet), ...merged });
    if (!parsed.success) {
      problems.push(
        `${at}: the fields are invalid (${parsed.error.issues.map((x) => x.message).join('; ')})`,
      );
      continue;
    }
    const designNeeded = workflowHasDesignStage(def) ? (card.design_needed as boolean) : undefined;
    const investigationOnly =
      workflowHasDesignStage(def) && workflowSupportsInvestigationOnly(def)
        ? (card.investigation_only as boolean)
        : undefined;
    let flags: { designNeeded: boolean; investigationOnly: boolean };
    try {
      flags = architectFlags(def, project, {
        ...(designNeeded !== undefined ? { designNeeded } : {}),
        ...(investigationOnly !== undefined ? { investigationOnly } : {}),
      });
    } catch (err) {
      problems.push(`${at}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const missing = missingForSpecify(def, {
      title: child.title,
      cardType,
      repoId,
      completionAction: card.completion_action ?? null,
      docsNeeded: card.docs_needed === true,
      designNeeded: flags.designNeeded,
      investigationOnly: flags.investigationOnly,
      riskTier: null,
      priority: card.priority,
      fields: parsed.data,
    } as never);
    if (missing.length) {
      problems.push(
        `${at} still lacks ${missingText(missing)}: write ${missing.length === 1 ? 'it' : 'them'} in its fields`,
      );
      continue;
    }
    plans.push({
      child,
      repoId,
      cardType,
      workflowKey: sameType ? parentWf?.definition.key : undefined,
      fields: parsed.data as Record<string, unknown>,
      designNeeded,
      investigationOnly,
    });
  }
  return problems.length ? { problems } : { plans };
}

/** Origins that mean something to the code that reads `parent_card_id`: a split child is a plain card of its parent's origin. */
const PARENT_LINK_ORIGINS = new Set(['test_failure', 'full_suite', 'regression', 'subworkflow']);

/**
 * Who the children belong to: the card's owner, or the project owner when the owner has left the project (the children
 * are created through the owner's project access, which a former member no longer has).
 */
async function splitOwner(tx: Tx, card: Row): Promise<AuthSession['user']> {
  const member = await one(
    tx,
    `SELECT 1 AS x FROM project_members WHERE project_id=$1 AND user_id=$2 AND status='active'`,
    [card.project_id, card.owner_user_id],
  );
  let id = card.owner_user_id as string;
  if (!member) {
    const po = await one(
      tx,
      `SELECT user_id FROM project_members WHERE project_id=$1 AND role='owner' AND status='active' LIMIT 1`,
      [card.project_id],
    );
    if (po) id = po.user_id as string;
  }
  return { id, displayName: 'the card owner' } as AuthSession['user'];
}

/**
 * Applies a split (decision: atomic). Every child is checked first (`planSplit`); only when all pass are the children
 * created (with the parent as `parentCardId`, their repository and their dependencies), the parent cancelled with cause
 * `split`, and the thread note written, all in the caller's transaction. A failure while writing rolls the lot back to a
 * savepoint, so a half-split card never exists.
 */
async function applySplit(
  ctx: Ctx,
  tx: Tx,
  task: Row,
  shift: Row,
  card: Row,
  split: SpecCardSplitChild[],
): Promise<ReportResult> {
  const planned = await planSplit(tx, card, split);
  if ('problems' in planned)
    return {
      accepted: false,
      error: `the split was refused and nothing was written: ${planned.problems.join('. ')}`,
    };
  const owner = await splitOwner(tx, card);
  // An agent may not set a completion action: a card that carries an override is split by the system on the BA's behalf.
  const actor = card.completion_action ? SYSTEM_ACTOR : agentActor(shift.agent_id);
  // The parent's own prerequisites move to the children that start the work (the roots), and what waited on the parent
  // waits on the children that end it (the leaves): a cancelled card counts as landed, so without this a split would
  // start the children early and free the parent's dependents at once.
  const parentDeps = (
    await rows(tx, 'SELECT depends_on_card_id FROM card_dependencies WHERE card_id=$1', [card.id])
  ).map((d) => d.depends_on_card_id as string);
  await tx.query('SAVEPOINT spec_split');
  try {
    const made: Array<{ id: string; ref: string; title: string; repo: string }> = [];
    for (const [i, plan] of planned.plans.entries()) {
      const made1 = await createCardIn(
        ctx,
        tx,
        owner as AuthSession['user'],
        {
          projectId: card.project_id,
          title: plan.child.title,
          cardType: plan.cardType as CreateCardRequest['cardType'],
          fields: plan.fields,
          repoId: plan.repoId,
          priority: card.priority,
          docsNeeded: card.docs_needed === true,
          ...(plan.designNeeded !== undefined ? { designNeeded: plan.designNeeded } : {}),
          ...(plan.investigationOnly !== undefined ? { investigationOnly: plan.investigationOnly } : {}),
          ...(card.merge_main_first !== null && card.merge_main_first !== undefined
            ? { mergeMainFirst: card.merge_main_first }
            : {}),
          ...(card.completion_action ? { completionAction: card.completion_action } : {}),
          ...(plan.workflowKey ? { workflowKey: plan.workflowKey } : {}),
          dependencies: (plan.child.dependsOn ?? []).length
            ? [...new Set(plan.child.dependsOn ?? [])].map((d) => (made[d - 1] as { id: string }).id)
            : parentDeps,
          specify: true,
        },
        {
          actor,
          origin: PARENT_LINK_ORIGINS.has(card.origin) ? 'manual' : card.origin,
          parentCardId: card.id,
        },
      );
      if (made1.missing?.length)
        throw new Error(`child ${i + 1} would still lack ${missingText(made1.missing)}`);
      made.push({ id: made1.cardId, ref: made1.ref, title: plan.child.title, repo: plan.child.repo });
    }
    const dependedOn = new Set(planned.plans.flatMap((p) => p.child.dependsOn ?? []));
    const leaves = made.filter((_, i) => !dependedOn.has(i + 1)).map((c) => c.id);
    const downstream = await rows(
      tx,
      `SELECT c.id, c.org_id, c.project_id FROM card_dependencies d JOIN cards c ON c.id = d.card_id
        WHERE d.depends_on_card_id=$1 AND c.status NOT IN ('done','cancelled')`,
      [card.id],
    );
    for (const down of downstream) {
      const current = (
        await rows(tx, 'SELECT depends_on_card_id FROM card_dependencies WHERE card_id=$1', [down.id])
      ).map((d) => d.depends_on_card_id as string);
      await ctx.store.append(
        [
          {
            streamId: streamId.card(down.id),
            event: {
              type: 'CardUpdated',
              payload: {
                cardId: down.id,
                changes: { dependencies: [...new Set([...current.filter((d) => d !== card.id), ...leaves])] },
              },
            },
            actor,
            scope: projectScope(down.org_id, down.project_id),
          },
        ],
        { tx },
      );
    }
    const list = made.map((c) => `${c.ref} (${c.repo}): ${c.title}`).join('; ');
    await cancelCardIn(ctx, tx, owner, card, `Split into ${made.map((c) => c.ref).join(', ')}`, {
      cause: 'split',
      childCardIds: made.map((c) => c.id),
      actor: agentActor(shift.agent_id),
      note: `Split into ${made.length} cards, one per repository or section, and cancelled: ${list}. Follow the new cards.`,
    });
    await ctx.store.append([completed(task, 'done', `split into ${made.map((c) => c.ref).join(', ')}`)], {
      tx,
    });
    await tx.query('RELEASE SAVEPOINT spec_split');
    return { accepted: true };
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT spec_split');
    return {
      accepted: false,
      error: `the split was refused and nothing was written: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
  // Repository scoping is derived from the card now (no repository, several in the project), not stored on the task.
  const scoping = await needsRepoScoping(tx, card);
  if (report.outcomeId === SPEC_CARD_OUTCOME.fail) {
    const why =
      (report.note ?? '').trim().slice(0, 500) ||
      (scoping
        ? 'the repository could not be worked out from what the card says'
        : 'the BA could not specify the card from what it says');
    await needsSpecifyingItem(ctx, tx, task, card, why, scoping);
    await ctx.store.append([completed(task, 'done', why)], { tx });
    return { accepted: true };
  }
  if (report.outcomeId !== SPEC_CARD_OUTCOME.done)
    return {
      accepted: false,
      error: `outcome '${report.outcomeId}' is not available (allowed: ${SPEC_CARD_OUTCOME.done}, ${SPEC_CARD_OUTCOME.fail})`,
    };
  const parsed = SpecCardDataSchema.safeParse(report.data);
  if (!parsed.success) return { accepted: false, error: `invalid fields: ${parsed.error.message}` };
  const data: SpecCardData = parsed.data;
  if (scoping && !data.repo && !data.split)
    return {
      accepted: false,
      error: `${card.ref} has no repository: name the one it touches with "repo", or split it with "split" (2 to 8 cards, each with its own "repo"), or report that it cannot be specified`,
    };
  if (!scoping && data.split)
    return {
      accepted: false,
      error: `${card.ref} needs no repository from you: write its fields only`,
    };
  // The card got its repository meanwhile (the CEO or the owner set it): naming that same repository is no mistake.
  if (!scoping && data.repo) {
    const named = await resolveRepo(tx, card.project_id, data.repo).catch(() => null);
    if (!named || named !== card.repo_id)
      return {
        accepted: false,
        error: `${card.ref} needs no repository from you: write its fields only`,
      };
  }
  if (!scoping && !data.fields)
    return {
      accepted: false,
      error: 'write at least one field, or report that the card cannot be specified',
    };
  if (data.split) return applySplit(ctx, tx, task, shift, card, data.split);
  const owner = { id: card.owner_user_id } as AuthSession['user'];
  const acting = { actor: agentActor(shift.agent_id) };
  // The gateway commits a rejected report too, so the repository and the fields are written under a savepoint that a
  // rejection rolls back: a repository-only report must not leave the repository set on a card that is still incomplete.
  await tx.query('SAVEPOINT spec_report');
  try {
    await patchCardIn(
      ctx,
      tx,
      owner,
      card.id,
      {
        ...(data.fields ? { fields: data.fields } : {}),
        ...(scoping && data.repo ? { repoId: await resolveRepo(tx, card.project_id, data.repo) } : {}),
      },
      acting,
    );
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT spec_report');
    return {
      accepted: false,
      error: `${scoping && data.repo ? 'the repository or the fields' : 'the fields'} were refused: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const fresh = (await one(tx, 'SELECT * FROM cards WHERE id=$1', [card.id])) as Row;
  const stillMissing = await cardMissing(tx, fresh);
  if (stillMissing.length) {
    await tx.query('ROLLBACK TO SAVEPOINT spec_report');
    return {
      accepted: false,
      error: `${card.ref} still lacks ${missingText(stillMissing)}: write ${stillMissing.length === 1 ? 'it' : 'them'} and report again, the repository and the fields together (nothing of this report was kept)`,
    };
  }
  await tx.query('RELEASE SAVEPOINT spec_report');
  await specifyCardIn(ctx, tx, owner, card.id, acting);
  await ctx.store.append([completed(task, 'done')], { tx });
  return { accepted: true };
}

/** No BA took the task in time, or it failed twice: the card stays a draft and an alert says so. */
export async function runSpecCardFallback(ctx: Ctx, tx: Tx, task: Row): Promise<void> {
  const card = await one(tx, 'SELECT * FROM cards WHERE id=$1', [task.card_id]);
  if (card && card.status === 'draft') {
    const scoping = await needsRepoScoping(tx, card);
    await needsSpecifyingItem(
      ctx,
      tx,
      task,
      card,
      scoping
        ? 'no BA or architect was available to find its repository'
        : 'no BA was available to complete it',
      scoping,
    );
  }
  await ctx.store.append([completed(task, 'fallback', 'no BA was available to complete the card')], { tx });
}

void orgScope;
