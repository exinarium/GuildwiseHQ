import { BA_ROLE_KEY, getStage, isSuiteOrigin, resolveOutcome } from '@aom/shared';
import { loadWorkflowById, resolveWorkflow, type WorkflowVersionRow } from '../catalogue/loader.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import { workflowView } from './cards.ts';

/**
 * How a card gets into manual QA and who gets it (docs/design/manual-qa.md). Pure reads: the commands that act on a
 * card (`finalize.ts`, `qa.ts`, `drafts.ts`) call these inside their own transaction.
 */

export const QA_STEPS_STAGE = 'qa_steps';
export const QA_STAGE = 'manual_qa';
export const QA_ROLE_KEYS = ['tester', BA_ROLE_KEY];

/** Is the card in one of the built-in QA stages? (A custom workflow's QA step is found by `qaStageOf`.) */
export const inQaStage = (card: { stage?: string }): boolean =>
  card.stage === QA_STEPS_STAGE || card.stage === QA_STAGE;

/**
 * The QA step the card is in: a built-in QA stage, or a `human` step with purpose `qa` of a custom workflow or a project
 * variant. Null when the card is not at a QA step.
 */
export async function qaStageOf(db: Queryable, card: Row): Promise<string | null> {
  if (inQaStage(card)) return card.stage;
  const wf = await loadWorkflowById(db, card.workflow_version_id);
  const st = wf ? getStage(wf.definition, card.stage) : undefined;
  return st?.kind === 'human' && st.human?.purpose === 'qa' ? st.id : null;
}

/** The purpose of the person's step the card is in (`qa` or `approval`), or null. */
export async function humanPurposeOf(db: Queryable, card: Row): Promise<'qa' | 'approval' | null> {
  if (card.stage === QA_STAGE) return 'qa';
  const wf = await loadWorkflowById(db, card.workflow_version_id);
  const st = wf ? getStage(wf.definition, card.stage) : undefined;
  return st?.kind === 'human' ? (st.human?.purpose ?? null) : null;
}

/**
 * Does manual QA apply to this card at all? The project setting is on, and the card is not an investigation (nothing to
 * test), a scheduled/automatic card (nobody started it) or a suite card.
 */
export async function manualQaApplies(db: Queryable, card: Row): Promise<boolean> {
  if (card.investigation_only || card.scheduled || isSuiteOrigin(card.origin)) return false;
  const p = await one(db, 'SELECT manual_qa FROM projects WHERE id=$1', [card.project_id]);
  return p?.manual_qa ?? true;
}

/** Is an active tester or business analyst hired who may work this card's project (so the QA steps can be written)? */
export async function qaAgentAvailable(db: Queryable, card: Row): Promise<boolean> {
  const r = await one(
    db,
    `SELECT 1 FROM agents a
      WHERE a.org_id = $1 AND a.status = 'active' AND NOT a.is_devops AND a.role_key = ANY($3::text[])
        AND (a.allowed_project_ids IS NULL OR $2::uuid = ANY (a.allowed_project_ids)) LIMIT 1`,
    [card.org_id, card.project_id, QA_ROLE_KEYS],
  );
  return !!r;
}

export interface FinalizeNext {
  /** Where the card goes when the completion action has run. */
  toStage: 'done' | 'qa_steps' | 'manual_qa';
  /** A card pinned to an older built-in `code` version moves to the version that has the QA stages. */
  workflowVersionId?: string;
  /** The workflow definition the decision was made on. */
  workflow: WorkflowVersionRow | null;
}

/**
 * The stage a card enters after the completion action ran. Evaluates the pinned workflow's `finalize.finalized` outcome
 * with the derived flags (`manualQa`, `qaAgent`); `when` guards skip the QA stages as for any other stage. A card on
 * an older built-in `code` version (v1/v2: same stages up to Finalize) is upgraded to the newest built-in version when
 * that one has the QA stages, so in-flight cards follow the project setting too.
 */
export async function finalizeNext(db: Queryable, card: Row): Promise<FinalizeNext> {
  let wf = await loadWorkflowById(db, card.workflow_version_id);
  if (!wf) return { toStage: 'done', workflow: null };
  let upgraded: string | undefined;
  if (wf.definition.builtIn && wf.definition.key === 'code' && !getStage(wf.definition, QA_STAGE)) {
    const latest = await resolveWorkflow(db, card.org_id, 'code', card.project_id, { classic: true });
    if (
      latest &&
      latest.orgId === null &&
      latest.version > wf.version &&
      getStage(latest.definition, QA_STAGE)
    ) {
      wf = latest;
      upgraded = latest.id;
    }
  }
  if (!getStage(wf.definition, 'finalize')?.outcomes.some((o) => o.id === 'finalized'))
    return { toStage: 'done', workflow: wf };
  const applies = await manualQaApplies(db, card);
  const view = {
    ...workflowView(card),
    manualQa: applies,
    qaAgent: applies && (await qaAgentAvailable(db, card)),
  };
  let to: string;
  try {
    to = resolveOutcome(wf.definition, view, 'finalize', 'finalized').toStage;
  } catch {
    to = 'done';
  }
  const toStage = to === QA_STEPS_STAGE || to === QA_STAGE ? to : 'done';
  return {
    toStage,
    workflow: wf,
    ...(toStage !== 'done' && upgraded ? { workflowVersionId: upgraded } : {}),
  };
}

/**
 * Will this card pass through manual QA (or is it in it)? The BA's outgoing ticket comment is held for such a card.
 * A card that is done or cancelled, or one the QA does not apply to, posts as it always did.
 */
export async function cardGoesThroughQa(db: Queryable, card: Row): Promise<boolean> {
  if (card.status === 'done' || card.status === 'cancelled') return false;
  if (inQaStage(card)) return true;
  return (await finalizeNext(db, card)).toStage !== 'done';
}

export type QaAssigneeSource = 'starter' | 'owner' | 'project_owner' | 'reassigned';

const activeMember = async (db: Queryable, projectId: string, userId: string): Promise<boolean> =>
  !!(await one(db, `SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2 AND status='active'`, [
    projectId,
    userId,
  ]));

/**
 * Who tests the card: the person who started the intake chat or batch that made it, else the card's creator (its owner),
 * else the project owner; always an active member of the project. A person it was handed to earlier stays assigned.
 */
export async function qaAssignee(
  db: Queryable,
  card: Row,
): Promise<{ userId: string; source: QaAssigneeSource } | null> {
  const prev = card.qa as { assigneeUserId?: string; source?: QaAssigneeSource } | null;
  if (prev?.assigneeUserId && (await activeMember(db, card.project_id, prev.assigneeUserId)))
    return { userId: prev.assigneeUserId, source: prev.source ?? 'owner' };
  const starter = await one(
    db,
    `SELECT i.started_by FROM intake_cards ic JOIN intakes i ON i.id = ic.intake_id
      WHERE ic.card_id=$1 ORDER BY ic.created_at LIMIT 1`,
    [card.id],
  );
  if (starter?.started_by && (await activeMember(db, card.project_id, starter.started_by)))
    return { userId: starter.started_by, source: 'starter' };
  if (card.owner_user_id && (await activeMember(db, card.project_id, card.owner_user_id)))
    return { userId: card.owner_user_id, source: 'owner' };
  const owner = await one(
    db,
    `SELECT user_id FROM project_members WHERE project_id=$1 AND role='owner' AND status='active' LIMIT 1`,
    [card.project_id],
  );
  return owner ? { userId: owner.user_id, source: 'project_owner' } : null;
}
