import { randomUUID } from 'node:crypto';
import {
  type ConnectRequest,
  type ConnectStartedDto,
  connectErrorText,
  DEPLOY_CONNECT_CAPABILITY,
  DEPLOY_SETUP_V2_CAPABILITY,
  type DeployConnectPayload,
  DeployConnectResultSchema,
  type DeployKeyDto,
  type DeployKeyPayload,
  DeployKeyResultSchema,
  type DeployPreparePayload,
  DeployPrepareResultSchema,
  type DeployRevokePayload,
  DeployRevokePayloadSchema,
  DeployRevokeResultSchema,
  type DeployTargetDto,
  type HostKeyScanPayload,
  type HostKeyScanRequest,
  HostKeyScanResultSchema,
  type KeyCreateRequest,
  type OpKind,
  type OpStartedDto,
  type OpStatusDto,
  type PrepareAction,
  type PrepareInputs,
  type PrepareRequest,
  type ProbeReport,
  planPrepare,
  prepareActionProblems,
  type ReachabilityDto,
  type RevokeKeyRequest,
  revokeErrorText,
  streamId,
  suggestAlias,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { projectScope, runnerActor, userActor } from '../commands/common.ts';
import { addDeployTarget } from '../commands/deploy-targets.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { projectOwnerOrThrow } from './setup.ts';

/**
 * Guided connect, dedicated keys, revoke and server preparation, server side (docs/design/deploy-run-ux-design.md v2). The
 * server never touches a server: it validates who may ask, relays a fixed command to the computer that deploys, keeps the
 * public facts (a key's fingerprint and public line, what each step did) and forgets the sealed sign-in as soon as the
 * computer answered. A password or key file is only ever ciphertext here.
 */

export const CONNECT_TTL_MS = 10 * 60_000;

/** Why a workstation cannot do guided connect now (null: it can). */
export async function connectBlockedReason(db: Queryable, workstationId: string): Promise<string | null> {
  const w = await one(
    db,
    `SELECT w.name, w.connected, w.status, c.capabilities
       FROM workstations w LEFT JOIN workstation_capabilities c ON c.workstation_id = w.id WHERE w.id=$1`,
    [workstationId],
  );
  if (!w || w.status !== 'active') return 'That computer is gone.';
  if (!(w.capabilities ?? []).includes(DEPLOY_CONNECT_CAPABILITY))
    return `Guildwise on ${w.name} needs an update to set up a server sign-in.`;
  if (!w.connected) return `${w.name} is offline.`;
  return null;
}

/** The workstation of the person asking: connect works on their own computers only (their password, their sign-in). */
export async function ownComputer(ctx: Ctx, user: AuthSession['user'], workstationId: string) {
  const ws = await one(
    ctx.pool,
    `SELECT id, name, user_id FROM workstations WHERE id=$1 AND status='active'`,
    [workstationId],
  );
  if (!ws) throw notFound('computer not found');
  if (ws.user_id !== user.id) throw forbidden('you can only use your own computers for this');
  const blocked = await connectBlockedReason(ctx.pool, ws.id);
  if (blocked)
    throw conflict(blocked.includes('update') ? 'runner_outdated' : 'workstation_offline', blocked);
  return ws as { id: string; name: string; user_id: string };
}

export async function serverTarget(db: Queryable, projectId: string, targetId: string) {
  const t = await one(
    db,
    `SELECT * FROM deploy_targets WHERE id=$1 AND project_id=$2 AND removed_at IS NULL`,
    [targetId, projectId],
  );
  if (!t) throw notFound('deploy target not found');
  if (t.kind !== 'remote_ssh') throw unprocessable('not_a_server', 'that target is not a server');
  return t;
}

async function enqueueOp(
  ctx: Ctx,
  workstationId: string,
  type: 'deploy.hostkey' | 'deploy.key' | 'deploy.connect' | 'deploy.revoke' | 'deploy.prepare',
  payload: object,
  expires?: Date,
): Promise<string> {
  const id = await enqueueRunnerCommand(
    ctx.pool,
    workstationId,
    type,
    payload as Record<string, unknown>,
    expires,
  );
  void Promise.resolve(ctx.services.gateway.deliverPending(workstationId)).catch(() => undefined);
  return id;
}

// ------------------------------------------------------------------------------------------------ requests

export async function requestHostKeyScan(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: HostKeyScanRequest,
): Promise<OpStartedDto> {
  await projectOwnerOrThrow(ctx, user, projectId);
  const ws = await ownComputer(ctx, user, req.workstationId);
  const payload: HostKeyScanPayload = { projectId, address: req.address, port: req.port };
  return { commandId: await enqueueOp(ctx, ws.id, 'deploy.hostkey', payload), workstationId: ws.id };
}

export async function requestKey(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: KeyCreateRequest,
): Promise<OpStartedDto> {
  await projectOwnerOrThrow(ctx, user, projectId);
  const ws = await ownComputer(ctx, user, req.workstationId);
  if (req.targetId) await serverTarget(ctx.pool, projectId, req.targetId);
  const payload = {
    projectId,
    ...(req.targetId ? { targetId: req.targetId } : { keyRef: req.keyRef }),
    label: ws.name,
  } as DeployKeyPayload;
  return { commandId: await enqueueOp(ctx, ws.id, 'deploy.key', payload), workstationId: ws.id };
}

export async function requestConnect(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: ConnectRequest,
): Promise<ConnectStartedDto> {
  const project = await projectOwnerOrThrow(ctx, user, projectId);
  const ws = await ownComputer(ctx, user, req.workstationId);
  if (req.method === 'alias' && !req.alias) throw badRequest('alias_required', 'name the sign-in to use');
  if (req.method !== 'alias') {
    for (const k of ['address', 'user', 'hostKeyFingerprint'] as const)
      if (!req[k]) throw badRequest('missing_field', `${k} is needed`);
  }
  if ((req.method === 'password' || req.method === 'keyfile') && (!req.ciphertext || !req.keyId))
    throw badRequest('missing_secret', 'the sealed sign-in is needed');
  if (req.keyId) {
    const k = await one(ctx.pool, 'SELECT key_id FROM workstation_keys WHERE workstation_id=$1', [ws.id]);
    if (!k || k.key_id !== req.keyId)
      throw conflict('sudo_key_changed', "the computer's key changed: reload the page and enter it again");
  }
  let targetId = req.targetId;
  let alias: string;
  const fresh = !req.targetId;
  if (!targetId) {
    const taken = (
      await rows(ctx.pool, `SELECT host FROM deploy_targets WHERE project_id=$1 AND removed_at IS NULL`, [
        projectId,
      ])
    ).map((r) => String(r.host ?? ''));
    alias =
      req.method === 'alias'
        ? (req.alias as string)
        : (req.alias ?? suggestAlias(req.newTarget?.name ?? 'server', taken));
    if (taken.includes(alias) && req.method !== 'alias')
      alias = suggestAlias(req.newTarget?.name ?? 'server', taken);
    targetId = await addDeployTarget(ctx, user, projectId, {
      name: (req.newTarget as NonNullable<ConnectRequest['newTarget']>).name,
      kind: 'remote_ssh',
      workstationId: ws.id,
      host: alias,
      notes: '',
      production: req.newTarget?.production ?? false,
    } as never);
  } else {
    const t = await serverTarget(ctx.pool, projectId, targetId);
    alias = String(t.host);
    // an existing sign-in (`alias`) may name another alias only for a new target; for an existing one the target's own host is used
    if (req.method === 'alias' && req.alias && req.alias !== alias)
      throw badRequest('alias_mismatch', 'that sign-in is not the one this server uses');
  }
  const payload: DeployConnectPayload = {
    projectId,
    targetId,
    ...(req.keyRef ? { keyRef: req.keyRef } : {}),
    method: req.method,
    alias,
    ...(req.address ? { address: req.address } : {}),
    ...(req.user ? { user: req.user } : {}),
    port: req.port,
    ...(req.hostKeyFingerprint ? { hostKeyFingerprint: req.hostKeyFingerprint } : {}),
    label: ws.name,
    ...(fresh ? { fresh: true } : {}),
    ...(req.keyId ? { keyId: req.keyId } : {}),
    ...(req.ciphertext ? { ciphertext: req.ciphertext } : {}),
  };
  // a sealed sign-in that was never picked up is dropped when a newer one replaces it
  await exec(
    ctx.pool,
    `UPDATE runner_commands SET status='failed', payload='{}'::jsonb, last_error='superseded'
      WHERE workstation_id=$1 AND type='deploy.connect' AND status IN ('pending','sent') AND payload->>'targetId' = $2`,
    [ws.id, targetId],
  );
  const commandId = await enqueueOp(
    ctx,
    ws.id,
    'deploy.connect',
    payload,
    new Date(ctx.clock.now().getTime() + CONNECT_TTL_MS),
  );
  void project;
  return { commandId, workstationId: ws.id, targetId, alias };
}

export async function requestRevoke(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  targetId: string,
  req: RevokeKeyRequest,
): Promise<OpStartedDto> {
  await projectOwnerOrThrow(ctx, user, projectId);
  const ws = await ownComputer(ctx, user, req.workstationId);
  const t = await serverTarget(ctx.pool, projectId, targetId);
  const key = await one(
    ctx.pool,
    `SELECT * FROM deploy_target_keys WHERE target_id=$1 AND fingerprint=$2 AND state='active'`,
    [targetId, req.fingerprint],
  );
  if (!key) throw notFound('that key is not on the list of keys Guildwise added');
  if (key.workstation_id === ws.id) throw unprocessable('own_key', revokeErrorText('own_key'));
  const mine = await one(
    ctx.pool,
    `SELECT 1 AS x FROM deploy_target_keys WHERE target_id=$1 AND workstation_id=$2 AND state='active'`,
    [targetId, ws.id],
  );
  if (!mine && t.workstation_id !== ws.id)
    throw unprocessable(
      'not_connected',
      'this computer has no sign-in to that server yet: reconnect it first',
    );
  const payload: DeployRevokePayload = {
    projectId,
    targetId,
    alias: String(t.host),
    publicKey: key.public_key,
    fingerprint: key.fingerprint,
  };
  return { commandId: await enqueueOp(ctx, ws.id, 'deploy.revoke', payload), workstationId: ws.id };
}

/**
 * "Remove this server": asks the computers of the person who removes it to take Guildwise's own key off the server and delete
 * their key material for it. Never blocks the removal: the answer says what was started and why anything was skipped.
 */
export async function revokeKeyOnRemoval(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  t: Row,
  opts: { forgetAnyway?: boolean } = {},
): Promise<{ state: 'none' | 'started' | 'skipped'; commandId: string | null; reason: string | null }> {
  const keys = await rows(
    ctx.pool,
    `SELECT k.*, w.user_id AS ws_user, w.name AS ws_name, w.connected AS ws_connected, c.capabilities
       FROM deploy_target_keys k JOIN workstations w ON w.id = k.workstation_id
       LEFT JOIN workstation_capabilities c ON c.workstation_id = w.id
      WHERE k.target_id=$1 AND k.state='active'`,
    [t.id],
  );
  if (keys.length === 0) return { state: 'none', commandId: null, reason: null };
  const mine = keys.filter((k) => k.ws_user === user.id);
  const others = keys.length - mine.length;
  const otherNote =
    others > 0
      ? ` ${others === 1 ? 'A key' : `${others} keys`} made by other people's computers stay${others === 1 ? 's' : ''} on the server: remove the line${others === 1 ? '' : 's'} starting with "guildwise-deploy:" from its authorized_keys.`
      : '';
  if (mine.length === 0)
    return {
      state: 'skipped',
      commandId: null,
      reason: `The key on that server was made by a computer that is not yours.${otherNote}`,
    };
  let first: string | null = null;
  const problems: string[] = [];
  for (const k of mine) {
    const caps = (k.capabilities ?? []) as string[];
    if (!k.ws_connected) {
      problems.push(`${k.ws_name} is offline, so its key was not taken off the server.`);
      continue;
    }
    if (!caps.includes(DEPLOY_CONNECT_CAPABILITY) || !caps.includes(DEPLOY_SETUP_V2_CAPABILITY)) {
      problems.push(`Guildwise on ${k.ws_name} needs an update to remove its key.`);
      continue;
    }
    const payload: DeployRevokePayload = {
      projectId,
      targetId: t.id,
      alias: String(t.host),
      publicKey: k.public_key,
      fingerprint: k.fingerprint,
      forget: true,
      ...(opts.forgetAnyway ? { forgetAnyway: true } : {}),
    };
    const id = await enqueueOp(ctx, k.workstation_id, 'deploy.revoke', payload);
    first ??= id;
  }
  if (first)
    return {
      state: 'started',
      commandId: first,
      reason: problems.length || otherNote ? `${problems.join(' ')}${otherNote}`.trim() : null,
    };
  return { state: 'skipped', commandId: null, reason: `${problems.join(' ')}${otherNote}`.trim() };
}

/** The latest look at a server (or at this computer) by this computer, or null. */
async function latestReport(
  db: Queryable,
  projectId: string,
  workstationId: string,
  hosting: 'ssh' | 'this_computer',
  targetId?: string,
): Promise<ProbeReport | null> {
  const r =
    hosting === 'ssh'
      ? await one(
          db,
          `SELECT report FROM deploy_probes WHERE project_id=$1 AND target_id=$2 AND scope='ssh_target' AND report IS NOT NULL
            ORDER BY at DESC LIMIT 1`,
          [projectId, targetId],
        )
      : await one(
          db,
          `SELECT report FROM deploy_probes WHERE project_id=$1 AND workstation_id=$2 AND scope='local' AND report IS NOT NULL
            ORDER BY at DESC LIMIT 1`,
          [projectId, workstationId],
        );
  return (r?.report as ProbeReport | undefined) ?? null;
}

/** The app folder the guided setup uses on a target (the folder of its environment's compose file), if there is one. */
async function setupFolderOf(
  db: Queryable,
  projectId: string,
  targetId: string,
): Promise<string | undefined> {
  const t = await one(db, 'SELECT name FROM deploy_targets WHERE id=$1 AND project_id=$2', [
    targetId,
    projectId,
  ]);
  const rec = await one(db, 'SELECT setup FROM delivery_recipes WHERE project_id=$1', [projectId]);
  const envs = ((
    rec?.setup as { environments?: Array<{ target?: string; app?: { composeFile?: string } }> } | null
  )?.environments ?? []) as Array<{ target?: string; app?: { composeFile?: string } }>;
  const f = envs.find((e) => e.target === t?.name)?.app?.composeFile;
  return f ? f.slice(0, f.lastIndexOf('/')) || '/' : undefined;
}

export async function requestPrepare(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: PrepareRequest,
): Promise<OpStartedDto> {
  await projectOwnerOrThrow(ctx, user, projectId);
  if (!req.confirmed) throw unprocessable('not_confirmed', 'the list of changes has to be confirmed');
  const ws = await ownComputer(ctx, user, req.workstationId);
  let alias: string | undefined;
  if (req.hosting === 'ssh') {
    if (!req.targetId) throw badRequest('target_required', 'name the server');
    const t = await serverTarget(ctx.pool, projectId, req.targetId);
    alias = String(t.host);
  }
  // the project's code, found on the computer by its address (the computer reads the file; the server never sees it)
  const repo = await one(
    ctx.pool,
    `SELECT name, remote_url_normalized FROM project_repos WHERE project_id=$1 AND removed_at IS NULL ORDER BY name LIMIT 1`,
    [projectId],
  );
  // The server decides what is done: from what the person chose (`inputs`) and the latest look at the server it computes the
  // list itself; a list sent by an older page is checked against the target's own folder.
  let chosen: PrepareAction[];
  let appDir: string | undefined;
  if (req.inputs) {
    const report = await latestReport(ctx.pool, projectId, ws.id, req.hosting, req.targetId);
    const plan = planPrepare(report, req.inputs as PrepareInputs);
    if (plan.blockers.length) throw unprocessable('prepare_blocked', plan.blockers[0] as string);
    if (!plan.actions.length)
      throw unprocessable('nothing_to_do', 'everything is already in place: there is nothing to set up');
    chosen = plan.actions;
    appDir = req.inputs.appDir;
  } else {
    chosen = req.actions ?? [];
    appDir = req.targetId ? await setupFolderOf(ctx.pool, projectId, req.targetId) : undefined;
  }
  const problems = prepareActionProblems(chosen, req.hosting, appDir);
  if (problems.length) throw unprocessable('unsafe_prepare', problems[0] as string);
  const actions: PrepareAction[] = chosen.map((a) =>
    a.kind === 'write_compose' && repo
      ? { ...a, repoName: a.repoName ?? repo.name, remote: repo.remote_url_normalized }
      : a,
  );
  const payload: DeployPreparePayload = {
    projectId,
    ...(req.targetId ? { targetId: req.targetId } : {}),
    hosting: req.hosting,
    ...(alias ? { alias } : {}),
    actions,
    dryRun: req.dryRun,
  };
  return { commandId: await enqueueOp(ctx, ws.id, 'deploy.prepare', payload), workstationId: ws.id };
}

// ------------------------------------------------------------------------------------------------ status

const KIND_OF: Record<string, OpKind> = {
  'deploy.hostkey': 'hostkey',
  'deploy.key': 'key',
  'deploy.connect': 'connect',
  'deploy.revoke': 'revoke',
  'deploy.prepare': 'prepare',
};

function opError(kind: OpKind, result: unknown, error: string | null): string | null {
  const r = (result ?? {}) as { error?: string; detail?: string };
  if (kind === 'connect' && r.error) return connectErrorText(r.error as never, r.detail);
  if (kind === 'revoke' && r.error) return revokeErrorText(r.error as never, r.detail);
  if (kind === 'hostkey' && r.error)
    return r.error === 'unreachable'
      ? `This computer cannot reach that address${r.detail ? ` (${r.detail})` : ''}. Check the address and that the server is on.`
      : r.error === 'timeout'
        ? 'The server did not answer in time.'
        : (r.detail ?? 'The server’s fingerprint could not be read.');
  if (kind === 'prepare' && r.error) return r.detail ?? 'The server could not be prepared.';
  return error;
}

/** The state of one operation the page started. Visible to the owner of the computer and the project owner. */
export async function getOp(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  commandId: string,
): Promise<OpStatusDto> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  const op = await one(
    ctx.pool,
    `SELECT o.*, w.user_id AS ws_user FROM deploy_ops o JOIN workstations w ON w.id=o.workstation_id WHERE o.command_id=$1 AND o.project_id=$2`,
    [commandId, projectId],
  );
  if (op) {
    if (op.ws_user !== user.id && p.my_role !== 'owner') throw notFound('operation not found');
    const kind = op.kind as OpKind;
    return {
      id: commandId,
      kind,
      state: op.ok ? 'done' : 'failed',
      ok: !!op.ok,
      result: op.result ?? null,
      errorText: op.ok ? null : opError(kind, op.result, op.error),
      at: iso(op.at) as string,
      ...(kind === 'revoke' && (op.result as { localKeyKept?: boolean } | null)?.localKeyKept
        ? { localKeyKept: true }
        : {}),
    };
  }
  const cmd = await one(
    ctx.pool,
    `SELECT c.type, c.status, c.last_error, c.expires_at, w.user_id AS ws_user
       FROM runner_commands c JOIN workstations w ON w.id=c.workstation_id WHERE c.id=$1`,
    [commandId],
  );
  if (!cmd || !KIND_OF[cmd.type]) throw notFound('operation not found');
  if (cmd.ws_user !== user.id && p.my_role !== 'owner') throw notFound('operation not found');
  const kind = KIND_OF[cmd.type] as OpKind;
  const dead = cmd.status === 'failed' || (cmd.expires_at && cmd.expires_at < ctx.clock.now());
  return {
    id: commandId,
    kind,
    state: dead ? 'expired' : 'pending',
    ok: null,
    result: null,
    errorText: dead ? 'The computer did not pick this up in time. Try again.' : null,
    at: null,
  };
}

