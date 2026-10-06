import {
  HR_RULES,
  HR_WINDOW_DAYS,
  isThinSpec,
  LEDGER_SEARCH_STANDING_ORDER,
  REWORK_REASON_LABEL,
  REWORK_STANDING_ORDER,
  type Recommendation,
  type RecommendationKind,
  type ReworkReason,
  shiftModel,
  THIN_SPEC_STANDING_ORDER,
  topicWords,
} from '@aom/shared';
import { suggestNames } from '../commands/agents.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { computeTrack, type StatsAgent, windowStart } from './track-record.ts';

/** A recommendation before per-user filtering: `ownerOnly` ones (standing orders) need the organization owner. */
export interface OrgRecommendation extends Omit<Recommendation, 'canApply'> {
  ownerOnly: boolean;
}

const pct = (n: number | null): string => (n === null ? 'n/a' : `${Math.round(n * 100)}%`);
const trunc = (s: string, n = 140): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Rule-based HR recommendations for one organization over the rolling window ending at `now`. Every rule needs a minimum
 * sample (`HR_RULES`) and cites the numbers and cards that triggered it. Failures are attributed to the stage that
 * caused them: an unclear spec is the spec author's, a bounce-everything reviewer shows on the reviewer's own card.
 * Recommendations applied within the window are left out.
 */
