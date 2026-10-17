import { createHash } from 'node:crypto';
import { maskText, REJECTION_STORM, topFrames } from '@aom/shared';
import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { detectLoops } from '../reporter/detectors.ts';
import { expireGrants } from './grants.ts';
import { drainBugs, markFixedBugs, reportBug } from './intake.ts';
import { resumeFixedPauses } from './pause.ts';
import { getPlatformTeam } from './settings.ts';

/**
 * The detectors of platform bug intake (Lean Team v3, design 8.2). Each turns something the system already measures
 * into a `reportBug` call with a stable signature, so one bug is one card with a counter:
 *  - runner errors (`runner_errors`: a new signature, or its counter growing),
 *  - loops (the loop breaker's back-off episode: 3+ failed shifts or rejections of one card),
 *  - rejection storms (many worktree rejections on one workstation),
 *  - role smoke-test failures (`workstation_role_blocks`),
 *  - server 5xx (a Fastify error hook, `reportServerError`).
 * `platformScan` is idempotent: every piece of evidence counts once.
 */

const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 10);

/** The message with quoted values, numbers and ids removed, so two occurrences of one fault group together. */
const groupingText = (m: string): string =>
  m
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '"…"')
    .replace(/\b0x[0-9a-f]+\b/gi, '#')
    .replace(/\d+/g, '#')
    .slice(0, 200);

async function platformOrg(ctx: Ctx): Promise<string | null> {
  return (await getPlatformTeam(ctx.pool))?.orgId ?? null;
}

const clientOf = (orgId: string | null | undefined, platform: string | null): string | null =>
  orgId && orgId !== platform ? orgId : null;

// ---------------------------------------------------------------------------------------------- runner errors

async function scanRunnerErrors(ctx: Ctx): Promise<number> {
  const list = await rows(
    ctx.pool,
    `SELECT re.* FROM runner_errors re LEFT JOIN platform_bugs b ON b.signature = 'runner:' || re.signature
      WHERE b.signature IS NULL OR re.occurrences > b.occurrences ORDER BY re.last_seen_at LIMIT 50`,
  );
  for (const e of list) {
    const crash = e.context === 'uncaughtException';
    await reportBug(ctx, {
      source: 'runner_error',
      signature: `runner:${e.signature}`,
      title: String(e.message).slice(0, 200) || e.signature,
      description: String(e.message),
      absoluteCount: Number(e.occurrences),
      diagnostics: {
        kind: 'runner_error',
        summary: `The runner reported "${String(e.message).slice(0, 300)}" (${e.context ?? 'no context'}).`,
        runnerSignature: e.signature,
        context: e.context,
        topFrames: topFrames(e.stack ?? undefined),
        occurrences: Number(e.occurrences),
        workstations: Number(e.workstation_count),
        versions: { first: e.first_version, last: e.last_version },
      },
      // A crash loop on one workstation is what makes the workstation worth pausing; a handled error is not.
      ...(crash && Number(e.workstation_count) === 1 && e.last_workstation_id
        ? { scope: { workstationId: e.last_workstation_id } }
        : {}),
    });
  }
  return list.length;
}

// ---------------------------------------------------------------------------------------------- loops

async function scanLoops(ctx: Ctx): Promise<number> {
  const platform = await platformOrg(ctx);
  // The existing detector (reporter/detectors.ts): the loop breaker's open back-off episodes (3+ failed shifts or
  // rejections of one card) and cards that cause 5+ question shifts in 2 hours (`loop:questions:<card>`).
  const found = await detectLoops(ctx.pool);
  for (const d of found) {
    const cardId = d.subject.cardId;
    if (!cardId) continue;
    const c = await one(
      ctx.pool,
      `SELECT c.id, c.ref, c.org_id, c.project_id, c.stage, wv.key AS workflow_key FROM cards c
         JOIN workflow_versions wv ON wv.id = c.workflow_version_id WHERE c.id=$1`,
      [cardId],
    );
    if (!c) continue;
    const questions = d.fingerprint.startsWith('loop:questions:');
    const episode = questions
      ? `q:${Math.floor(ctx.clock.now().getTime() / (2 * 3_600_000))}`
      : String(d.evidence.episodeId ?? '');
    await reportBug(ctx, {
      source: 'loop',
      signature: `loop:${c.project_id}:${c.workflow_key}:${c.stage}${questions ? ':questions' : ''}`,
      title: questions
        ? `Cards loop in stage ${c.stage} (${c.workflow_key}): question after question`
        : `Cards loop in stage ${c.stage} (${c.workflow_key}): shifts keep ending without a result`,
      description: `A card went round in stage ${c.stage} (${d.count}).`,
      evidenceKey: `${c.id}:${episode}`,
      severityHint: 'critical',
      scope: { projectId: c.project_id, workflowKey: c.workflow_key, stageId: c.stage },
      clientOrgId: clientOf(c.org_id, platform),
      diagnostics: {
        kind: questions ? 'loop_questions' : 'loop',
        summary: questions
          ? `A card keeps asking questions in stage ${c.stage} of workflow ${c.workflow_key} (${d.count} question shifts).`
          : `A card keeps failing in stage ${c.stage} of workflow ${c.workflow_key}: ${d.count} failures in one episode.`,
        workflow: c.workflow_key,
        stage: c.stage,
        count: d.count,
      },
      extended: { cardRef: c.ref },
    });
  }
  return found.length;
}

