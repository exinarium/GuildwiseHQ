import {
  budgetStatus,
  DESK_SUBKIND,
  formatMoney,
  HYGIENE_PROBLEM_LABEL,
  type HygieneProblemKind,
  QUESTION_LOOP,
  REPORTER,
  type SignalKind,
  type SignalSubject,
  type SignalUrgency,
  topicWords,
} from '@aom/shared';
import { COUNTED_QUESTION_SHIFT_SQL } from '../commands/loop-breaker.ts';
import type { Ctx } from '../context.ts';
import { monthOf, monthSpendByProject, orgCostCtx } from '../costs/index.ts';
import { iso, type Queryable, type Row, rows } from '../db/sql.ts';
import { cardWorkability } from '../queries/workability.ts';

/** One condition a detector found right now. */
export interface Detected {
  orgId: string;
  projectId: string | null;
  kind: SignalKind;
  fingerprint: string;
  urgency: SignalUrgency;
  /** The magnitude: failed shifts, asks, rework rounds ... */
  count: number;
  subject: SignalSubject;
  evidence: Record<string, unknown>;
}

const hours = (ms: number) => Math.floor(ms / 3600_000);

/**
 * The stage a question loop belongs to: the stage with the most counted question shifts (`stages` lists the stage of each
 * counted shift, oldest first); a tie goes to the latest. Shifts without a stage are skipped; null when none has one.
 */
export function questionLoopStage(stages: readonly (string | null)[]): string | null {
  const count = new Map<string, number>();
  const last = new Map<string, number>();
  stages.forEach((s, i) => {
    if (!s) return;
    count.set(s, (count.get(s) ?? 0) + 1);
    last.set(s, i);
  });
  let best: string | null = null;
  for (const [s, n] of count) {
    const b = best === null ? null : count.get(best)!;
    if (b === null || n > b || (n === b && last.get(s)! > last.get(best!)!)) best = s;
  }
  return best;
}

const stageEvidence = (stages: readonly (string | null)[]) => {
  const stage = questionLoopStage(stages);
  return stage ? { stage } : {};
};

/** Shift loop (B1): consumes the loop breaker's open episodes (`cards.retry_episode_id`). */
export async function detectLoops(db: Queryable): Promise<Detected[]> {
  const list = await rows(
    db,
    `SELECT c.id, c.ref, c.title, c.org_id, c.project_id, c.retry_failures, c.retry_episode_id, c.retry_after, p.key,
            (SELECT d.id FROM desk_items d WHERE d.card_id = c.id AND d.subkind = $2 AND d.status = 'open'
              ORDER BY d.created_at DESC LIMIT 1) AS alert_id
       FROM cards c JOIN projects p ON p.id = c.project_id
      WHERE c.retry_failures >= $1 AND c.retry_episode_id IS NOT NULL AND c.retry_after IS NOT NULL AND c.status NOT IN ('done','cancelled')
        AND p.status = 'active'
        -- a parked card has its own blocking desk item (loop_parked): no second signal for it
        AND NOT EXISTS (SELECT 1 FROM desk_items pd WHERE pd.card_id = c.id AND pd.subkind = $3 AND pd.status = 'open')`,
    [REPORTER.loop.failures, DESK_SUBKIND.loopBackoff, DESK_SUBKIND.loopParked],
  );
  const failing: Detected[] = list.map((c) => ({
    orgId: c.org_id,
    projectId: c.project_id,
    kind: 'loop' as const,
    fingerprint: `loop:card:${c.id}`,
    urgency: 'urgent' as const,
    count: c.retry_failures,
    subject: {
      title: `${c.ref} keeps failing`,
      detail: `${c.retry_failures} shifts ended without a report; the card is held back until ${iso(c.retry_after)}`,
      cardId: c.id,
      cardRef: c.ref,
      projectKey: c.key,
      ...(c.alert_id ? { deskItemId: c.alert_id } : {}),
    },
    evidence: { episodeId: c.retry_episode_id, cardTitle: c.title },
  }));
  // Question shifts count too (Lean Team v3): a card that caused 5 question shifts within 2 hours is going round,
  // whatever the questions said. One signal per card; it ends when the window has passed.
  const asking = await rows(
    db,
    `SELECT c.id, c.ref, c.title, c.org_id, c.project_id, p.key, count(*)::int AS n, max(s.started_at) AS last_at,
       array_agg(d.stage ORDER BY s.started_at) AS stages
       FROM shifts s JOIN desk_items d ON d.id = s.desk_item_id JOIN cards c ON c.id = d.card_id
       JOIN projects p ON p.id = c.project_id
      WHERE ${COUNTED_QUESTION_SHIFT_SQL} AND s.started_at > now() - make_interval(hours => $1) AND c.status NOT IN ('done','cancelled')
        AND p.status = 'active'
      GROUP BY c.id, c.ref, c.title, c.org_id, c.project_id, p.key HAVING count(*) >= $2`,
    [QUESTION_LOOP.windowHours, QUESTION_LOOP.shifts],
  );
  const failingIds = new Set(failing.map((f) => f.subject.cardId));
  const questions: Detected[] = asking
    .filter((c) => !failingIds.has(c.id))
    .map((c) => ({
      orgId: c.org_id,
      projectId: c.project_id,
      kind: 'loop' as const,
      fingerprint: `loop:questions:${c.id}`,
      urgency: 'urgent' as const,
      count: c.n,
      subject: {
        title: `${c.ref} keeps asking questions`,
        detail: `${c.n} question shifts in ${QUESTION_LOOP.windowHours} hours, whatever the wording`,
        cardId: c.id,
        cardRef: c.ref,
        projectKey: c.key,
      },
      evidence: { cardTitle: c.title, questionShifts: c.n, ...stageEvidence(c.stages) },
    }));
  return [...failing, ...questions];
}

