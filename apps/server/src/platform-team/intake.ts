import {
  BUG_COUNTER_MILESTONES,
  type BugSeverity,
  type BugSource,
  CRITICAL_REPEATS,
  type FixSize,
  INTAKE_NEW_CARDS_PER_HOUR,
  type PauseScope,
  type TriageBugRequest,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { cancelCardIn, createCardIn } from '../commands/cards.ts';
import { cardMessage } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';
import { notifyPlatformDesk } from './desk.ts';
import { endPause, startPause } from './pause.ts';
import { getPlatformTeam, type PlatformTeam } from './settings.ts';

/**
 * Bug intake of the platform team (Lean Team v3, design 8.2). Every detector (runner errors, server 5xx, loops,
 * rejection storms, role smoke tests, agents and people) reports through `reportBug`: one row per signature with an
 * occurrence counter, one bug card per signature in the platform project (routed to the platform architect), no
 * duplicate cards. Without a designated platform team the bug is only recorded.
 */

export interface BugReport {
  source: BugSource;
  /** The dedupe key: the same signature is the same bug. Include the source (`loop:code:build:worktree_failed`). */
  signature: string;
  title: string;
  /** Sanitised text for the card. Never raw client data. */
  description: string;
  /** Sanitised diagnostics (signature, top frames, counts, versions). */
  diagnostics?: Record<string, unknown>;
  /** More detail, visible only through an active grant of the client organisation. */
  extended?: Record<string, unknown>;
  /** What a pause for this bug would cover; empty: the bug is not scoped (no automatic pause). */
  scope?: Partial<PauseScope>;
  clientOrgId?: string | null;
  /** The piece of evidence (a card and its episode, a shift): it counts once however often a detector sees it. */
  evidenceKey?: string;
  /** The detector keeps its own counter (runner_errors): the bug's count follows it. */
  absoluteCount?: number;
  /** Occurrences this report stands for (an aggregated burst); default 1. */
  increment?: number;
  severityHint?: Exclude<BugSeverity, 'unrated'>;
}

export interface BugOutcome {
  signature: string;
  occurrences: number;
  /** The report was a new occurrence (not already counted). */
  counted: boolean;
  isNew: boolean;
  /** A bug card exists for this signature (filed now or before). */
  cardId: string | null;
  severity: BugSeverity;
  paused: boolean;
}

const SOURCE_LABEL: Record<BugSource, string> = {
  runner_error: 'Runner error',
  server_5xx: 'Server error',
  loop: 'Loop',
  rejection_storm: 'Rejection storm',
  role_smoke: 'Role smoke test',
  agent: 'Agent report',
  manual: 'Report',
};

const hasScope = (s: Record<string, unknown> | null | undefined): boolean =>
  !!s && (!!s.projectId || !!s.workflowKey || !!s.stageId || !!s.workstationId);

/** Severity by rules (the architect's judgement overrides it later): a repeated, scoped failure is critical. */
export function autoSeverity(
  bug: { severity: BugSeverity; severityBy: string; occurrences: number; scope: Record<string, unknown> },
  hint?: BugSeverity,
): BugSeverity {
  if (bug.severityBy !== 'rules') return bug.severity;
  if (hint === 'critical' || bug.severity === 'critical') return 'critical';
  if (bug.occurrences >= CRITICAL_REPEATS && hasScope(bug.scope)) return 'critical';
  if (bug.severity !== 'unrated') return bug.severity;
  return hint ?? 'unrated';
}

export async function platformOwner(db: Tx | Ctx['pool'], team: PlatformTeam): Promise<string | null> {
  const p = await one(
    db,
    `SELECT user_id FROM project_members WHERE project_id=$1 AND status='active' AND role='owner'
      ORDER BY joined_at NULLS LAST LIMIT 1`,
    [team.projectId],
  );
  if (p?.user_id) return p.user_id as string;
  const o = await one(
    db,
    `SELECT user_id FROM org_members WHERE org_id=$1 AND status='active' AND role='owner' LIMIT 1`,
    [team.orgId],
  );
  return (o?.user_id as string | undefined) ?? null;
}

const triageHelp = (ref: string) =>
  `\n\n---\nTriage (platform architect): decide first whether this is a real Guildwise bug.\n` +
  `- Not a bug (a project problem, user error, known and accepted limitation): \`aom bug triage --invalid --reason "<why>"\` closes the card.\n` +
  `- A real bug: \`aom bug triage --severity critical|degraded|minor --size small|medium|large --reason "<one line>"\`, then design the fix as usual. ` +
  `Critical means a stage cannot complete or the same failure repeats 3+ times: the affected scope is paused until ${ref} is fixed. ` +
  `The fix needs a regression test that reproduces the bug; review refuses a fix without one.`;

async function recordBug(
  ctx: Ctx,
  tx: Tx,
  r: BugReport,
): Promise<{ bug: Row; counted: boolean; isNew: boolean; reopened: boolean }> {
  const now = ctx.clock.now();
  const sig = r.signature.slice(0, 200);
  let bug = await one(tx, 'SELECT * FROM platform_bugs WHERE signature=$1 FOR UPDATE', [sig]);
  const diagnostics = JSON.stringify(r.diagnostics ?? {});
  if (!bug) {
    const occ = Math.max(1, r.absoluteCount ?? r.increment ?? 1);
    bug = (await one(
      tx,
      `INSERT INTO platform_bugs (signature, source, title, severity, occurrences, client_org_id, scope, diagnostics,
                                 extended, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$10) RETURNING *`,
      [
        sig,
        r.source,
        r.title.slice(0, 300),
        'unrated',
        occ,
        r.clientOrgId ?? null,
        JSON.stringify(r.scope ?? {}),
        diagnostics,
        JSON.stringify(r.extended ?? {}),
        now,
      ],
    )) as Row;
    if (r.evidenceKey)
      await exec(
        tx,
        'INSERT INTO platform_bug_hits (signature, evidence_key, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [sig, r.evidenceKey, now],
      );
    return { bug, counted: true, isNew: true, reopened: false };
  }
  let counted: boolean;
  if (r.evidenceKey)
    counted =
      (await exec(
        tx,
        'INSERT INTO platform_bug_hits (signature, evidence_key, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [sig, r.evidenceKey, now],
      )) > 0;
  else if (r.absoluteCount !== undefined) counted = r.absoluteCount > Number(bug.occurrences);
  else counted = true;
  if (!counted) return { bug, counted: false, isNew: false, reopened: false };
  const reopened = bug.status === 'fixed';
  const next = (await one(
    tx,
    `UPDATE platform_bugs SET
        occurrences = CASE WHEN $2::int IS NULL THEN occurrences + $7::int ELSE GREATEST(occurrences, $2::int) END,
        last_seen_at = $3,
        diagnostics = diagnostics || $4::jsonb,
        scope = CASE WHEN $5::jsonb = '{}'::jsonb THEN scope ELSE $5::jsonb END,
        extended = extended || $6::jsonb,
        status = CASE WHEN status = 'fixed' THEN 'open' ELSE status END,
        card_id = CASE WHEN status = 'fixed' THEN NULL ELSE card_id END,
        fixed_cards = CASE WHEN status = 'fixed' THEN array_append(fixed_cards, COALESCE((SELECT ref FROM cards WHERE id = card_id), '?')) ELSE fixed_cards END,
        severity = CASE WHEN status = 'fixed' THEN 'unrated' ELSE severity END,
        severity_by = CASE WHEN status = 'fixed' THEN 'rules' ELSE severity_by END,
        notified_count = CASE WHEN status = 'fixed' THEN 0 ELSE notified_count END
      WHERE signature=$1 RETURNING *`,
    [
      sig,
      r.absoluteCount ?? null,
      now,
      diagnostics,
      JSON.stringify(r.scope ?? {}),
      JSON.stringify(r.extended ?? {}),
      Math.max(1, r.increment ?? 1),
    ],
  )) as Row;
  return { bug: next, counted: true, isNew: false, reopened };
}

async function fileBugCard(ctx: Ctx, tx: Tx, bug: Row, team: PlatformTeam): Promise<Row | null> {
  const ownerId = await platformOwner(tx, team);
  if (!ownerId) return null;
  const user = { id: ownerId } as AuthSession['user'];
  const prior = (bug.fixed_cards as string[]).filter((x) => x !== '?');
  const diag = bug.diagnostics as Record<string, unknown>;
  const detail = [
    `Reported automatically (${SOURCE_LABEL[bug.source as BugSource] ?? bug.source}). Signature: ${bug.signature}`,
    '',
    String(diag.summary ?? bug.title),
    '',
    'Sanitised diagnostics:',
    JSON.stringify(Object.fromEntries(Object.entries(diag).filter(([k]) => k !== 'summary')), null, 2).slice(
      0,
      4000,
    ),
    ...(prior.length > 0
      ? [
          '',
          `Regression: an earlier card for this signature (${prior.join(', ')}) was fixed and the bug came back.`,
        ]
      : []),
    bug.client_org_id
      ? '\nThis bug hit a client organization: only the sanitised diagnostics above are shown. Ask for more with a grant (the client organization approves on its desk); never copy client data into this card.'
      : '',
  ].join('\n');
  const req = {
    projectId: team.projectId,
    title: `[${SOURCE_LABEL[bug.source as BugSource] ?? 'Bug'}] ${bug.title}`.slice(0, 300),
    cardType: 'bug' as const,
    fields: {
      context: `${detail}${triageHelp('this card')}`,
      requirements: 'Find the cause of the bug and fix it. Add a regression test that reproduces it first.',
      acceptanceCriteria: [
        'The failure no longer happens',
        'A regression test reproduces the bug without the fix and passes with it',
      ],
      testPlan: 'Run the regression test and the tests of the area; no new failures.',
      affectedAreas: 'Guildwise server or runner (the architect finds the exact place).',
      constraints: 'Keep the change minimal; no unrelated clean-up.',
    },
    priority: 2,
    designNeeded: true,
    specify: true,
  };
  let created: { cardId: string; ref: string; missing?: string[] | undefined };
  try {
    created = await createCardIn(ctx, tx, user, req, { origin: 'trigger' });
  } catch (err) {
    // A platform project whose workflow has no design stage: the bug goes to build directly.
    if ((err as { code?: string }).code !== 'design_not_supported') throw err;
    const { designNeeded: _d, ...rest } = req;
    created = await createCardIn(ctx, tx, user, rest, { origin: 'trigger' });
  }
  if (created.missing?.length)
    ctx.log.warn(
      { ref: created.ref, missing: created.missing },
      'platform bug card stays in draft: the platform project cannot specify it (check its repository and workflow)',
    );
  const updated = (await one(
    tx,
    'UPDATE platform_bugs SET card_id=$2, project_id=$3, filed_at=$4 WHERE signature=$1 RETURNING *',
    [bug.signature, created.cardId, team.projectId, ctx.clock.now()],
  )) as Row;
  if (bug.source === 'runner_error' && String(bug.signature).startsWith('runner:'))
    await exec(tx, 'UPDATE runner_errors SET bug_card_id=$2 WHERE signature=$1', [
      String(bug.signature).slice('runner:'.length),
      created.cardId,
    ]);
  return { ...updated, ref: created.ref };
}

const newCardsLastHour = async (ctx: Ctx, tx: Tx): Promise<number> =>
  Number(
    (
      await one(tx, `SELECT count(*)::int AS n FROM platform_bugs WHERE filed_at > $1`, [
        new Date(ctx.clock.now().getTime() - 3_600_000),
      ])
    )?.n ?? 0,
  );

/** Notes, severity and pause for a bug whose card exists. */
async function settleBug(
  ctx: Ctx,
  tx: Tx,
  bugIn: Row,
  team: PlatformTeam,
  o: { hint?: BugSeverity | undefined; counted: boolean; fresh: boolean },
): Promise<{ bug: Row; paused: boolean }> {
  let bug = bugIn;
  const card = bug.card_id ? await one(tx, 'SELECT * FROM cards WHERE id=$1', [bug.card_id]) : undefined;
  if (!card) return { bug, paused: false };
  const messages = [];
  // counter milestones on the card (one note per milestone, not per occurrence)
  const milestone = [...BUG_COUNTER_MILESTONES].reverse().find((m) => bug.occurrences >= m);
  if (milestone && milestone > Number(bug.notified_count) && !o.fresh) {
    messages.push(
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `Seen ${bug.occurrences} times now (first ${new Date(bug.first_seen_at).toISOString()}, last ${new Date(bug.last_seen_at).toISOString()}).`,
      ),
    );
    await exec(tx, 'UPDATE platform_bugs SET notified_count=$2 WHERE signature=$1', [
      bug.signature,
      milestone,
    ]);
    await notifyPlatformDesk(
      ctx,
      {
        subjectKey: `platform_bug:${bug.signature}`,
        subkind: 'platform_bug',
        title: `${card.ref}: ${bug.title}`,
        body: `Seen ${bug.occurrences} times.`,
        cardId: card.id,
        projectId: team.projectId,
      },
      { tx },
    );
  }
  const severity = autoSeverity(
    {
      severity: bug.severity,
      severityBy: bug.severity_by,
      occurrences: Number(bug.occurrences),
      scope: bug.scope,
    },
    o.hint,
  );
  if (severity !== bug.severity) {
    bug = (await one(tx, 'UPDATE platform_bugs SET severity=$2 WHERE signature=$1 RETURNING *', [
      bug.signature,
      severity,
    ])) as Row;
    messages.push(
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `Severity set to ${severity} by rule (${bug.occurrences} occurrence${bug.occurrences === 1 ? '' : 's'}${hasScope(bug.scope) ? ', the affected scope can be paused' : ''}).`,
      ),
    );
  }
  let paused = false;
  if (bug.severity === 'critical' && hasScope(bug.scope) && bug.status === 'open') {
    const p = await startPause(
      ctx,
      {
        scope: bug.scope,
        reason: `Critical bug ${card.ref}: ${bug.title}`,
        source: 'auto',
        severity: 'critical',
        bugSignature: bug.signature,
        bugCardId: card.id,
      },
      { tx },
    );
    paused = !!p;
  }
  if (messages.length > 0) await ctx.store.append(messages, { tx });
  return { bug, paused };
}