// ------------------------------------------------------------------------------------------------ results

/**
 * `command.result` of the guided-connect commands. The sealed sign-in is forgotten first (whatever the answer was); only public
 * facts are recorded: a key's fingerprint and public line, the steps a preparation took.
 */
export async function applyConnectResult(
  ctx: Ctx,
  workstationId: string,
  cmd: { id: string; type: string; payload: Record<string, any> },
  ok: boolean,
  result: unknown,
  error?: string,
): Promise<void> {
  if (cmd.type === 'deploy.connect')
    await exec(ctx.pool, `UPDATE runner_commands SET payload='{}'::jsonb WHERE id=$1`, [cmd.id]);
  const kind = KIND_OF[cmd.type];
  const payload = cmd.payload;
  const projectId = typeof payload.projectId === 'string' ? payload.projectId : null;
  if (!kind || !projectId) return;
  const project = await one(ctx.pool, `SELECT id, org_id FROM projects WHERE id=$1 AND kind='project'`, [
    projectId,
  ]);
  const ws = await one(ctx.pool, 'SELECT user_id FROM workstations WHERE id=$1', [workstationId]);
  if (!project || !ws) return;
  const targetId = typeof payload.targetId === 'string' ? payload.targetId : null;
  const at = ctx.clock.now().toISOString();
  const scope = projectScope(project.org_id, projectId);
  const actor = runnerActor(workstationId);

  const schemas = {
    hostkey: HostKeyScanResultSchema,
    key: DeployKeyResultSchema,
    connect: DeployConnectResultSchema,
    revoke: DeployRevokeResultSchema,
    prepare: DeployPrepareResultSchema,
    check: DeployPrepareResultSchema,
  } as const;
  const parsed = ok ? schemas[kind].safeParse(result) : undefined;
  const res = (parsed?.success ? parsed.data : null) as Record<string, any> | null;
  const success = !!res && res.ok === true;
  const failure = res
    ? undefined
    : { ok: false, error: 'bad_request', detail: error ?? 'the computer could not run this' };
  const events: AppendInput[] = [
    {
      streamId: streamId.project(projectId),
      event: {
        type: 'DeployOpFinished',
        payload: {
          opId: cmd.id,
          projectId,
          targetId,
          workstationId,
          kind,
          ok: success,
          result: res ?? failure ?? null,
          error: success ? null : (error ?? null),
          at,
        },
      },
      actor,
      scope,
    },
  ];
  if (kind === 'connect' && res?.ok && targetId) {
    events.push(
      {
        streamId: streamId.project(projectId),
        event: {
          type: 'DeployTargetConnected',
          payload: {
            targetId,
            projectId,
            workstationId,
            method: payload.method,
            alias: payload.alias,
            fingerprint: res.fingerprint,
            publicKey: res.publicKey,
            address: payload.address ?? null,
            user: payload.user ?? null,
            port: payload.method === 'alias' ? null : (payload.port ?? 22),
            hostKeyFingerprint: res.hostKeyFingerprint ?? payload.hostKeyFingerprint ?? null,
            installed: res.installed,
            by: ws.user_id,
            at,
          },
        },
        actor,
        scope,
      },
      {
        streamId: streamId.project(projectId),
        event: {
          type: 'DeployTargetConnectionChecked',
          payload: {
            targetId,
            projectId,
            workstationId,
            state: 'reachable',
            method: 'deploy_key',
            host: String(payload.alias).slice(0, 64),
            detail: null,
            at,
          },
        },
        actor,
        scope,
      },
    );
  }
  // A target the server made for this connect and that did not connect is removed again: no half-made server stays on the list.
  // (The copy-paste flow keeps it: the person pastes the key and tests again.)
  if (kind === 'connect' && !success && payload.fresh === true && payload.method !== 'panel' && targetId) {
    const t = await one(ctx.pool, 'SELECT 1 AS x FROM deploy_targets WHERE id=$1 AND removed_at IS NULL', [
      targetId,
    ]);
    const k = await one(ctx.pool, 'SELECT 1 AS x FROM deploy_target_keys WHERE target_id=$1', [targetId]);
    if (t && !k)
      events.push({
        streamId: streamId.project(projectId),
        event: { type: 'DeployTargetRemoved', payload: { targetId } },
        actor,
        scope,
      });
  }
  if (kind === 'revoke' && res?.ok && targetId) {
    const key = await one(
      ctx.pool,
      'SELECT workstation_id FROM deploy_target_keys WHERE target_id=$1 AND fingerprint=$2',
      [targetId, payload.fingerprint],
    );
    if (key)
      events.push({
        streamId: streamId.project(projectId),
        event: {
          type: 'DeployKeyRevoked',
          payload: {
            targetId,
            projectId,
            workstationId: key.workstation_id,
            fingerprint: payload.fingerprint,
            byWorkstationId: workstationId,
            removed: res.removed,
            by: ws.user_id,
            at,
          },
        },
        actor,
        scope,
      });
  }
  if (kind === 'prepare')
    events.push({
      streamId: streamId.project(projectId),
      event: {
        type: 'DeployTargetPrepared',
        payload: {
          projectId,
          targetId,
          workstationId,
          hosting: payload.hosting,
          steps: ((res?.steps ?? []) as Array<{ kind: string; outcome: string; detail: string }>).map(
            (s) => ({
              kind: s.kind,
              outcome: s.outcome,
              detail: s.detail,
            }),
          ),
          ok: success,
          dryRun: !!payload.dryRun,
          by: ws.user_id,
          at,
        },
      },
      actor,
      scope,
    });
  await ctx.store.append(events);
}