/** The same DevOps or approval action asked 3 times in 24 h; urgent when the action was rejected before. */
export async function detectRepeatedApprovals(db: Queryable, now: Date): Promise<Detected[]> {
  const since = new Date(now.getTime() - REPORTER.repeatedApproval.windowHours * 3600_000);
  const list = await rows(
    db,
    `SELECT d.id, d.org_id, d.project_id, d.subkind, d.title, d.status, d.answer_option, d.created_at, p.key
       FROM desk_items d LEFT JOIN projects p ON p.id = d.project_id
      WHERE d.kind = 'approval' AND d.created_at > $1 AND d.triage <> 'pending'
      ORDER BY d.created_at, d.id`,
    [since],
  );
  // Cluster by organization and subkind, then by the words of the title (the action).
  const clusters: Array<{ rows: Row[]; words: Set<string> }> = [];
  for (const r of list) {
    const words = new Set(topicWords(String(r.title).replace(/^DevOps needs approval:\s*/i, '')));
    const hit = clusters.find((c) => {
      const first = c.rows[0] as Row;
      if (first.org_id !== r.org_id || first.subkind !== r.subkind) return false;
      if (words.size === 0 || c.words.size === 0) return first.title === r.title;
      let shared = 0;
      for (const w of words) if (c.words.has(w)) shared++;
      return shared / Math.min(words.size, c.words.size) >= REPORTER.repeatedApproval.similarity;
    });
    if (hit) {
      hit.rows.push(r);
      for (const w of words) hit.words.add(w);
    } else clusters.push({ rows: [r], words });
  }
  const out: Detected[] = [];
  for (const c of clusters) {
    if (c.rows.length < REPORTER.repeatedApproval.count) continue;
    const first = c.rows[0] as Row;
    const rejectedBefore = c.rows.some((r) => r.status === 'answered' && r.answer_option === 'rejected');
    const key = [...c.words].sort().slice(0, 6).join('-') || String(first.title).slice(0, 40);
    out.push({
      orgId: first.org_id,
      projectId: first.project_id,
      kind: 'repeated_approval',
      fingerprint: `approval:${first.subkind}:${key}`,
      urgency: rejectedBefore ? 'urgent' : 'normal',
      count: c.rows.length,
      subject: {
        title: String(first.title),
        detail: `Asked ${c.rows.length} times in ${REPORTER.repeatedApproval.windowHours} hours${rejectedBefore ? ', and rejected before' : ''}`,
        deskItemIds: c.rows.map((r) => r.id),
        wasRejected: rejectedBefore,
        ...(first.key ? { projectKey: first.key } : {}),
      },
      evidence: { subkind: first.subkind, askedAt: c.rows.map((r) => iso(r.created_at)) },
    });
  }
  return out;
}