/**
 * Records one occurrence of a bug and, with a designated platform team, files its card (once) and applies the rules:
 * counter notes, severity, automatic pause of a critical bug's scope. Safe to call as often as a detector likes.
 */
export async function reportBug(ctx: Ctx, r: BugReport): Promise<BugOutcome> {
  return withAppendTx(ctx.pool, async (tx) => {
    const rec = await recordBug(ctx, tx, r);
    let bug = rec.bug;
    const team = await getPlatformTeam(tx);
    const base = {
      signature: bug.signature as string,
      occurrences: Number(bug.occurrences),
      counted: rec.counted,
      isNew: rec.isNew,
    };
    if (!team || bug.status !== 'open')
      return {
        ...base,
        cardId: (bug.card_id as string | null) ?? null,
        severity: bug.severity,
        paused: false,
      };
    let fresh = false;
    if (!bug.card_id && (await newCardsLastHour(ctx, tx)) < INTAKE_NEW_CARDS_PER_HOUR) {
      const filed = await fileBugCard(ctx, tx, bug, team);
      if (filed) {
        bug = filed;
        fresh = true;
        await notifyPlatformDesk(
          ctx,
          {
            subjectKey: `platform_bug:${bug.signature}`,
            subkind: 'platform_bug',
            title: `New bug ${filed.ref}: ${bug.title}`,
            body: `${SOURCE_LABEL[bug.source as BugSource] ?? 'Report'}: ${bug.title}\n\nThe platform architect triages it: closes it as invalid, or sets a severity and designs the fix.`,
            cardId: bug.card_id,
            projectId: team.projectId,
            data: { signature: bug.signature },
          },
          { tx },
        );
      }
    }
    const settled = await settleBug(ctx, tx, bug, team, {
      hint: r.severityHint,
      counted: rec.counted,
      fresh,
    });
    if (fresh) ctx.services.dispatcher.trigger();
    return {
      ...base,
      cardId: (settled.bug.card_id as string | null) ?? null,
      severity: settled.bug.severity,
      paused: settled.paused,
    };
  });
}

