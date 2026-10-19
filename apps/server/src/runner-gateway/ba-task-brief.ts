import { randomUUID } from 'node:crypto';
import {
  BA_TASK_MAX_SHIFT_MINUTES,
  type BaTaskShift,
  baTaskBriefOutcomes,
  isReporterTaskKind,
  type ServerToRunnerOf,
  type ShiftBrief,
} from '@aom/shared';
import { loadRole } from '../catalogue/loader.ts';
import { graphScopeFor } from '../commands/graph.ts';
import { buildBatchTask } from '../commands/intake-batch.ts';
import { buildMailDraftTask } from '../commands/mail-draft.ts';
import { cardOutcomes, computeOutstanding, followupRows, suiteOf } from '../commands/phase-events.ts';
import { toTargetBrief } from '../commands/phase-followups.ts';
import { workingBranchOf } from '../commands/phases.ts';
import { buildReporterTask } from '../commands/reporter-tasks.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import { standingOrdersFor } from '../queries/ledger.ts';
import { agentSpecFor, shiftVault } from './brief.ts';

type ShiftStartPayload = Omit<ServerToRunnerOf<'shift.start'>, 'v' | 'id' | 'type' | 'ts'>;

/** The task a BA gets in its shift: the phase, its cards (with their suites), the follow-ups and what is outstanding. */
export async function buildBaTask(db: Queryable, task: Row): Promise<BaTaskShift | null> {
  const phase = await one(
    db,
    `SELECT ph.*, p.key AS project_key, p.working_branch AS project_branch FROM phases ph JOIN projects p ON p.id = ph.project_id WHERE ph.id=$1`,
    [task.phase_id],
  );
  if (!phase) return null;
  const snapshot = phase.card_outcomes as BaTaskShift['cards'];
  const outcomes = snapshot.length ? snapshot : await cardOutcomes(db, phase.id);
  const cards: BaTaskShift['cards'] = [];
  for (const o of outcomes) {
    const suite = o.outcome === 'finalized' ? await suiteOf(db, o.cardId) : undefined;
    cards.push({ ...o, ...(suite ? { suite: { ...suite, bugRefs: suite.bugRefs } } : {}) });
  }
  const list = await followupRows(db, phase.id);
  const targets = new Map<string, Row>();
  for (const f of list)
    if (f.target_id && !targets.has(f.target_id)) {
      const t = await one(db, 'SELECT * FROM deploy_targets WHERE id=$1', [f.target_id]);
      if (t) targets.set(f.target_id, t);
    }
  const first = outcomes.find((o) => o.outcome === 'finalized');
  const repoCard = first ? await one(db, 'SELECT * FROM cards WHERE id=$1', [first.cardId]) : undefined;
  const workingBranch = repoCard
    ? await workingBranchOf(db, repoCard, phase)
    : (phase.working_branch ?? phase.project_branch);
  return {
    taskId: task.id,
    kind: task.kind,
    phase: {
      id: phase.id,
      ref: phase.ref,
      name: phase.name,
      description: phase.description,
      status: phase.status,
      projectKey: phase.project_key,
      workingBranch,
    },
    cards,
    followups: list.map((f) => ({
      id: f.id,
      position: f.position,
      kind: f.kind,
      target: f.target_id && targets.has(f.target_id) ? toTargetBrief(targets.get(f.target_id) as Row) : null,
      platform: f.platform,
      instruction: f.instruction,
      note: f.note,
      status: f.status,
      delegate: f.delegate,
      brief: f.brief,
      resultSummary: f.result_summary,
      evidence: f.evidence ?? {},
    })),
    ...(task.followup_id ? { followupId: task.followup_id } : {}),
    outstanding: await computeOutstanding(db, outcomes),
  };
}

/**
 * The `shift.start` for a BA task. Like a DevOps shift it has no card or worktree, but the runner's shift machinery is
 * brief driven, so the brief carries the phase as a placeholder card and the real task travels in `baTask`.
 */
