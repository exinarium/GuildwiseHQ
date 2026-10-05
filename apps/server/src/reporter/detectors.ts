import {
  DESK_SUBKIND,
  REPORTER,
  type SignalKind,
  type SignalSubject,
  type SignalUrgency,
  topicWords,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
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

/** Shift loop (B1): consumes the loop breaker's open episodes (`cards.retry_episode_id`). */
export async function detectLoops(db: Queryable): Promise<Detected[]> {
  const list = await rows(
    db,
    `SELECT c.id, c.ref, c.title, c.org_id, c.project_id, c.retry_failures, c.retry_episode_id, c.retry_after, p.key,
            (SELECT d.id FROM desk_items d WHERE d.card_id = c.id AND d.subkind = $2 AND d.status = 'open'
              ORDER BY d.created_at DESC LIMIT 1) AS alert_id
       FROM cards c JOIN projects p ON p.id = c.project_id
      WHERE c.retry_failures >= $1 AND c.retry_episode_id IS NOT NULL AND c.retry_after IS NOT NULL AND c.status NOT IN ('done','cancelled')
        AND p.status = 'active'`,
    [REPORTER.loop.failures, DESK_SUBKIND.loopBackoff],
  );
  return list.map((c) => ({
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

/** Every detector, run once. */
export async function detectAll(ctx: Ctx, now: Date): Promise<Detected[]> {
  return [
    ...(await detectLoops(ctx.pool)),
    ...(await detectRepeatedApprovals(ctx.pool, now)),
    ...(await detectBlocked(ctx.pool, now)),
    ...(await detectUnclaimed(ctx, now)),
    ...(await detectFailures(ctx.pool)),
  ];
}