/** Files the cards of bugs recorded while there was no team or the hourly cap was reached. */
export async function drainBugs(ctx: Ctx): Promise<number> {
  const team = await getPlatformTeam(ctx.pool);
  if (!team) return 0;
  const open = await rows(
    ctx.pool,
    `SELECT signature FROM platform_bugs WHERE status='open' AND card_id IS NULL ORDER BY created_at LIMIT 20`,
  );
  let n = 0;
  for (const o of open) {
    const done = await withAppendTx(ctx.pool, async (tx) => {
      if ((await newCardsLastHour(ctx, tx)) >= INTAKE_NEW_CARDS_PER_HOUR) return false;
      const bug = await one(
        tx,
        `SELECT * FROM platform_bugs WHERE signature=$1 AND card_id IS NULL AND status='open' FOR UPDATE`,
        [o.signature],
      );
      if (!bug) return false;
      const filed = await fileBugCard(ctx, tx, bug, team);
      if (!filed) return false;
      await notifyPlatformDesk(
        ctx,
        {
          subjectKey: `platform_bug:${bug.signature}`,
          subkind: 'platform_bug',
          title: `New bug ${filed.ref}: ${bug.title}`,
          body: `${SOURCE_LABEL[bug.source as BugSource] ?? 'Report'}: ${bug.title}\n\nThe platform architect triages it.`,
          cardId: filed.card_id,
          projectId: team.projectId,
          data: { signature: bug.signature },
        },
        { tx },
      );
      await settleBug(ctx, tx, filed, team, { counted: false, fresh: true });
      return true;
    });
    if (done) n++;
    else break;
  }
  if (n > 0) ctx.services.dispatcher.trigger();
  return n;
}