/** Blocked longer than 4 h. */
export async function detectBlocked(db: Queryable, now: Date): Promise<Detected[]> {
  const cutoff = new Date(now.getTime() - REPORTER.blockedHours * 3600_000);
  const list = await rows(
    db,
    `SELECT c.id, c.ref, c.title, c.org_id, c.project_id, c.blocked_since, p.key,
            COALESCE((SELECT array_agg(d.title) FROM card_blockers b JOIN desk_items d ON d.id = b.desk_item_id
                       WHERE b.card_id = c.id AND d.status = 'open'), ARRAY[]::text[]) AS waiting_on
       FROM cards c JOIN projects p ON p.id = c.project_id
      WHERE c.status = 'blocked' AND c.blocked_since < $1 AND p.status = 'active'`,
    [cutoff],
  );
  return list.map((c) => ({
    orgId: c.org_id,
    projectId: c.project_id,
    kind: 'blocked' as const,
    fingerprint: `blocked:card:${c.id}`,
    urgency: 'normal' as const,
    count: 1,
    subject: {
      title: `${c.ref} has been blocked for ${hours(now.getTime() - new Date(c.blocked_since).getTime())} hours`,
      detail: (c.waiting_on as string[]).length
        ? `Waiting on: ${(c.waiting_on as string[]).join('; ')}`
        : 'Blocked with no open question',
      cardId: c.id,
      cardRef: c.ref,
      projectKey: c.key,
    },
    evidence: { blockedSince: iso(c.blocked_since), cardTitle: c.title },
  }));
}

/** Queued longer than 30 min with no agent able to take it (the card page's workability verdict). */
export async function detectUnclaimed(ctx: Ctx, now: Date): Promise<Detected[]> {
  const cutoff = new Date(now.getTime() - REPORTER.unclaimedMinutes * 60_000);
  const cards = await rows(
    ctx.pool,
    `SELECT c.*, p.key AS project_key FROM cards c JOIN projects p ON p.id = c.project_id
      WHERE c.status = 'queued' AND c.claim_id IS NULL AND c.queued_at < $1 AND p.status = 'active'
        AND (c.retry_after IS NULL OR c.retry_after < $2)`,
    [cutoff, now],
  );
  if (cards.length === 0) return [];
  const verdicts = await cardWorkability(ctx, cards);
  const out: Detected[] = [];
  for (const c of cards) {
    const v = verdicts.get(c.id);
    if (!v || v.ok) continue;
    out.push({
      orgId: c.org_id,
      projectId: c.project_id,
      kind: 'unclaimed',
      fingerprint: `unclaimed:card:${c.id}`,
      urgency: 'normal',
      count: 1,
      subject: {
        title: `${c.ref} is queued and nobody can take it`,
        detail: `${v.reason ?? ''} (queued since ${iso(c.queued_at)})`,
        cardId: c.id,
        cardRef: c.ref,
        projectKey: c.project_key,
      },
      evidence: { level: v.level, queuedAt: iso(c.queued_at), cardTitle: c.title },
    });
  }
  return out;
}

