import { randomUUID } from 'node:crypto';
import {
  type ConnectionState,
  DEPLOY_SETUP_CAPABILITY,
  type DeployProbePayload,
  DeployProbeResultSchema,
  type ProbeRequest,
  probeErrorText,
  type SetupProbeDto,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { projectScope, runnerActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, rows } from '../db/sql.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';

/**
 * Deploy probes (docs/design/deploy-run-ux-design.md section 6): the server asks a workstation to look at Docker or a server
 * with the fixed read-only probe, and keeps the latest answer per target, workstation and scope. Nothing here runs a command.
 */

export const PROBE_STALE_MS = 3_600_000;

/** Why a workstation cannot do guided setup work now (null: it can). */
export async function setupBlockedReason(db: Queryable, workstationId: string): Promise<string | null> {
  const w = await one(
    db,
    `SELECT w.name, w.connected, w.status, c.capabilities
       FROM workstations w LEFT JOIN workstation_capabilities c ON c.workstation_id = w.id WHERE w.id=$1`,
    [workstationId],
  );
  if (!w || w.status !== 'active') return 'That computer is gone.';
  if (!(w.capabilities ?? []).includes(DEPLOY_SETUP_CAPABILITY))
    return `Guildwise on ${w.name} needs an update for guided setup.`;
  if (!w.connected) return `${w.name} is offline.`;
  return null;
}

/** Asks a workstation to probe. Project members may probe a target's own workstation; anything else only their own computers. */
export async function requestProbe(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: ProbeRequest,
): Promise<{ commandId: string; workstationId: string }> {
  const project = await loadVisibleProject(ctx.pool, user.id, projectId);
  const target = req.targetId
    ? await one(
        ctx.pool,
        `SELECT * FROM deploy_targets WHERE id=$1 AND project_id=$2 AND removed_at IS NULL`,
        [req.targetId, projectId],
      )
    : undefined;
  if (req.targetId && !target) throw notFound('deploy target not found');
  let workstationId = req.workstationId ?? target?.workstation_id ?? null;
  if (!workstationId) {
    const mine = await rows(
      ctx.pool,
      `SELECT w.id FROM workstations w WHERE w.user_id=$1 AND w.status='active' ORDER BY w.connected DESC, w.paired_at, w.id`,
      [user.id],
    );
    workstationId = mine[0]?.id ?? null;
  }
  if (!workstationId) throw conflict('no_workstation', 'you have no computer paired yet');
  const ws = await one(
    ctx.pool,
    `SELECT id, user_id, name FROM workstations WHERE id=$1 AND status='active'`,
    [workstationId],
  );
  if (!ws) throw notFound('workstation not found');
  // The ssh hosts and Docker of a computer belong to its owner. Another member may only ask the target's own deploying
  // computer to look at THAT target's server (its own host, nothing they type), which is what the target is for.
  const targetsOwn = !!target && target.workstation_id === ws.id;
  const mine = ws.user_id === user.id;
  if (!mine && !targetsOwn) throw forbidden('you can only check your own computers');
  if (!mine && req.scope !== 'ssh_target')
    throw forbidden('only the owner of a computer can look at its Docker or list its servers');
  const blocked = await setupBlockedReason(ctx.pool, ws.id);
  if (blocked)
    throw conflict(blocked.includes('update') ? 'runner_outdated' : 'workstation_offline', blocked);
  const wantsHost = req.scope === 'ssh_target';
  // a member who does not own the computer gets the target's own host and address, never a name or a path of their choosing
  const host = wantsHost
    ? mine
      ? (req.host ?? target?.host ?? undefined)
      : ((target?.host as string | null) ?? undefined)
    : undefined;
  if (wantsHost && !host) throw conflict('host_required', 'name the server to look at');
  const hints = mine
    ? {
        ...(req.hints?.composeFiles?.length ? { composeFiles: req.hints.composeFiles } : {}),
        ...(req.hints?.dirs?.length ? { dirs: req.hints.dirs } : {}),
        urls: [
          ...new Set([...(req.hints?.urls ?? []), ...(target?.app_url ? [target.app_url as string] : [])]),
        ].slice(0, 10),
      }
    : { urls: target?.app_url ? [target.app_url as string] : [] };
  const payload: DeployProbePayload = {
    projectId: project.id,
    ...(target ? { targetId: target.id } : {}),
    scope: req.scope,
    ...(host ? { host: host as string } : {}),
    hints,
  };
  const commandId = await enqueueRunnerCommand(
    ctx.pool,
    ws.id,
    'deploy.probe',
    payload as unknown as Record<string, unknown>,
  );
  void Promise.resolve(ctx.services.gateway.deliverPending(ws.id)).catch(() => undefined);
  return { commandId, workstationId: ws.id };
}

const ERROR_STATE: Record<string, ConnectionState> = {
  ssh_auth: 'asks_password',
  ssh_unreachable: 'unreachable',
  ssh_host_key_changed: 'host_key_changed',
  ssh_host_key_unknown: 'host_key_unknown',
  timeout: 'unreachable',
};

/** `command.result` of `deploy.probe`: the report (or the error) becomes a fact, and the ssh answers become connection states. */
export async function applyProbeResult(
  ctx: Ctx,
  workstationId: string,
  payload: Record<string, any>,
  ok: boolean,
  result: unknown,
  error?: string,
): Promise<void> {
  const projectId = typeof payload.projectId === 'string' ? payload.projectId : null;
  if (!projectId) return;
  const project = await one(ctx.pool, `SELECT id, org_id FROM projects WHERE id=$1 AND kind='project'`, [
    projectId,
  ]);
  if (!project) return;
  const parsed = ok ? DeployProbeResultSchema.safeParse(result) : undefined;
  const res = parsed?.success
    ? parsed.data
    : ({ ok: false, error: 'bad_request', detail: error ?? 'the computer could not run the check' } as const);
  const scope = payload.scope as 'local' | 'ssh_hosts' | 'ssh_target';
  const host = typeof payload.host === 'string' ? payload.host : null;
  const targetId = typeof payload.targetId === 'string' ? payload.targetId : null;
  const at = (res.ok ? res.report.at : ctx.clock.now().toISOString()) as string;
  const events: AppendInput[] = [
    {
      streamId: streamId.project(projectId),
      event: {
        type: 'DeployTargetProbed',
        payload: {
          probeId: randomUUID(),
          projectId,
          targetId,
          workstationId,
          scope,
          host,
          report: res.ok ? res.report : null,
          error: res.ok ? null : res.error,
          detail: res.ok ? null : (res.detail ?? null),
          at,
        },
      },
      actor: runnerActor(workstationId),
      scope: projectScope(project.org_id, projectId),
    },
  ];
  // Reachability: a probe of the ssh hosts says it for every target of this workstation, a probe of one server for that target.
  const checks: Array<{ targetId: string; host: string; state: ConnectionState; detail: string | null }> = [];
  if (scope === 'ssh_hosts' && res.ok) {
    const targets = await rows(
      ctx.pool,
      `SELECT id, host FROM deploy_targets WHERE project_id=$1 AND kind='remote_ssh' AND workstation_id=$2 AND removed_at IS NULL`,
      [projectId, workstationId],
    );
    for (const t of targets) {
      const h = res.report.sshHosts?.find((x) => x.alias === t.host);
      if (h && h.state !== 'unchecked')
        checks.push({ targetId: t.id, host: h.alias, state: h.state, detail: h.detail ?? null });
    }
  } else if (scope === 'ssh_target' && targetId && host) {
    if (res.ok) checks.push({ targetId, host, state: 'reachable', detail: null });
    else if (ERROR_STATE[res.error])
      checks.push({
        targetId,
        host,
        state: ERROR_STATE[res.error] as ConnectionState,
        detail: probeErrorText(res.error, host).slice(0, 290),
      });
  }
  for (const c of checks)
    events.push({
      streamId: streamId.project(projectId),
      event: {
        type: 'DeployTargetConnectionChecked',
        payload: {
          targetId: c.targetId,
          projectId,
          workstationId,
          state: c.state,
          method: 'existing_alias',
          host: c.host,
          detail: c.detail,
          at,
        },
      },
      actor: runnerActor(workstationId),
      scope: projectScope(project.org_id, projectId),
    });
  await ctx.store.append(events);
}

/** The latest probes of a project, newest first, with plain-words errors. */
export async function listProbeDtos(
  db: Queryable,
  projectId: string,
  /** Who is looking: a probe is visible to the owner of the computer that made it and to the project owner. */
  viewer: { userId: string; projectOwner: boolean },
): Promise<SetupProbeDto[]> {
  const list = await rows(
    db,
    `SELECT p.*, w.name AS workstation_name FROM deploy_probes p JOIN workstations w ON w.id = p.workstation_id
      WHERE p.project_id=$1 AND ($2::boolean OR w.user_id = $3) ORDER BY p.at DESC LIMIT 40`,
    [projectId, viewer.projectOwner, viewer.userId],
  );
  return list.map((r) => ({
    id: r.id,
    targetId: r.target_id ?? null,
    workstationId: r.workstation_id,
    workstationName: r.workstation_name,
    scope: r.scope,
    host: r.host ?? null,
    at: iso(r.at) as string,
    report: r.report ?? null,
    error: r.error ?? null,
    errorText: r.error
      ? r.detail && r.error === 'bad_request'
        ? String(r.detail)
        : probeErrorText(r.error, r.host ?? undefined)
      : null,
  }));
}