// ---------------------------------------------------------------------------------------------- rejection storms

async function scanRejectionStorms(ctx: Ctx): Promise<number> {
  const platform = await platformOrg(ctx);
  const since = new Date(ctx.clock.now().getTime() - REJECTION_STORM.windowMinutes * 60_000);
  const list = await rows(
    ctx.pool,
    `SELECT s.workstation_id, s.rejection_reason AS reason, count(*)::int AS n,
            count(DISTINCT s.card_id)::int AS cards,
            (array_agg(DISTINCT c.project_id))[1] AS project_id, count(DISTINCT c.project_id)::int AS projects,
            (array_agg(DISTINCT c.org_id))[1] AS org_id
       FROM shifts s LEFT JOIN cards c ON c.id = s.card_id
      WHERE s.outcome = 'rejected' AND s.ended_at > $1 AND s.rejection_reason IS NOT NULL
        AND s.rejection_reason NOT IN ('busy', 'auth_expired', 'runtime_unavailable')
      GROUP BY s.workstation_id, s.rejection_reason HAVING count(*) >= $2`,
    [since, REJECTION_STORM.count],
  );
  const bucket = Math.floor(ctx.clock.now().getTime() / 3_600_000);
  for (const s of list) {
    await reportBug(ctx, {
      source: 'rejection_storm',
      signature: `storm:${s.workstation_id}:${s.reason}`,
      title: `Rejection storm: ${s.n} shifts refused with ${s.reason} in ${REJECTION_STORM.windowMinutes} minutes`,
      description: `A workstation refused ${s.n} shifts (${s.reason}).`,
      evidenceKey: `hour:${bucket}`,
      severityHint: 'critical',
      scope: { workstationId: s.workstation_id, ...(s.projects === 1 ? { projectId: s.project_id } : {}) },
      clientOrgId: s.projects === 1 ? clientOf(s.org_id, platform) : null,
      diagnostics: {
        kind: 'rejection_storm',
        summary: `A runner refused ${s.n} shifts with "${s.reason}" within ${REJECTION_STORM.windowMinutes} minutes.`,
        reason: s.reason,
        rejections: Number(s.n),
        cards: Number(s.cards),
        windowMinutes: REJECTION_STORM.windowMinutes,
      },
    });
  }
  return list.length;
}

// ---------------------------------------------------------------------------------------------- role smoke tests

async function scanRoleSmoke(ctx: Ctx): Promise<number> {
  const list = await rows(
    ctx.pool,
    `SELECT b.workstation_id, b.role_key, b.detail, b.runner_version, b.checked_at
       FROM workstation_role_blocks b
      WHERE NOT EXISTS (SELECT 1 FROM platform_bug_hits h
                         WHERE h.signature = 'smoke:' || b.role_key || ':' || COALESCE(b.runner_version, 'unknown')
                           AND h.evidence_key = b.workstation_id || ':' || floor(extract(epoch FROM b.checked_at))::bigint)
      LIMIT 50`,
  );
  for (const b of list) {
    const version = b.runner_version ?? 'unknown';
    await reportBug(ctx, {
      source: 'role_smoke',
      signature: `smoke:${b.role_key}:${version}`,
      title: `Role ${b.role_key} fails its smoke test on runner ${version}`,
      description: `The ${b.role_key} role cannot run its handoff command in its sandbox.`,
      evidenceKey: `${b.workstation_id}:${Math.floor(new Date(b.checked_at).getTime() / 1000)}`,
      // The role is already blocked on that workstation by the smoke test itself; no scope, so no extra pause.
      severityHint: 'degraded',
      diagnostics: {
        kind: 'role_smoke',
        summary: `Role ${b.role_key} failed the runner's self-test on version ${version}: ${maskText(String(b.detail ?? 'failed')).slice(0, 300)}`,
        role: b.role_key,
        runnerVersion: version,
      },
    });
  }
  return list.length;
}

// ---------------------------------------------------------------------------------------------- server errors

interface Pending {
  hits: number;
  report: Parameters<typeof reportBug>[1];
}
const pending = new WeakMap<Ctx, Map<string, Pending>>();
const flushTimers = new WeakMap<Ctx, NodeJS.Timeout>();