/**
 * The architect's (or a platform manager's) triage of a bug card: invalid closes it with the reason; valid sets the
 * severity and the fix size. A critical severity pauses the bug's scope at once (when it has one); a lower severity ends
 * an automatic pause that rules had started.
 */
export async function triageBug(
  ctx: Ctx,
  who: { userId: string; label: string; asAgentId?: string },
  cardId: string,
  req: TriageBugRequest,
): Promise<{ signature: string; severity: BugSeverity; status: string }> {
  return withAppendTx(ctx.pool, async (tx) => {
    const bug = await one(tx, 'SELECT * FROM platform_bugs WHERE card_id=$1 FOR UPDATE', [cardId]);
    if (!bug) throw notFound('this card is not a platform bug card');
    const team = await getPlatformTeam(tx);
    if (!team) throw conflict('no_platform_team', 'no platform team is designated');
    const card = (await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [cardId])) as Row;
    if (['done', 'cancelled'].includes(card.status)) throw conflict('card_closed', `card is ${card.status}`);
    if (req.verdict === 'invalid') {
      await exec(
        tx,
        `UPDATE platform_bugs SET status='invalid', severity_by='architect' WHERE signature=$1`,
        [bug.signature],
      );
      const ws = await cancelCardIn(
        ctx,
        tx,
        { id: who.userId, displayName: who.label },
        card,
        `Closed as invalid: ${req.reason}`,
      );
      for (const p of await rows(
        tx,
        'SELECT id FROM platform_pauses WHERE resumed_at IS NULL AND bug_card_id=$1',
        [cardId],
      ))
        await endPause(ctx, p.id, { by: 'invalid', reason: `${card.ref} was closed as invalid` }, { tx });
      if (ws) ctx.services.gateway.deliverPending(ws).catch(() => {});
      return { signature: bug.signature, severity: bug.severity, status: 'invalid' };
    }
    const severity = req.severity as Exclude<BugSeverity, 'unrated'>;
    const size: FixSize = req.size ?? bug.fix_size;
    const next = (await one(
      tx,
      `UPDATE platform_bugs SET severity=$2, severity_by='architect', fix_size=$3 WHERE signature=$1 RETURNING *`,
      [bug.signature, severity, size],
    )) as Row;
    await ctx.store.append(
      [
        cardMessage(
          card,
          { kind: 'system' },
          'system',
          `Triaged by ${who.label}: valid bug, severity ${severity}, ${size} fix.${req.reason ? ` ${req.reason}` : ''}`,
        ),
      ],
      { tx },
    );
    if (severity === 'critical') {
      if (hasScope(next.scope))
        await startPause(
          ctx,
          {
            scope: next.scope,
            reason: `Critical bug ${card.ref}: ${next.title}`,
            source: 'auto',
            severity: 'critical',
            bugSignature: next.signature,
            bugCardId: cardId,
          },
          { tx },
        );
    } else {
      for (const p of await rows(
        tx,
        `SELECT id FROM platform_pauses WHERE resumed_at IS NULL AND bug_card_id=$1 AND source='auto'`,
        [cardId],
      ))
        await endPause(
          ctx,
          p.id,
          { by: 'manual', reason: `Triage rated ${card.ref} ${severity}: work keeps running` },
          { tx },
        );
    }
    return { signature: next.signature, severity, status: 'open' };
  });
}

/**
 * Marks a bug fixed when its card is done and invalid when the card was cancelled (the pass calls this). A later
 * occurrence of a fixed bug reopens it with a new card; an invalid one stays closed (accepted).
 */
export async function markFixedBugs(ctx: Ctx): Promise<number> {
  return exec(
    ctx.pool,
    `UPDATE platform_bugs b SET status = CASE c.status WHEN 'done' THEN 'fixed' ELSE 'invalid' END
       FROM cards c WHERE c.id = b.card_id AND c.status IN ('done','cancelled') AND b.status = 'open'`,
  );
}