/** Repeated failures: 3 or more rework rounds on a card, 2 or more failed finalizes on a card. */
export async function detectFailures(db: Queryable): Promise<Detected[]> {
  const rework = await rows(
    db,
    `SELECT c.id, c.ref, c.title, c.org_id, c.project_id, c.rework_round, p.key
       FROM cards c JOIN projects p ON p.id = c.project_id
      WHERE c.rework_round >= $1 AND c.status NOT IN ('done','cancelled') AND p.status = 'active'`,
    [REPORTER.reworkRounds],
  );
  const finalize = await rows(
    db,
    `SELECT c.id, c.ref, c.title, c.org_id, c.project_id, p.key, count(*)::int AS n
       FROM desk_items d JOIN cards c ON c.id = d.card_id JOIN projects p ON p.id = c.project_id
      WHERE d.subkind = $1 AND c.status NOT IN ('done','cancelled') AND p.status = 'active'
      GROUP BY c.id, c.ref, c.title, c.org_id, c.project_id, p.key HAVING count(*) >= $2`,
    [DESK_SUBKIND.finalizeFailed, REPORTER.finalizeFailures],
  );
  return [
    ...rework.map((c) => ({
      orgId: c.org_id,
      projectId: c.project_id,
      kind: 'rework' as const,
      fingerprint: `rework:card:${c.id}`,
      urgency: 'normal' as const,
      count: c.rework_round,
      subject: {
        title: `${c.ref} is in rework round ${c.rework_round}`,
        detail: `Reviewers sent it back ${c.rework_round} times`,
        cardId: c.id,
        cardRef: c.ref,
        projectKey: c.key,
      },
      evidence: { cardTitle: c.title },
    })),
    ...finalize.map((c) => ({
      orgId: c.org_id,
      projectId: c.project_id,
      kind: 'finalize_failures' as const,
      fingerprint: `finalize:card:${c.id}`,
      urgency: 'normal' as const,
      count: c.n,
      subject: {
        title: `${c.ref} failed to finalize ${c.n} times`,
        detail: 'The completion action keeps failing',
        cardId: c.id,
        cardRef: c.ref,
        projectKey: c.key,
      },
      evidence: { cardTitle: c.title },
    })),
  ];
}

/**
 * Repository hygiene (docs/design/phases.md addendum): what a hygiene run could not resolve (a conflict, a dirty tree on a
 * different branch, an auth failure, a dead card's worktree with uncommitted changes) stays a signal until a later run
 * finds the repository in order. Normal urgency: the daily report carries it.
 */
export async function detectHygiene(db: Queryable): Promise<Detected[]> {
  const list = await rows(
    db,
    `SELECT f.*, w.name AS workstation_name, p.key AS project_key
       FROM hygiene_findings f JOIN workstations w ON w.id = f.workstation_id
       LEFT JOIN projects p ON p.id = f.project_id
      WHERE f.status = 'open' AND w.status = 'active' ORDER BY f.first_seen_at, f.id`,
  );
  return list.map((f) => ({
    orgId: f.org_id,
    projectId: f.project_id,
    kind: 'repo_hygiene' as const,
    fingerprint: `hygiene:${f.workstation_id}:${f.subject}:${f.kind}`,
    urgency: 'normal' as const,
    count: 1,
    subject: {
      title:
        f.kind === 'dirty_worktree'
          ? `Leftover worktree with changes on ${f.workstation_name}`
          : `${HYGIENE_PROBLEM_LABEL[f.kind as HygieneProblemKind] ?? f.kind}: ${f.subject_name}`,
      detail: `${f.detail}${f.files?.length ? ` Files: ${(f.files as string[]).slice(0, 8).join(', ')}${f.files.length > 8 ? ', ...' : ''}.` : ''} (workstation ${f.workstation_name})`,
      ...(f.project_key ? { projectKey: f.project_key } : {}),
    },
    evidence: { kind: f.kind, workstationId: f.workstation_id, subject: f.subject, files: f.files },
  }));
}

/**
 * Budgets (cost tracking): a project at 80% of its monthly budget is a normal-urgency signal (the daily report carries
 * it); at 100% and not overridden it is urgent (its dispatching is paused). The signal resolves by itself when the
 * budget is raised, overridden or the month turns. The fingerprint carries the month, so each month raises it afresh.
 */