/** Flushes the 5xx hits collected so far (one report per signature, counted `hits` times). */
export async function flushServerErrors(ctx: Ctx): Promise<void> {
  const map = pending.get(ctx);
  if (!map || map.size === 0) return;
  const batch = [...map.values()];
  map.clear();
  for (const p of batch)
    await reportBug(ctx, { ...p.report, increment: p.hits }).catch((err) =>
      ctx.log.error({ err }, 'bug intake failed'),
    );
}

/**
 * Fastify error hook: a 5xx is a bug report. Sanitised (route pattern, not the URL; masked first line of the message;
 * top frames as function plus file name), deduped by route plus error signature, and aggregated for 2 seconds so an error
 * storm is one report with a count, not a database write per request. Never throws.
 */
export function reportServerError(
  ctx: Ctx,
  req: Pick<FastifyRequest, 'method' | 'routeOptions'>,
  err: unknown,
): void {
  try {
    const e = err instanceof Error ? err : new Error(String(err));
    const route = String(req.routeOptions?.url ?? 'unmatched').slice(0, 120);
    const name = (e.name || 'Error').slice(0, 60);
    const message = maskText(String(e.message).split('\n')[0] ?? '').slice(0, 300);
    const frames = topFrames(e.stack);
    const signature = `5xx:${req.method} ${route}:${name}:${hash(groupingText(message))}`;
    const map = pending.get(ctx) ?? new Map<string, Pending>();
    pending.set(ctx, map);
    const have = map.get(signature);
    if (have) have.hits++;
    else
      map.set(signature, {
        hits: 1,
        report: {
          source: 'server_5xx',
          signature,
          title: `${req.method} ${route} fails with ${name}`.slice(0, 200),
          description: message,
          diagnostics: {
            kind: 'server_5xx',
            summary: `${req.method} ${route} answered 500: ${name}: ${message}`,
            method: req.method,
            route,
            errorName: name,
            message,
            topFrames: frames,
          },
        },
      });
    if (!flushTimers.has(ctx)) {
      const t = setTimeout(() => {
        flushTimers.delete(ctx);
        void flushServerErrors(ctx);
      }, 2000);
      t.unref?.();
      flushTimers.set(ctx, t);
    }
  } catch {
    // reporting must never break a request
  }
}

// ---------------------------------------------------------------------------------------------- the pass

/** Runs every detector once (tests call this directly). */
export async function platformScan(ctx: Ctx): Promise<void> {
  await flushServerErrors(ctx);
  await scanRunnerErrors(ctx);
  await scanLoops(ctx);
  await scanRejectionStorms(ctx);
  await scanRoleSmoke(ctx);
}

/** The housekeeping side: file what waited, end pauses of fixed bugs, expire grants, stop-loss of fixes. */
export async function platformHousekeeping(ctx: Ctx): Promise<void> {
  await resumeFixedPauses(ctx);
  await markFixedBugs(ctx);
  await drainBugs(ctx);
  await expireGrants(ctx);
}

const lastRun = new WeakMap<Ctx, number>();
const PASS_EVERY_MS = 15_000;

/**
 * Called by the dispatcher on every pass; does its work at most every 15 seconds and never throws. A pass without a
 * designated platform team still records (the scan only writes rows) but raises nothing.
 */
export async function platformPass(ctx: Ctx, opts: { force?: boolean } = {}): Promise<void> {
  const now = ctx.clock.now().getTime();
  if (!opts.force && now - (lastRun.get(ctx) ?? 0) < PASS_EVERY_MS) return;
  lastRun.set(ctx, now);
  try {
    // Cheap guard: no pause, no open bug and no error row means nothing to do.
    const busy = await one(
      ctx.pool,
      `SELECT (SELECT count(*) FROM platform_pauses WHERE resumed_at IS NULL)
            + (SELECT count(*) FROM platform_bugs WHERE status='open')
            + (SELECT count(*) FROM runner_errors)
            + (SELECT count(*) FROM workstation_role_blocks)
            + (SELECT count(*) FROM cards WHERE retry_failures >= 3 AND retry_episode_id IS NOT NULL)
            + (SELECT count(*) FROM shifts WHERE outcome='rejected' AND ended_at > now() - interval '1 hour')
            + (SELECT count(*) FROM platform_diag_grants WHERE status='approved') AS n`,
    );
    if (Number(busy?.n ?? 0) === 0 && !(await hasPendingServerErrors(ctx))) return;
    await platformScan(ctx);
    await platformHousekeeping(ctx);
  } catch (err) {
    ctx.log.error({ err }, 'platform pass failed');
  }
}

async function hasPendingServerErrors(ctx: Ctx): Promise<boolean> {
  return (pending.get(ctx)?.size ?? 0) > 0;
}
