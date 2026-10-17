import { randomUUID } from 'node:crypto';
import { type PauseScope, type PlatformPauseDto, streamId } from '@aom/shared';
import { projectScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { conflict } from '../errors.ts';
import { notifyPlatformDesk } from './desk.ts';
import { getPlatformTeam, type PlatformTeam } from './settings.ts';

/**
 * Pause scoped to what a bug hits (Lean Team v3, design 8.3): project, workflow, stage and/or workstation. A card is
 * paused when an open pause matches every field it names. The platform project's own cards are never paused (the fix
 * flow must keep running), whatever the scope says. Used by the candidate query of the dispatcher.
 */
export function platformPausedSql(card: string, workstationId: string): string {
  return `(EXISTS (SELECT 1 FROM platform_pauses pp
            WHERE pp.resumed_at IS NULL
              AND (pp.project_id IS NULL OR pp.project_id = ${card}.project_id)
              AND (pp.workflow_key IS NULL OR pp.workflow_key =
                     (SELECT wv.key FROM workflow_versions wv WHERE wv.id = ${card}.workflow_version_id))
              AND (pp.stage_id IS NULL OR pp.stage_id = ${card}.stage)
              AND (pp.workstation_id IS NULL OR pp.workstation_id = ${workstationId}))
          AND NOT EXISTS (SELECT 1 FROM platform_settings ps
                           WHERE ps.key = 'platform.team' AND ps.value->>'projectId' = ${card}.project_id::text))`;
}

const norm = (s: Partial<PauseScope>): PauseScope => ({
  projectId: s.projectId ?? null,
  workflowKey: s.workflowKey ?? null,
  stageId: s.stageId ?? null,
  workstationId: s.workstationId ?? null,
});

export const scopeKey = (s: PauseScope): string =>
  [s.projectId, s.workflowKey, s.stageId, s.workstationId].map((x) => x ?? '*').join('/');

async function describeScope(ctx: Ctx, s: PauseScope): Promise<string> {
  const parts: string[] = [];
  if (s.projectId) {
    const p = await one(ctx.pool, 'SELECT key FROM projects WHERE id=$1', [s.projectId]);
    parts.push(`project ${p?.key ?? s.projectId}`);
  }
  if (s.workflowKey) parts.push(`workflow ${s.workflowKey}`);
  if (s.stageId) parts.push(`stage ${s.stageId}`);
  if (s.workstationId) {
    const w = await one(ctx.pool, 'SELECT name FROM workstations WHERE id=$1', [s.workstationId]);
    parts.push(`workstation ${w?.name ?? s.workstationId}`);
  }
  return parts.join(', ');
}

/** The pause event's scope: the project's own audience (its members see the banner), else the platform organisation. */
function eventScope(s: PauseScope, orgOfProject: string | null, team: PlatformTeam | null) {
  if (s.projectId && orgOfProject) return projectScope(orgOfProject, s.projectId);
  return {
    orgId: team?.orgId ?? null,
    projectId: null,
    audience: team ? ('org' as const) : ('admin' as const),
  };
}

export interface StartPause {
  scope: Partial<PauseScope>;
  reason: string;
  source: 'auto' | 'manual';
  severity?: 'unrated' | 'critical' | 'degraded' | 'minor';
  bugSignature?: string | undefined;
  bugCardId?: string | undefined;
  byUserId?: string | undefined;
}

/**
 * Starts a pause (events + a coalesced note on the platform desk). The same scope and bug while a pause is open returns
 * that pause. A pause of the platform project itself is refused: automatic ones return null, manual ones raise 409.
 */
export async function startPause(
  ctx: Ctx,
  input: StartPause,
  opts: { tx?: Tx } = {},
): Promise<{ pauseId: string; created: boolean } | null> {
  const db = opts.tx ?? ctx.pool;
  const scope = norm(input.scope);
  const team = await getPlatformTeam(db);
  if (scope.projectId && team && scope.projectId === team.projectId) {
    if (input.source === 'manual')
      throw conflict('platform_project', "the platform project's own fix flow is never paused");
    return null;
  }
  const existing = await one(
    db,
    `SELECT id FROM platform_pauses WHERE resumed_at IS NULL
        AND project_id IS NOT DISTINCT FROM $1 AND workflow_key IS NOT DISTINCT FROM $2
        AND stage_id IS NOT DISTINCT FROM $3 AND workstation_id IS NOT DISTINCT FROM $4`,
    [scope.projectId, scope.workflowKey, scope.stageId, scope.workstationId],
  );
  if (existing) return { pauseId: existing.id, created: false };
  const orgOfProject = scope.projectId
    ? ((await one(db, 'SELECT org_id FROM projects WHERE id=$1', [scope.projectId]))?.org_id ?? null)
    : null;
  const pauseId = randomUUID();
  const append = { ...(opts.tx ? { tx: opts.tx } : {}) };
  await ctx.store.append(
    [
      {
        streamId: streamId.platformPause(pauseId),
        event: {
          type: 'PlatformPauseStarted',
          payload: {
            pauseId,
            scope,
            reason: input.reason.slice(0, 500),
            source: input.source,
            severity: input.severity ?? 'critical',
            ...(input.bugSignature ? { bugSignature: input.bugSignature } : {}),
            ...(input.bugCardId ? { bugCardId: input.bugCardId } : {}),
            ...(input.byUserId ? { by: input.byUserId } : {}),
          },
        },
        actor: input.byUserId ? userActor(input.byUserId) : SYSTEM_ACTOR,
        scope: eventScope(scope, orgOfProject, team),
      },
    ],
    append,
  );
  const where = await describeScope(ctx, scope);
  await notifyPlatformDesk(
    ctx,
    {
      subjectKey: `platform_pause:${scopeKey(scope)}`,
      subkind: 'platform_pause',
      title: `Paused ${where}`,
      body: `${input.source === 'auto' ? 'Automatic pause' : 'Manual pause'} of ${where}: ${input.reason}\n\nOnly cards inside this scope are held back; the platform project keeps working. It ends by itself when the linked bug card is fixed, or resume it by hand on the platform page.`,
      data: { pauseId, scope },
      ...(input.bugCardId ? { cardId: input.bugCardId } : {}),
      ...(team ? { projectId: team.projectId } : {}),
    },
    append,
  ).catch((err) => ctx.log.error({ err }, 'platform pause notice failed'));
  ctx.log.warn({ pauseId, scope, reason: input.reason }, 'platform pause started');
  return { pauseId, created: true };
}

/** Ends an open pause. Returns false when it was not open. */
export async function endPause(
  ctx: Ctx,
  pauseId: string,
  how: { by: 'fix' | 'manual' | 'invalid'; reason: string; byUserId?: string },
  opts: { tx?: Tx } = {},
): Promise<boolean> {
  const db = opts.tx ?? ctx.pool;
  const p = await one(db, 'SELECT * FROM platform_pauses WHERE id=$1 AND resumed_at IS NULL', [pauseId]);
  if (!p) return false;
  const scope = norm({
    projectId: p.project_id,
    workflowKey: p.workflow_key,
    stageId: p.stage_id,
    workstationId: p.workstation_id,
  });
  const team = await getPlatformTeam(db);
  const orgOfProject = scope.projectId
    ? ((await one(db, 'SELECT org_id FROM projects WHERE id=$1', [scope.projectId]))?.org_id ?? null)
    : null;
  const append = { ...(opts.tx ? { tx: opts.tx } : {}) };
  await ctx.store.append(
    [
      {
        streamId: streamId.platformPause(pauseId),
        event: {
          type: 'PlatformPauseEnded',
          payload: {
            pauseId,
            reason: how.reason.slice(0, 500),
            by: how.by,
            ...(how.byUserId ? { byUserId: how.byUserId } : {}),
          },
        },
        actor: how.byUserId ? userActor(how.byUserId) : SYSTEM_ACTOR,
        scope: eventScope(scope, orgOfProject, team),
      },
    ],
    append,
  );
  const where = await describeScope(ctx, scope);
  await notifyPlatformDesk(
    ctx,
    {
      subjectKey: `platform_resume:${scopeKey(scope)}`,
      subkind: 'platform_pause',
      title: `Resumed ${where}`,
      body: `Work in ${where} runs again (${how.by === 'fix' ? 'the bug was fixed' : how.by === 'invalid' ? 'the bug was closed as invalid' : 'resumed by hand'}): ${how.reason}`,
      data: { pauseId, scope },
      ...(team ? { projectId: team.projectId } : {}),
    },
    append,
  ).catch((err) => ctx.log.error({ err }, 'platform resume notice failed'));
  ctx.services.dispatcher.trigger();
  return true;
}

/**
 * Pauses whose bug card is done or cancelled (fixed, merged or closed as invalid) end by themselves. Called by the
 * platform pass of the dispatcher. Returns how many ended.
 */
export async function resumeFixedPauses(ctx: Ctx): Promise<number> {
  const open = await rows(
    ctx.pool,
    `SELECT pp.id, c.status AS card_status, c.ref, b.status AS bug_status
       FROM platform_pauses pp
       JOIN cards c ON c.id = pp.bug_card_id
       LEFT JOIN platform_bugs b ON b.signature = pp.bug_signature
      WHERE pp.resumed_at IS NULL AND (c.status IN ('done','cancelled') OR b.status IN ('fixed','invalid'))`,
  );
  let n = 0;
  for (const r of open) {
    const invalid = r.bug_status === 'invalid' || r.card_status === 'cancelled';
    const done = await endPause(ctx, r.id, {
      by: invalid ? 'invalid' : 'fix',
      reason: invalid ? `${r.ref} was closed without a fix` : `${r.ref} is fixed`,
    });
    if (done) n++;
  }
  return n;
}

export async function listPauses(
  ctx: Ctx,
  opts: { open?: boolean; limit?: number } = {},
): Promise<PlatformPauseDto[]> {
  const list = await rows(
    ctx.pool,
    `SELECT pp.*, p.key AS project_key, w.name AS workstation_name, c.ref AS card_ref
       FROM platform_pauses pp
       LEFT JOIN projects p ON p.id = pp.project_id
       LEFT JOIN workstations w ON w.id = pp.workstation_id
       LEFT JOIN cards c ON c.id = pp.bug_card_id
      WHERE ($1::boolean IS NOT TRUE OR pp.resumed_at IS NULL)
      ORDER BY pp.resumed_at IS NOT NULL, pp.created_at DESC LIMIT $2`,
    [opts.open ?? null, Math.min(opts.limit ?? 100, 500)],
  );
  return list.map(pauseDto);
}

const pauseDto = (r: Row): PlatformPauseDto => ({
  id: r.id,
  projectId: r.project_id,
  projectKey: r.project_key ?? null,
  workflowKey: r.workflow_key,
  stageId: r.stage_id,
  workstationId: r.workstation_id,
  workstationName: r.workstation_name ?? null,
  reason: r.reason,
  source: r.source,
  severity: r.severity,
  bugCardId: r.bug_card_id,
  bugCardRef: r.card_ref ?? null,
  createdAt: iso(r.created_at) as string,
  resumedAt: iso(r.resumed_at),
  resumeReason: r.resume_reason,
});

/**
 * The open pauses a user feels: pauses of the projects they belong to and of the workstations they own (the web app shows
 * a banner on those projects and a badge on those workstations). The reason is the same text the platform team wrote.
 */
export async function pausesForUser(ctx: Ctx, userId: string): Promise<PlatformPauseDto[]> {
  const list = await rows(
    ctx.pool,
    `SELECT pp.*, p.key AS project_key, w.name AS workstation_name, c.ref AS card_ref
       FROM platform_pauses pp
       LEFT JOIN projects p ON p.id = pp.project_id
       LEFT JOIN workstations w ON w.id = pp.workstation_id
       LEFT JOIN cards c ON c.id = pp.bug_card_id
      WHERE pp.resumed_at IS NULL
        AND ((pp.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM project_members pm
                       WHERE pm.user_id=$1 AND pm.status='active' AND pm.project_id = pp.project_id))
             OR (pp.workstation_id IS NOT NULL AND w.user_id = $1)
             OR (pp.project_id IS NULL AND pp.workstation_id IS NULL AND EXISTS (SELECT 1 FROM project_members pm
                       WHERE pm.user_id=$1 AND pm.status='active')))
      ORDER BY pp.created_at DESC LIMIT 100`,
    [userId],
  );
  return list.map(pauseDto);
}