export async function buildBaTaskShiftStart(
  ctx: Ctx,
  taskId: string,
  shiftId: string,
): Promise<ShiftStartPayload | null> {
  const task = await one(ctx.pool, 'SELECT * FROM ba_tasks WHERE id=$1', [taskId]);
  if (!task) return null;
  const reporter = isReporterTaskKind(task.kind);
  const batch = task.kind === 'batch_intake';
  const mailDraft = task.kind === 'mail_reply_draft';
  if (!task.phase_id && !reporter && !batch && !mailDraft) return null;
  const agent = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [task.agent_id]);
  if (!agent) return null;
  const role = await loadRole(ctx.pool, agent.org_id, agent.role_key, agent.role_version);
  const batchTask = batch ? await buildBatchTask(ctx.pool, task) : null;
  const mailTask = mailDraft ? await buildMailDraftTask(ctx.pool, task) : null;
  const baTask: BaTaskShift | null = mailDraft
    ? mailTask
      ? { taskId: task.id, kind: task.kind, mailDraft: mailTask, cards: [], followups: [], outstanding: [] }
      : null
    : batch
      ? batchTask
        ? { taskId: task.id, kind: task.kind, batch: batchTask, cards: [], followups: [], outstanding: [] }
        : null
      : reporter
        ? {
            taskId: task.id,
            kind: task.kind,
            cards: [],
            followups: [],
            outstanding: [],
            reporter: await buildReporterTask(ctx, ctx.pool, task),
          }
        : await buildBaTask(ctx.pool, task);
  const project = await one(ctx.pool, 'SELECT * FROM projects WHERE id=$1', [task.project_id]);
  if (!role || !baTask || !project) return null;
  const brief: ShiftBrief = {
    shift: {
      id: shiftId,
      kind: 'ba_task',
      stage: 'ba_task',
      stageLabel: mailDraft
        ? 'Mail reply draft'
        : batch
          ? 'Batch intake'
          : reporter
            ? 'Reporter task'
            : 'Phase task',
      doneCriteria: 'The task is reported to the manager with the command for it.',
      outcomes: baTaskBriefOutcomes(task.kind),
      maxShiftMinutes: BA_TASK_MAX_SHIFT_MINUTES,
    },
    agent: { id: agent.id, name: agent.name, seniority: agent.seniority },
    card: {
      id: baTask.phase?.id ?? task.id,
      ref:
        baTask.phase?.ref ?? (mailDraft ? 'MAIL' : batch ? (baTask.batch?.ticketKey ?? 'BATCH') : 'REPORT'),
      title:
        baTask.phase?.name ??
        (mailDraft
          ? 'Draft an e-mail reply'
          : batch
            ? `Batch intake: ${baTask.batch?.ticketKey}`
            : 'Report to the manager'),
      cardType: 'support',
      fields: {},
      riskTier: null,
      reworkRound: 0,
      completionAction: null,
      docsNeeded: false,
      dependencies: [],
    },
    project: {
      id: project.id,
      key: project.key,
      name: project.name,
      workingBranch: baTask.phase?.workingBranch ?? project.working_branch ?? 'main',
      e2eGlobs: [],
      architecturalGlobs: [],
    },
    role: {
      key: role.definition.key,
      name: role.definition.name,
      instructions: role.definition.instructions,
      coreRules: role.definition.coreRules,
      skills: agent.skills,
    },
    handoffs: [],
    reviewComments: [],
    thread: [],
    standingOrders: await standingOrdersFor(ctx.pool, project.org_id, project.id),
    ledger: [],
  };
  return {
    shiftId,
    claimId: randomUUID(),
    kind: 'ba_task',
    agent: await agentSpecFor(ctx, agent),
    brief,
    worktree: null,
    prepare: { rebase: false },
    maxShiftMinutes: BA_TASK_MAX_SHIFT_MINUTES,
    baTask,
    vault: await shiftVault(ctx, agent, project.id),
    ...(await graphScopeFor(ctx, project.id).then((graph) => (graph ? { graph } : {}))),
  };
}