export async function computeRecommendations(
  ctx: Ctx,
  orgId: string,
  now: Date = ctx.clock.now(),
): Promise<OrgRecommendation[]> {
  const from = windowStart(now);
  const agentRows = await rows(
    ctx.pool,
    `SELECT * FROM agents WHERE org_id=$1 AND status='active' AND NOT is_devops ORDER BY hired_at, id`,
    [orgId],
  );
  if (agentRows.length === 0) return [];
  const agents: StatsAgent[] = agentRows.map((a) => ({
    id: a.id,
    roleKey: a.role_key,
    hiredAt: new Date(a.hired_at),
    retired: false,
  }));
  const track = await computeTrack(ctx.pool, agents, now);
  const byId = new Map(agentRows.map((a) => [a.id as string, a]));
  const recs: OrgRecommendation[] = [];
  const push = (r: OrgRecommendation) => recs.push(r);
  const mk = (
    kind: RecommendationKind,
    subject: string,
    a: Row | null,
    roleKey: string | null,
    r: Omit<OrgRecommendation, 'id' | 'kind' | 'agentId' | 'agentName' | 'roleKey'>,
  ): OrgRecommendation => ({
    id: `${kind}:${subject}`,
    kind,
    agentId: a?.id ?? null,
    agentName: a?.name ?? null,
    roleKey: roleKey ?? a?.role_key ?? null,
    ...r,
  });

  // ---------------------------------------------------------------------------------------------------- blocked
  const questions = await rows(
    ctx.pool,
    `SELECT d.id, d.title, d.status, d.answer, d.answered_at, d.dedup_ledger_ids, d.asked_by_agent_id, d.created_at,
            c.ref, c.id AS card_id, c.fields
       FROM desk_items d LEFT JOIN cards c ON c.id = d.card_id
      WHERE d.org_id=$1 AND d.kind='question' AND d.asked_by_kind='agent' AND d.created_at >= $2
      ORDER BY d.created_at, d.id`,
    [orgId, from],
  );
  for (const a of agentRows) {
    const t = track.get(a.id);
    if (!t || t.raw.touched < HR_RULES.minCards) continue;
    const blockedRate = t.raw.blocked / t.raw.touched;
    if (blockedRate < HR_RULES.blockedRate) continue;
    const qs = questions.filter((q) => q.asked_by_agent_id === a.id);
    if (qs.length === 0) continue;
    const metrics = [
      { label: 'Blocked rate', value: `${pct(blockedRate)} (${t.raw.blocked} of ${t.raw.touched} cards)` },
    ];

    const known = qs.filter((q) => (q.dedup_ledger_ids ?? []).length > 0);
    if (known.length / qs.length >= HR_RULES.ledgerMissRate) {
      push(
        mk('blocked_ledger', a.id, a, null, {
          title: `${a.name} asks what the ledger already answers`,
          summary: `${known.length} of ${qs.length} questions had a similar ledger entry when they were asked: ledger search is failing, so agents re-ask settled questions.`,
          evidence: {
            metrics: [
              ...metrics,
              { label: 'Questions with a ledger match', value: `${known.length} of ${qs.length}` },
            ],
            items: known.slice(0, 5).map((q) => ({ text: trunc(q.title), ...(q.ref ? { ref: q.ref } : {}) })),
          },
          action: { type: 'standing_order', text: LEDGER_SEARCH_STANDING_ORDER, topic: 'ledger search' },
          ownerOnly: true,
        }),
      );
    }

    // Questions that cluster on one topic: the commonest keyword shared by enough of them.
    const counts = new Map<string, number>();
    for (const q of qs) for (const w of topicWords(q.title)) counts.set(w, (counts.get(w) ?? 0) + 1);
    const top = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
    if (top && top[1] >= HR_RULES.topicQuestions) {
      const [word, n] = top;
      const cluster = qs.filter((q) => topicWords(q.title).includes(word));
      const answered = [...cluster].reverse().find((q) => q.status === 'answered' && q.answer);
      push(
        mk('blocked_topic', `${a.id}:${word}`, a, null, {
          title: `${a.name}'s questions cluster on "${word}"`,
          summary: `${n} questions mention "${word}". A standing order stops the repeat questions.`,
          evidence: {
            metrics: [...metrics, { label: `Questions about "${word}"`, value: String(n) }],
            items: cluster
              .slice(0, 5)
              .map((q) => ({ text: trunc(q.title), ...(q.ref ? { ref: q.ref } : {}) })),
          },
          action: {
            type: 'standing_order',
            topic: word,
            text: answered
              ? `On "${word}": ${trunc(answered.answer, 400)}`
              : `Questions about "${word}" keep coming up: ask the manager once and record the answer as a standing order.`,
          },
          ownerOnly: true,
        }),
      );
    }
  }

  // Thin specs behind the questions: the fix is the spec author's, not the builder's.
  {
    const blockedCards = new Map<string, Row>();
    for (const q of questions) if (q.card_id && !blockedCards.has(q.card_id)) blockedCards.set(q.card_id, q);
    const thin = [...blockedCards.values()].filter((q) => isThinSpec(q.fields));
    if (blockedCards.size >= HR_RULES.minCards && thin.length / blockedCards.size >= HR_RULES.thinSpecShare) {
      // The author of a spec: whoever wrote its spec handoff, else (M7) the BA of the intake that drafted the card.
      const authors = await rows(
        ctx.pool,
        `SELECT c.id AS card_id,
                COALESCE((SELECT h.agent_id FROM card_handoffs h WHERE h.card_id = c.id AND h.stage='spec'
                           AND h.agent_id IS NOT NULL ORDER BY h.event_seq DESC LIMIT 1),
                         (SELECT i.ba_agent_id FROM intake_cards ic JOIN intakes i ON i.id = ic.intake_id
                           WHERE ic.card_id = c.id AND c.origin = 'intake' LIMIT 1)) AS agent_id
           FROM cards c WHERE c.id = ANY($1::uuid[])`,
        [thin.map((q) => q.card_id)],
      );
      const counts = new Map<string, number>();
      for (const au of authors.filter((x) => x.agent_id))
        counts.set(au.agent_id, (counts.get(au.agent_id) ?? 0) + 1);
      const authorId = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
      const ba = authorId ? (byId.get(authorId) ?? null) : null;
      push(
        mk('blocked_thin_specs', ba?.id ?? 'manager', ba, 'ba', {
          title: ba ? `${ba.name}'s specs are too thin` : 'Specs are too thin',
          summary: `${thin.length} of ${blockedCards.size} blocked cards had a thin spec (fewer than two acceptance criteria or almost no requirements). The fix is the spec quality, not the builder.`,
          evidence: {
            metrics: [
              { label: 'Blocked cards with a thin spec', value: `${thin.length} of ${blockedCards.size}` },
            ],
            items: thin.slice(0, 5).map((q) => ({ text: trunc(q.title), ref: q.ref })),
          },
          action: { type: 'standing_order', text: THIN_SPEC_STANDING_ORDER, topic: 'spec quality' },
          ownerOnly: true,
        }),
      );
    }
  }

  // ------------------------------------------------------------------------------------------------- per agent
  const reviewRows = await rows(
    ctx.pool,
    `SELECT l.*, c.ref FROM agent_review_log l JOIN cards c ON c.id = l.card_id
      WHERE l.org_id=$1 AND l.at >= $2 ORDER BY l.at, l.id`,
    [orgId, from],
  );
  const names = await suggestNames(ctx, orgId, undefined, 20);
  let nameIx = 0;

  for (const a of agentRows) {
    const t = track.get(a.id);
    if (!t) continue;
    const r = t.raw;
    const mine = reviewRows.filter((l) => l.builder_agent_id === a.id);

    // ------------------------------------------------------------------------------------------------ rework
    if (r.submitted >= HR_RULES.minCards) {
      const byReason = new Map<ReworkReason, Row[]>();
      for (const l of mine.filter((x) => x.verdict === 'changes'))
        for (const reason of l.reasons as ReworkReason[])
          byReason.set(reason, [...(byReason.get(reason) ?? []), l]);
      for (const [reason, logs] of byReason) {
        const order = REWORK_STANDING_ORDER[reason];
        if (!order || logs.length < HR_RULES.reasonRecurring) continue;
        push(
          mk('rework_reason', `${a.id}:${reason}`, a, null, {
            title: `${a.name}'s work keeps coming back: ${REWORK_REASON_LABEL[reason].toLowerCase()}`,
            summary: `${logs.length} review bounces in ${HR_WINDOW_DAYS} days cite "${REWORK_REASON_LABEL[reason]}". A standing order addresses the recurring cause.`,
            evidence: {
              metrics: [
                {
                  label: 'Rework rate',
                  value: `${pct(r.reworked / r.submitted)} (${r.reworked} of ${r.submitted} cards)`,
                },
                { label: REWORK_REASON_LABEL[reason], value: `${logs.length} bounces` },
              ],
              items: logs.slice(0, 5).map((l) => ({ text: `Bounced with score ${l.score}`, ref: l.ref })),
            },
            action: { type: 'standing_order', text: order, topic: REWORK_REASON_LABEL[reason] },
            ownerOnly: true,
          }),
        );
      }
    }

    // --------------------------------------------------------------------------------------------- model up
    const up = shiftModel(a.model, 1);
    if (up && r.large >= HR_RULES.minLargeCards) {
      const rework = r.reworkedLarge / r.large;
      const bug = r.buggyLarge / r.large;
      if (rework >= HR_RULES.largeFailRate || bug >= HR_RULES.largeFailRate) {
        push(
          mk('model_up', a.id, a, null, {
            title: `${a.name} struggles on large cards: try ${up}`,
            summary: `On large cards ${r.reworkedLarge} of ${r.large} came back from review and ${r.buggyLarge} failed test. A stronger model should do better there.`,
            evidence: {
              metrics: [
                { label: 'Large cards', value: String(r.large) },
                { label: 'Rework rate on large cards', value: pct(rework) },
                { label: 'Bug rate on large cards', value: pct(bug) },
                { label: 'Current model', value: a.model },
              ],
              items: [],
            },
            action: { type: 'change_model', agentId: a.id, model: up, fromModel: a.model },
            ownerOnly: false,
          }),
        );
      }
    }

    // ------------------------------------------------------------------------------------------- model down
    const down = shiftModel(a.model, -1);
    if (
      down &&
      r.submitted >= HR_RULES.minCardsDown &&
      r.reworked / r.submitted <= HR_RULES.lowReworkRate &&
      r.buggy === 0 &&
      r.small / r.submitted >= HR_RULES.smallShare
    ) {
      push(
        mk('model_down', a.id, a, null, {
          title: `${a.name} does small, clean work: ${down} would do`,
          summary: `${r.small} of ${r.submitted} cards were small, with ${pct(r.reworked / r.submitted)} rework and no bugs. A cheaper model would do the same work with fewer tokens.`,
          evidence: {
            metrics: [
              { label: 'Cards submitted', value: String(r.submitted) },
              { label: 'Small cards', value: `${r.small} of ${r.submitted}` },
              { label: 'Rework rate', value: pct(r.reworked / r.submitted) },
              { label: 'Bugs escaped', value: String(r.buggy) },
              { label: 'Current model', value: a.model },
            ],
            items: [],
          },
          action: { type: 'change_model', agentId: a.id, model: down, fromModel: a.model },
          ownerOnly: false,
        }),
      );
    }

    // -------------------------------------------------------------------------------------------- split role
    const tiers = (a.permissions?.riskTiers ?? ['small', 'large']) as string[];
    if (
      r.submitted >= HR_RULES.splitMinCards &&
      r.small >= HR_RULES.splitMinEach &&
      r.large >= HR_RULES.splitMinEach &&
      tiers.includes('small') &&
      tiers.includes('large')
    ) {
      const juniorName = names[nameIx++] ?? `${a.name} Jr`;
      push(
        mk('split_role', a.id, a, null, {
          title: `Split ${a.name}'s role by card size`,
          summary: `Its cards vary widely: ${r.large} large and ${r.small} small. A strong-model senior for large cards and a light-model junior for small ones; the dispatcher routes by risk tier.`,
          evidence: {
            metrics: [
              { label: 'Large cards', value: String(r.large) },
              { label: 'Small cards', value: String(r.small) },
              { label: 'Current model', value: a.model },
            ],
            items: [],
          },
          action: {
            type: 'split_role',
            agentId: a.id,
            roleKey: a.role_key,
            seniorModel: shiftModel(a.model, 1) ?? a.model,
            juniorModel: shiftModel(a.model, -1) ?? a.model,
            juniorName,
          },
          ownerOnly: false,
        }),
      );
    }

    // ------------------------------------------------------------------------------------ fire: low scores
    if (mine.length >= HR_RULES.minReviews) {
      const avg = (xs: Row[]) => xs.reduce((s, l) => s + Number(l.score), 0) / xs.length;
      const large = mine.filter((l) => l.risk_tier === 'large');
      const small = mine.filter((l) => l.risk_tier !== 'large');
      if (
        large.length > 0 &&
        small.length > 0 &&
        avg(mine) <= HR_RULES.lowScore &&
        avg(large) <= HR_RULES.lowScore &&
        avg(small) <= HR_RULES.lowScore
      ) {
        push(
          mk('fire_quality', a.id, a, null, {
            title: `${a.name}'s review scores are low on every card size`,
            summary: `Average reviewer score ${avg(mine).toFixed(1)} of 5 over ${mine.length} reviews, low on large and small cards alike. Firing also clears any cached context that may cause the failures; hire a fresh profile.`,
            evidence: {
              metrics: [
                { label: 'Average score', value: avg(mine).toFixed(1) },
                { label: 'Large cards', value: `${avg(large).toFixed(1)} (${large.length})` },
                { label: 'Small cards', value: `${avg(small).toFixed(1)} (${small.length})` },
              ],
              items: mine.slice(-5).map((l) => ({ text: `Score ${l.score}, ${l.verdict}`, ref: l.ref })),
            },
            action: { type: 'fire', agentId: a.id },
            ownerOnly: false,
          }),
        );
      }
    }

    // ------------------------------------------------------------------------------------- reviewer strict
    const given = reviewRows.filter((l) => l.reviewer_agent_id === a.id);
    if (given.length >= HR_RULES.strictMinReviews) {
      const bounced = given.filter((l) => l.verdict === 'changes').length;
      if (bounced / given.length >= HR_RULES.strictBounceRate) {
        push(
          mk('reviewer_strict', a.id, a, null, {
            title: `${a.name} bounces almost every card`,
            summary: `${bounced} of ${given.length} reviews asked for changes. That is the reviewer's pattern, not the builders': check its standards before blaming them.`,
            evidence: {
              metrics: [
                {
                  label: 'Bounce rate',
                  value: `${pct(bounced / given.length)} (${bounced} of ${given.length})`,
                },
              ],
              items: given.slice(-5).map((l) => ({ text: `Score ${l.score}, ${l.verdict}`, ref: l.ref })),
            },
            action: { type: 'none' },
            ownerOnly: false,
          }),
        );
      }
    }

    // ----------------------------------------------------------------------------------- fire: idle (empty queue)
    const sinceMs = now.getTime() - Math.max(from.getTime(), new Date(a.hired_at).getTime());
    const util = Math.min(1, r.shiftMs / r.availableMs);
    if (sinceMs >= HR_RULES.idleMinDays * 86_400_000 && util < HR_RULES.lowUtilisation) {
      const sameRole = agentRows.filter((o) => o.role_key === a.role_key && o.id !== a.id);
      // Another agent covers this one when it may work every project this one may.
      const covers = (o: Row) =>
        a.allowed_project_ids === null ||
        o.allowed_project_ids === null ||
        (a.allowed_project_ids as string[]).every((x) => (o.allowed_project_ids as string[]).includes(x));
      if (sameRole.some(covers)) {
        const queued = await one<{ n: number }>(
          ctx.pool,
          `SELECT count(*)::int AS n FROM cards c
             JOIN workflow_stages st ON st.workflow_version_id = c.workflow_version_id AND st.stage_id = c.stage
            WHERE c.org_id=$1 AND c.status='queued' AND c.claim_id IS NULL AND st.kind='agent' AND st.claim_role=$2
              AND ($3::uuid[] IS NULL OR c.project_id = ANY ($3::uuid[]))`,
          [orgId, a.role_key, a.allowed_project_ids ?? null],
        );
        if (Number(queued?.n ?? 0) === 0) {
          push(
            mk('fire_idle', a.id, a, null, {
              title: `${a.name} has been idle: fire or reassign`,
              summary: `On shift ${pct(util)} of the time for ${Math.floor(sinceMs / 86_400_000)} days while no ${a.role_key} work waits and ${sameRole.length} other ${a.role_key}${sameRole.length === 1 ? ' is' : 's are'} on the team. Idle agents cost no tokens, so this is about team size, not spend.`,
              evidence: {
                metrics: [
                  { label: 'Utilisation', value: pct(util) },
                  { label: 'Queue for the role', value: 'empty' },
                  { label: 'Other agents in the role', value: String(sameRole.length) },
                ],
                items: [],
              },
              action: { type: 'fire', agentId: a.id },
              ownerOnly: false,
            }),
          );
        }
      }
    }
  }

  // Applied recommendations stay out while their evidence window still holds the cause.
  const applied = new Set(
    (
      await rows<{ recommendation_id: string }>(
        ctx.pool,
        'SELECT recommendation_id FROM hr_applied WHERE org_id=$1 AND applied_at >= $2',
        [orgId, from],
      )
    ).map((x) => x.recommendation_id),
  );
  return recs.filter((r) => !applied.has(r.id));
}