export async function detectBudgets(db: Queryable, now: Date): Promise<Detected[]> {
  const projects = await rows(
    db,
    `SELECT id, org_id, key, name, budget_micros, budget_override_month FROM projects
      WHERE budget_micros IS NOT NULL AND status = 'active' ORDER BY created_at, id`,
  );
  const out: Detected[] = [];
  const ctxs = new Map<string, Awaited<ReturnType<typeof orgCostCtx>>>();
  const spends = new Map<string, Map<string, number>>();
  for (const p of projects) {
    let c = ctxs.get(p.org_id);
    if (!c) {
      c = await orgCostCtx(db, p.org_id);
      ctxs.set(p.org_id, c);
      spends.set(p.org_id, await monthSpendByProject(db, c, now));
    }
    const m = monthOf(c, now);
    const spend = spends.get(p.org_id)?.get(p.id) ?? 0;
    const budget = Number(p.budget_micros);
    const st = budgetStatus(budget, spend, p.budget_override_month === m.key);
    if (st.state !== 'warning' && st.state !== 'paused') continue;
    const paused = st.state === 'paused';
    out.push({
      orgId: p.org_id,
      projectId: p.id,
      kind: 'budget' as const,
      fingerprint: `budget:${p.id}:${m.key}:${paused ? 'paused' : 'warning'}`,
      urgency: paused ? ('urgent' as const) : ('normal' as const),
      count: 1,
      subject: {
        title: paused
          ? `${p.key} is paused: its monthly budget is used up`
          : `${p.key} has used ${Math.floor(st.percent ?? 0)}% of its monthly budget`,
        detail: `${formatMoney(spend, c.currency)} of ${formatMoney(budget, c.currency)} this month${paused ? '; running shifts finish, nothing new starts until the budget is raised or overridden' : ''}`,
        projectKey: p.key,
      },
      evidence: { month: m.key, spendMicros: spend, budgetMicros: budget, currency: c.currency },
    });
  }
  return out;
}

/**
 * A card the reviewer rated high risk (`cards.review_risk.level = 'high'`, report only) that has waited longer than
 * `REPORTER.highRiskWaitHours` on a manager or owner approval: the owner-approval stage, or a finalize (merge, push, PR)
 * that is awaiting approval. Only `high` counts: `unknown` (older runners) and NULL (reset on rework) never raise it.
 * Normal urgency, no automatic action. The clock is when the card last entered `waiting` (`card_transitions`), so edits while it waits do not restart it.
 * Custom workflow approval steps are not covered.
 */
export async function detectHighRiskWaiting(db: Queryable, now: Date): Promise<Detected[]> {
  // Custom workflow approval steps are not covered: only the built-in owner approval and finalize approval.
  const cutoff = new Date(now.getTime() - REPORTER.highRiskWaitHours * 3600_000);
  const list = await rows(
    db,
    `SELECT * FROM (
       SELECT c.id, c.ref, c.title, c.org_id, c.project_id, c.stage, c.finalize_state, p.key,
              COALESCE((SELECT max(t.at) FROM card_transitions t WHERE t.card_id = c.id AND t.to_status = 'waiting'),
                       c.updated_at) AS waiting_since
         FROM cards c JOIN projects p ON p.id = c.project_id
        WHERE c.status = 'waiting' AND p.status = 'active'
          AND (c.stage = 'owner_approval' OR c.finalize_state = 'awaiting_approval')
          AND c.review_risk->>'level' = 'high') w
      WHERE waiting_since < $1`,
    [cutoff],
  );
  return list.map((c) => ({
    orgId: c.org_id,
    projectId: c.project_id,
    kind: 'high_risk_waiting' as const,
    fingerprint: `high_risk_waiting:card:${c.id}`,
    urgency: 'normal' as const,
    count: 1,
    subject: {
      title: `${c.ref} is rated high risk and has waited ${hours(now.getTime() - new Date(c.waiting_since).getTime())} hours for approval`,
      detail:
        c.finalize_state === 'awaiting_approval'
          ? 'Waiting for approval to merge'
          : 'Waiting for the owner approval',
      cardId: c.id,
      cardRef: c.ref,
      projectKey: c.key,
    },
    evidence: { waitingSince: iso(c.waiting_since), cardTitle: c.title, stage: c.stage },
  }));
}

/** Every detector, run once. */
export async function detectAll(ctx: Ctx, now: Date): Promise<Detected[]> {
  return [
    ...(await detectLoops(ctx.pool)),
    ...(await detectRepeatedApprovals(ctx.pool, now)),
    ...(await detectBlocked(ctx.pool, now)),
    ...(await detectUnclaimed(ctx, now)),
    ...(await detectFailures(ctx.pool)),
    ...(await detectHygiene(ctx.pool)),
    ...(await detectBudgets(ctx.pool, now)),
    ...(await detectHighRiskWaiting(ctx.pool, now)),
  ];
}
