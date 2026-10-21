import { randomUUID } from 'node:crypto';
import {
  buildMoveSpec,
  DEPLOY_MOVE_CAPABILITY,
  DeliverySetupSchema,
  type DeployMovePayload,
  DeployMovePayloadSchema,
  type DeployMoveResult,
  DeployMoveResultSchema,
  type DnsCheckDto,
  dnsVerdict,
  domainOfUrl,
  MOVE_OPEN_STATES,
  type MoveCompleteRequest,
  type MoveDto,
  type MoveFacts,
  type MoveStartRequest,
  type MoveStep,
  moveErrorText,
  moveStateAfter,
  nextMoveStep,
  type RetireRequest,
  resumeStep,
  standbyName,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { projectScope, runnerActor, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { ownComputer, serverTarget } from './connect.ts';
import { resolveAddresses } from './dns.ts';
import { projectOwnerOrThrow } from './setup.ts';

/**
 * Moving to a new server, server side (docs/design/deploy-run-ux-design.md J6, v3). The server never touches a server: it checks who
 * may ask, builds the move from the approved guided setup (never from the browser), relays ONE step at a time to the computer that
 * deploys both servers, keeps what each step said (plain words, no secret value), chains the steps that change nothing on the old
 * server, waits for the person before the one that takes the old app down, and swaps the names only when the Owner confirms.
 */

export async function moveBlockedReason(db: Queryable, workstationId: string): Promise<string | null> {
  const w = await one(
    db,
    `SELECT w.name, w.connected, w.status, c.capabilities
       FROM workstations w LEFT JOIN workstation_capabilities c ON c.workstation_id = w.id WHERE w.id=$1`,
    [workstationId],
  );
  if (!w || w.status !== 'active') return 'That computer is gone.';
  if (!(w.capabilities ?? []).includes(DEPLOY_MOVE_CAPABILITY))
    return `Guildwise on ${w.name} needs an update to move to a new server.`;
  if (!w.connected) return `${w.name} is offline.`;
  return null;
}

async function requireComputer(ctx: Ctx, user: AuthSession['user'], workstationId: string) {
  const ws = await ownComputer(ctx, user, workstationId);
  const blocked = await moveBlockedReason(ctx.pool, ws.id);
  if (blocked)
    throw conflict(blocked.includes('update') ? 'runner_outdated' : 'workstation_offline', blocked);
  return ws;
}

/** An open move of the project (any of its targets), or undefined. */
export const openMoveOf = (db: Queryable, projectId: string): Promise<Row | undefined> =>
  one(
    db,
    `SELECT * FROM deploy_target_moves WHERE project_id=$1 AND state = ANY($2::text[]) ORDER BY started_at DESC LIMIT 1`,
    [projectId, [...MOVE_OPEN_STATES]],
  );

const inFlight = (db: Queryable, moveId: string) =>
  one(
    db,
    `SELECT 1 AS x FROM runner_commands WHERE type='deploy.move' AND status IN ('pending','sent') AND payload->>'moveId'=$1`,
    [moveId],
  );

async function ownerOrThrow(ctx: Ctx, user: AuthSession['user'], orgId: string, what: string): Promise<void> {
  if ((await orgRoleOf(ctx.pool, user.id, orgId)) !== 'owner')
    throw forbidden(`only the Owner of the organization ${what}`);
}

async function enqueueStep(
  ctx: Ctx,
  move: Row,
  step: MoveStep,
  facts: MoveFacts = {},
  /** Extra, un-validated fields the server reads back from the stored command (the runner's zod parse drops them). */
  extra: Record<string, unknown> = {},
): Promise<string> {
  const payload: DeployMovePayload = DeployMovePayloadSchema.parse({
    projectId: move.project_id,
    moveId: move.id,
    step,
    spec: move.spec,
    context: {
      ...(facts.backupFile ? { backupFile: facts.backupFile } : {}),
      ...(facts.appPort ? { appPort: facts.appPort } : {}),
    },
  });
  const id = await enqueueRunnerCommand(ctx.pool, move.workstation_id, 'deploy.move', {
    ...payload,
    ...extra,
  } as never);
  void Promise.resolve(ctx.services.gateway.deliverPending(move.workstation_id)).catch(() => undefined);
  return id;
}

// ------------------------------------------------------------------------------------------------ views

async function addressOf(db: Queryable, targetId: string): Promise<string | null> {
  const k = await one(
    db,
    `SELECT address FROM deploy_target_keys WHERE target_id=$1 AND address IS NOT NULL ORDER BY added_at DESC LIMIT 1`,
    [targetId],
  );
  return (k?.address as string | undefined) ?? null;
}

export async function toMoveDto(db: Queryable, m: Row, withAddresses = false): Promise<MoveDto> {
  const names = await rows(db, 'SELECT id, name FROM deploy_targets WHERE id = ANY($1::uuid[])', [
    [m.from_target_id, m.to_target_id],
  ]);
  const name = (id: string) => names.find((n) => n.id === id)?.name ?? 'a server';
  const ws = await one(db, 'SELECT name FROM workstations WHERE id=$1', [m.workstation_id]);
  let newAddresses: string[] = [];
  if (withAddresses && (MOVE_OPEN_STATES as readonly string[]).includes(m.state)) {
    const a = await addressOf(db, m.to_target_id);
    if (a) newAddresses = await resolveAddresses(a).catch(() => []);
  }
  return {
    id: m.id,
    projectId: m.project_id,
    envName: m.env_name,
    fromTargetId: m.from_target_id,
    fromName: name(m.from_target_id),
    toTargetId: m.to_target_id,
    toName: name(m.to_target_id),
    workstationId: m.workstation_id,
    workstationName: ws?.name ?? 'a computer',
    state: m.state,
    currentStep: m.current_step ?? null,
    steps: ((m.steps ?? []) as Array<Record<string, any>>).map((s) => ({
      step: s.step,
      ok: !!s.ok,
      detail: s.detail ?? null,
      checks: s.checks ?? [],
      at: s.at,
    })),
    error: m.error ?? null,
    oldAppStopped: !!m.old_app_stopped,
    facts: m.facts ?? {},
    domain: m.domain ?? null,
    newAddresses,
    startedAt: iso(m.started_at) as string,
    finishedAt: m.finished_at ? (iso(m.finished_at) as string) : null,
  };
}

export async function listMoves(ctx: Ctx, user: AuthSession['user'], projectId: string): Promise<MoveDto[]> {
  await loadVisibleProject(ctx.pool, user.id, projectId);
  const list = await rows(
    ctx.pool,
    `SELECT * FROM deploy_target_moves WHERE project_id=$1 ORDER BY started_at DESC LIMIT 10`,
    [projectId],
  );
  return Promise.all(list.map((m) => toMoveDto(ctx.pool, m, true)));
}

async function loadMove(ctx: Ctx, projectId: string, moveId: string): Promise<Row> {
  const m = await one(ctx.pool, 'SELECT * FROM deploy_target_moves WHERE id=$1 AND project_id=$2', [
    moveId,
    projectId,
  ]);
  if (!m) throw notFound('move not found');
  return m;
}

export async function getMove(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  moveId: string,
): Promise<MoveDto> {
  await loadVisibleProject(ctx.pool, user.id, projectId);
  return toMoveDto(ctx.pool, await loadMove(ctx, projectId, moveId), true);
}

// ------------------------------------------------------------------------------------------------ start

export async function startMove(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: MoveStartRequest,
): Promise<MoveDto> {
  const project = await projectOwnerOrThrow(ctx, user, projectId);
  const ws = await requireComputer(ctx, user, req.workstationId);
  if (req.fromTargetId === req.toTargetId) throw unprocessable('same_server', 'choose a different server');
  const from = await serverTarget(ctx.pool, projectId, req.fromTargetId);
  const to = await serverTarget(ctx.pool, projectId, req.toTargetId);
  if (from.role !== 'active') throw unprocessable('not_active', `${from.name} is not the server in use`);
  if (to.role !== 'active') throw unprocessable('not_active', `${to.name} cannot be moved to`);
  if (from.workstation_id !== ws.id || to.workstation_id !== ws.id)
    throw unprocessable(
      'one_computer',
      'The same computer has to sign in to both servers. Connect the new server from the computer that deploys the old one (or reconnect the old one from this computer first).',
    );
  const open = await openMoveOf(ctx.pool, projectId);
  if (open) throw conflict('move_in_progress', 'a move is already in progress for this project');
  // the move is built from the approved guided setup: where the compose file is, which part is the app and which the database
  const rec = await one(ctx.pool, 'SELECT status, setup FROM delivery_recipes WHERE project_id=$1', [
    projectId,
  ]);
  const parsed = DeliverySetupSchema.safeParse(rec?.setup ?? null);
  if (!rec || !parsed.success)
    throw unprocessable('no_guided_setup', 'Moving needs the guided deploy setup of this project.');
  if (rec.status !== 'approved')
    throw unprocessable(
      'not_approved',
      'Approve the current deploy setup first: a move follows what is approved.',
    );
  const env = parsed.data.environments.find((e) => e.target === from.name && e.hosting === 'ssh');
  if (!env)
    throw unprocessable(
      'not_in_setup',
      `No part of the deploy setup deploys to ${from.name}, so there is nothing to move.`,
    );
  const built = buildMoveSpec(
    env,
    { targetId: from.id, alias: String(from.host) },
    { targetId: to.id, alias: String(to.host) },
  );
  if (!built.ok) throw unprocessable('cannot_move', built.blockers.join(' '));
  const running = await one(
    ctx.pool,
    `SELECT 1 AS x FROM deploy_runs WHERE project_id=$1 AND env=$2 AND status IN ('requested','waiting_release','queued','running')`,
    [projectId, env.name],
  );
  if (running)
    throw conflict('deploy_running', 'a deploy of this environment is running: wait until it is done');
  const moveId = randomUUID();
  await ctx.store.append([
    {
      streamId: streamId.project(projectId),
      event: {
        type: 'DeployTargetMoveStarted',
        payload: {
          moveId,
          projectId,
          envName: env.name,
          fromTargetId: from.id,
          toTargetId: to.id,
          workstationId: ws.id,
          spec: built.spec,
          domain: domainOfUrl(from.app_url) ?? domainOfUrl(env.app.appUrl),
          by: user.id,
          at: ctx.clock.now().toISOString(),
        },
      },
      actor: userActor(user.id),
      scope: projectScope(project.org_id, projectId),
    },
  ]);
  const move = await loadMove(ctx, projectId, moveId);
  await enqueueStep(ctx, move, 'check');
  return toMoveDto(ctx.pool, move, true);
}

// ------------------------------------------------------------------------------------------------ the person's decisions

async function resume(ctx: Ctx, user: AuthSession['user'], m: Row, step: MoveStep): Promise<void> {
  const project = await one(ctx.pool, 'SELECT org_id FROM projects WHERE id=$1', [m.project_id]);
  await ctx.store.append([
    {
      streamId: streamId.project(m.project_id),
      event: {
        type: 'DeployTargetMoveResumed',
        payload: {
          moveId: m.id,
          projectId: m.project_id,
          step,
          by: user.id,
          at: ctx.clock.now().toISOString(),
        },
      },
      actor: userActor(user.id),
      scope: projectScope(project?.org_id, m.project_id),
    },
  ]);
  await enqueueStep(ctx, m, step, (m.facts ?? {}) as MoveFacts);
}

/** "Yes, a short downtime is fine": the old app is stopped, the last backup is taken, the data moves, the new app starts. */
export async function switchMove(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  moveId: string,
): Promise<MoveDto> {
  await projectOwnerOrThrow(ctx, user, projectId);
  const m = await loadMove(ctx, projectId, moveId);
  if (m.state !== 'ready') throw conflict('not_ready', 'the new server is not ready for the switch yet');
  if (await inFlight(ctx.pool, m.id)) throw conflict('step_running', 'a step is still running');
  await requireComputer(ctx, user, m.workstation_id);
  await resume(ctx, user, m, 'stop_and_backup');
  return toMoveDto(ctx.pool, await loadMove(ctx, projectId, moveId), true);
}

export async function retryMove(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  moveId: string,
): Promise<MoveDto> {
  await projectOwnerOrThrow(ctx, user, projectId);
  const m = await loadMove(ctx, projectId, moveId);
  if (m.state !== 'failed') throw conflict('not_failed', 'there is nothing to try again');
  if (await inFlight(ctx.pool, m.id)) throw conflict('step_running', 'a step is still running');
  await requireComputer(ctx, user, m.workstation_id);
  const step = m.current_step === 'restart_old' ? 'restart_old' : resumeStep(m.current_step as MoveStep);
  await resume(ctx, user, m, step);
  return toMoveDto(ctx.pool, await loadMove(ctx, projectId, moveId), true);
}

/** Give the move up: the old app is started again when this move stopped it. Nothing is deleted anywhere. */
export async function cancelMove(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  moveId: string,
): Promise<MoveDto> {
  const project = await projectOwnerOrThrow(ctx, user, projectId);
  const m = await loadMove(ctx, projectId, moveId);
  if (!(MOVE_OPEN_STATES as readonly string[]).includes(m.state))
    throw conflict('not_open', 'this move is over already');
  if (await inFlight(ctx.pool, m.id))
    throw conflict('step_running', 'a step is still running: wait a moment');
  const unknown = ((m.facts ?? {}) as MoveFacts).oldAppUnknown === true;
  if (m.old_app_stopped || m.state === 'app_ready' || unknown) {
    // (a stop that timed out may have stopped it: the undo is safe to run when it did not)
    // the old app comes back (and the new one stops, so two copies never write to two databases)
    await requireComputer(ctx, user, m.workstation_id);
    await resume(ctx, user, m, 'restart_old');
  } else {
    await ctx.store.append([
      {
        streamId: streamId.project(projectId),
        event: {
          type: 'DeployTargetMoveCancelled',
          payload: { moveId: m.id, projectId, by: user.id, at: ctx.clock.now().toISOString() },
        },
        actor: userActor(user.id),
        scope: projectScope(project.org_id, projectId),
      },
    ]);
  }
  return toMoveDto(ctx.pool, await loadMove(ctx, projectId, moveId), true);
}

// ------------------------------------------------------------------------------------------------ DNS and going live

export async function dnsCheck(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  moveId: string,
): Promise<DnsCheckDto> {
  await loadVisibleProject(ctx.pool, user.id, projectId);
  const m = await loadMove(ctx, projectId, moveId);
  return computeDns(ctx, m);
}

async function computeDns(ctx: Ctx, m: Row): Promise<DnsCheckDto> {
  const domain = (m.domain as string | null) ?? null;
  if (!domain) throw unprocessable('no_domain', 'This app has no web name, so there is nothing to point.');
  const [newAddr, oldAddr] = await Promise.all([
    addressOf(ctx.pool, m.to_target_id),
    addressOf(ctx.pool, m.from_target_id),
  ]);
  const expected = newAddr ? await resolveAddresses(newAddr).catch(() => []) : [];
  const oldAddresses = oldAddr ? await resolveAddresses(oldAddr).catch(() => []) : [];
  let found: string[] = [];
  let failed: string | undefined;
  try {
    found = await resolveAddresses(domain);
  } catch (err) {
    failed = (err as { code?: string }).code ?? 'lookup failed';
  }
  const v = expected.length
    ? dnsVerdict(domain, found, expected, oldAddresses, failed)
    : ({ state: 'error', text: 'The address of the new server is not known yet.' } as const);
  return {
    domain,
    state: v.state,
    expected,
    found,
    oldAddresses,
    at: ctx.clock.now().toISOString(),
    text: v.text,
  };
}

/** The Owner makes the new server live: it takes the name the approved deploy files use; the old one becomes the standby. */
export async function completeMove(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  moveId: string,
  req: MoveCompleteRequest,
): Promise<MoveDto> {
  const project = await loadVisibleProject(ctx.pool, user.id, projectId);
  await ownerOrThrow(ctx, user, project.org_id, 'makes a new server live');
  const m = await loadMove(ctx, projectId, moveId);
  if (m.state !== 'app_ready')
    throw conflict('not_app_ready', 'the app on the new server has to be running and answering first');
  if (await inFlight(ctx.pool, m.id)) throw conflict('step_running', 'a step is still running');
  if (req.dns === 'verified') {
    const d = await computeDns(ctx, m);
    if (d.state !== 'new')
      throw conflict('dns_not_ready', `The domain does not point to the new server yet. ${d.text}`);
  }
  const from = await one(ctx.pool, 'SELECT * FROM deploy_targets WHERE id=$1 AND removed_at IS NULL', [
    m.from_target_id,
  ]);
  const to = await one(ctx.pool, 'SELECT * FROM deploy_targets WHERE id=$1 AND removed_at IS NULL', [
    m.to_target_id,
  ]);
  if (!from || !to || from.role !== 'active' || to.role !== 'active')
    throw conflict('targets_changed', 'one of the servers changed meanwhile: look at the move again');
  const taken = (
    await rows(ctx.pool, 'SELECT name FROM deploy_targets WHERE project_id=$1 AND removed_at IS NULL', [
      projectId,
    ])
  ).map((r) => String(r.name));
  const events: AppendInput[] = [
    {
      streamId: streamId.project(projectId),
      event: {
        type: 'DeployTargetMoveCompleted',
        payload: {
          moveId: m.id,
          projectId,
          fromTargetId: from.id,
          toTargetId: to.id,
          fromNewName: standbyName(from.name, taken),
          toNewName: from.name,
          production: !!from.production,
          appUrl: from.app_url ?? null,
          dns: req.dns,
          by: user.id,
          at: ctx.clock.now().toISOString(),
        },
      },
      actor: userActor(user.id),
      scope: projectScope(project.org_id, projectId),
    },
  ];
  await ctx.store.append(events);
  return toMoveDto(ctx.pool, await loadMove(ctx, projectId, moveId), true);
}

// ------------------------------------------------------------------------------------------------ retire

/**
 * The Owner lets the standby go: the computer that deploys it removes the keys Guildwise added (and nothing else) from the old
 * server. The data, the app and the settings there are not touched; Guildwise never deletes them.
 */
export async function retireTarget(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  targetId: string,
  _req: RetireRequest,
): Promise<{ commandId: string }> {
  const project = await loadVisibleProject(ctx.pool, user.id, projectId);
  await ownerOrThrow(ctx, user, project.org_id, 'retires a server');
  const t = await serverTarget(ctx.pool, projectId, targetId);
  if (t.role !== 'standby')
    throw unprocessable('not_standby', 'only the old server of a finished move can be retired');
  const m = await one(
    ctx.pool,
    `SELECT * FROM deploy_target_moves WHERE from_target_id=$1 AND state='completed' ORDER BY finished_at DESC LIMIT 1`,
    [targetId],
  );
  if (!m) throw unprocessable('no_move', 'this server was not left by a Guildwise move');
  if (await inFlight(ctx.pool, m.id)) throw conflict('step_running', 'this server is being retired already');
  const blocked = await moveBlockedReason(ctx.pool, m.workstation_id);
  if (blocked)
    throw conflict(blocked.includes('update') ? 'runner_outdated' : 'workstation_offline', blocked);
  return { commandId: await enqueueStep(ctx, m, 'retire_keys', {}, { requestedBy: user.id }) };
}

// ------------------------------------------------------------------------------------------------ results

/** `command.result` of `deploy.move`. Records what the step said and chains the next one. */
export async function applyMoveResult(
  ctx: Ctx,
  workstationId: string,
  cmd: { id: string; payload: Record<string, any> },
  ok: boolean,
  result: unknown,
  error?: string,
): Promise<void> {
  const payload = DeployMovePayloadSchema.safeParse(cmd.payload);
  if (!payload.success) return;
  const { moveId, projectId, step } = payload.data;
  const m = await one(ctx.pool, 'SELECT * FROM deploy_target_moves WHERE id=$1 AND project_id=$2', [
    moveId,
    projectId,
  ]);
  if (!m) return;
  const parsed = ok ? DeployMoveResultSchema.safeParse(result) : undefined;
  const res: DeployMoveResult = parsed?.success
    ? parsed.data
    : {
        ok: false,
        step,
        error: 'bad_request',
        detail: (error ?? 'the computer could not run this step').slice(0, 300),
        checks: [],
        facts: {},
      };
  const at = ctx.clock.now().toISOString();
  const project = await one(ctx.pool, 'SELECT org_id FROM projects WHERE id=$1', [projectId]);
  if (!project) return;
  const scope = projectScope(project.org_id, projectId);
  const actor = runnerActor(workstationId);

  if (step === 'retire_keys') {
    const events: AppendInput[] = [
      {
        streamId: streamId.project(projectId),
        event: {
          type: 'DeployTargetMoveStepDone',
          payload: {
            moveId,
            projectId,
            step,
            ok: res.ok,
            detail: res.ok
              ? (res.checks[0]?.text ?? null)
              : moveErrorText(res.error ?? 'failed', res.detail).slice(0, 380),
            checks: res.checks,
            facts: res.facts,
            state: m.state,
            oldAppStopped: !!m.old_app_stopped,
            error: res.ok ? null : moveErrorText(res.error ?? 'failed', res.detail).slice(0, 480),
            at,
          },
        },
        actor,
        scope,
      },
    ];
    if (res.ok) {
      const keys = await rows(
        ctx.pool,
        `SELECT workstation_id, fingerprint FROM deploy_target_keys WHERE target_id=$1 AND state='active'`,
        [m.from_target_id],
      );
      for (const k of keys)
        events.push({
          streamId: streamId.project(projectId),
          event: {
            type: 'DeployKeyRevoked',
            payload: {
              targetId: m.from_target_id,
              projectId,
              workstationId: k.workstation_id,
              fingerprint: k.fingerprint,
              byWorkstationId: workstationId,
              removed: res.facts.removedKeys ?? 0,
              by: typeof cmd.payload.requestedBy === 'string' ? cmd.payload.requestedBy : null,
              at,
            },
          },
          actor,
          scope,
        });
      events.push({
        streamId: streamId.project(projectId),
        event: {
          type: 'DeployTargetRetired',
          payload: {
            targetId: m.from_target_id,
            projectId,
            removedKeys: res.facts.removedKeys ?? 0,
            by: typeof cmd.payload.requestedBy === 'string' ? cmd.payload.requestedBy : m.started_by,
            at,
          },
        },
        actor,
        scope,
      });
    }
    await ctx.store.append(events);
    return;
  }

  // a late answer for a move that is over changes nothing (except the undo, which is how a move ends)
  if (m.state === 'completed' || (m.state === 'cancelled' && step !== 'restart_old')) return;

  const success = res.ok;
  const state = moveStateAfter(step, success);
  const oldStopped =
    step === 'stop_and_backup' && success
      ? true
      : step === 'restart_old' && success
        ? false
        : res.oldAppRunning === true
          ? false
          : !!m.old_app_stopped;
  // A failed "stop and back up" that does not say the app is running leaves the old app in an unknown state (it may be
  // stopped): remembered, so a cancel runs the (idempotent) undo. Any step that knows clears it.
  const oldAppUnknown =
    step === 'stop_and_backup'
      ? !success && res.oldAppRunning !== true
      : step === 'restart_old'
        ? success
          ? false
          : null
        : res.oldAppRunning !== undefined
          ? false
          : null;
  const eventFacts: MoveFacts = oldAppUnknown === null ? res.facts : { ...res.facts, oldAppUnknown };
  const detail = success
    ? (res.checks.find((c) => c.ok)?.text ?? null)
    : moveErrorText(res.error ?? 'failed', res.detail).slice(0, 380);
  await ctx.store.append([
    {
      streamId: streamId.project(projectId),
      event: {
        type: 'DeployTargetMoveStepDone',
        payload: {
          moveId,
          projectId,
          step,
          ok: success,
          detail,
          checks: res.checks,
          facts: eventFacts,
          state,
          oldAppStopped: oldStopped,
          error: success ? null : moveErrorText(res.error ?? 'failed', res.detail).slice(0, 480),
          at,
        },
      },
      actor,
      scope,
    },
  ]);
  if (!success) return;
  const next = nextMoveStep(step);
  if (!next) return;
  const fresh = await one(ctx.pool, 'SELECT * FROM deploy_target_moves WHERE id=$1', [moveId]);
  if (fresh) await enqueueStep(ctx, fresh, next, (fresh.facts ?? {}) as MoveFacts);
}