// ------------------------------------------------------------------------------------------------ views

/** Keys of a project's targets (public parts), newest first. */
export async function listKeyDtos(db: Queryable, projectId: string): Promise<DeployKeyDto[]> {
  const list = await rows(
    db,
    `SELECT k.*, w.name AS workstation_name FROM deploy_target_keys k JOIN workstations w ON w.id = k.workstation_id
      WHERE k.project_id=$1 ORDER BY k.added_at DESC`,
    [projectId],
  );
  return list.map((k) => ({
    targetId: k.target_id,
    workstationId: k.workstation_id,
    workstationName: k.workstation_name,
    fingerprint: k.fingerprint,
    state: k.state,
    alias: k.alias,
    address: k.address ?? null,
    user: k.ssh_user ?? null,
    port: k.port ?? null,
    hostKeyFingerprint: k.host_key_fingerprint ?? null,
    addedAt: iso(k.added_at) as string,
    revokedAt: k.revoked_at ? (iso(k.revoked_at) as string) : null,
  }));
}

/** Adds the reachability chip and the keys to the target cards of a project. */
export async function decorateTargets(
  db: Queryable,
  projectId: string,
  dtos: DeployTargetDto[],
): Promise<DeployTargetDto[]> {
  const conns = await rows(db, 'SELECT * FROM deploy_target_connections WHERE project_id=$1', [projectId]);
  const keys = await listKeyDtos(db, projectId);
  return dtos.map((d) => {
    if (d.kind !== 'remote_ssh') return d;
    const c = conns
      .filter((x) => x.target_id === d.id && (!d.workstationId || x.workstation_id === d.workstationId))
      .sort((a, b) => +b.at - +a.at)[0];
    const reach: ReachabilityDto | null = c
      ? {
          state: c.state,
          at: iso(c.at) as string,
          detail: c.detail ?? null,
          method: c.method,
          workstationId: c.workstation_id,
        }
      : null;
    return { ...d, reachability: reach, keys: keys.filter((k) => k.targetId === d.id) };
  });
}

void randomUUID;
void withAppendTx;
void userActor;

/**
 * "Forget it anyway": a removal could not take the key off the server and this computer kept its key. After the person
 * confirmed, the same request is sent again and this time the computer deletes its key material whatever the server says.
 */
export async function forgetKeyAnyway(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  commandId: string,
): Promise<OpStartedDto> {
  await projectOwnerOrThrow(ctx, user, projectId);
  const op = await one(
    ctx.pool,
    `SELECT o.workstation_id, o.result, c.payload, w.user_id AS ws_user FROM deploy_ops o
       JOIN runner_commands c ON c.id = o.command_id JOIN workstations w ON w.id = o.workstation_id
      WHERE o.command_id=$1 AND o.project_id=$2 AND o.kind='revoke'`,
    [commandId, projectId],
  );
  const kept = (op?.result as { localKeyKept?: boolean } | null)?.localKeyKept;
  if (!op || !kept) throw notFound('there is nothing to forget for that operation');
  if (op.ws_user !== user.id) throw forbidden('only the person whose computer holds the key can forget it');
  const payload = DeployRevokePayloadSchema.safeParse({ ...(op.payload as object), forgetAnyway: true });
  if (!payload.success) throw unprocessable('bad_request', 'that request can no longer be repeated');
  return {
    commandId: await enqueueOp(ctx, op.workstation_id, 'deploy.revoke', payload.data),
    workstationId: op.workstation_id,
  };
}
