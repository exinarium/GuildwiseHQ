import { createHash } from 'node:crypto';
import {
  ARTEFACT_CHANGED,
  ARTEFACT_KEPT_FOR_ROLLBACK,
  ARTEFACT_NOT_PREPARED,
  type DeployTargetSigning,
  parseMinisignPublicKey,
  type Recipe,
  type ReleaseArtefactPreparedPayloadSchema,
  type ReleasePreparePayload,
  type ReleaseSignatureUploadRequest,
  type ReleaseSigningState,
  type ReleaseSigningStatus,
  type ReleaseSigningTarget,
  type ReleaseSignPayload,
  ReleaseSignResultSchema,
  type SetDeployTargetSigningRequest,
  SIGNATURE_INVALID,
  SIGNATURE_WRONG_KEY,
  streamId,
  targetArtefactPath,
} from '@aom/shared';
import type { z } from 'zod';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { projectScope, runnerActor, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { loadRecipeRow, projectVault } from '../delivery/recipes.ts';
import { deployWorkstation } from '../delivery/runs.ts';
import {
  currentArtefact,
  keptForRollback,
  releaseForCommit,
  type ShippedRelease,
  signatureFor,
  targetSigning,
} from '../delivery/signing-gate.ts';
import { conflict, forbidden, HttpError, notFound, unprocessable } from '../errors.ts';
import { completeCommand, enqueueRunnerCommand, failCommandFinal } from '../runner-gateway/commands-queue.ts';
import { minisigKeyId, publicKeyLine, verifyMinisign } from './minisign.ts';

/**
 * Release signing per deploy target (R30), server side. The server never signs and never sees a secret key: it asks the
 * deploying workstation to package the runner with the target's public key (`release.prepare`), records the artefact it
 * reports, asks that workstation to sign it under a local approval (`release.sign`, route 1) or takes an offline signature
 * (route 2), and verifies every signature against the target's public key and the artefact's bytes before storing it.
 */

/** Held `release.sign` items expire after 24 h on the runner; the command expires with them. */
const SIGN_TTL_MS = 24 * 60 * 60_000;
/** Packaging takes minutes; an unanswered `release.prepare` (workstation gone, a runner without it) expires after this. */
export const PREPARE_TTL_MS = 30 * 60_000;
const EXPIRED = 'expired: the workstation did not answer in time';
const KEY_CHANGED = "the target's signing key changed: package and sign again";

const sha256 = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

async function liveTargetRow(db: Queryable, targetId: string): Promise<Row> {
  const t = await one(db, 'SELECT * FROM deploy_targets WHERE id=$1 AND removed_at IS NULL', [targetId]);
  if (!t) throw notFound('deploy target not found');
  return t;
}

/** The Owner or an Admin of the project's organization: the people who deploy (as the deploy route). */
async function requireDeployer(ctx: Ctx, user: AuthSession['user'], projectId: string): Promise<Row> {
  const project = await loadVisibleProject(ctx.pool, user.id, projectId);
  const role = await orgRoleOf(ctx.pool, user.id, project.org_id);
  if (role !== 'owner' && role !== 'admin')
    throw forbidden('only an Owner or an Admin signs a release for a deploy');
  return project;
}

async function projectTarget(db: Queryable, projectId: string, targetId: string): Promise<Row> {
  const t = await liveTargetRow(db, targetId);
  if (t.project_id !== projectId) throw notFound('deploy target not found');
  return t;
}

function requireSigning(t: Row): DeployTargetSigning {
  const s = targetSigning(t);
  if (!s) throw conflict('signing_not_configured', `${t.name} has no runner signing key`);
  return s;
}

// ---------------------------------------------------------------- the target's key (project Owner, step-up)

/** `DeployTargetSigningSet`: the key a target trusts. The route checks the step-up; this checks the project Owner. */
export async function setTargetSigning(
  ctx: Ctx,
  user: AuthSession['user'],
  targetId: string,
  req: SetDeployTargetSigningRequest,
): Promise<DeployTargetSigning | null> {
  return withAppendTx(ctx.pool, async (tx) => {
    const t = await liveTargetRow(tx, targetId);
    const p = await loadVisibleProject(tx, user.id, t.project_id);
    if (p.my_role !== 'owner') throw forbidden("only the project owner sets a target's runner signing key");
    let signing: DeployTargetSigning | null = null;
    if (req.signing) {
      const line = publicKeyLine(req.signing.publicKey);
      const pk = parseMinisignPublicKey(line);
      if (!pk)
        throw unprocessable(
          'bad_public_key',
          'that is not a minisign public key (the line starting RW of the .pub file; never the secret key)',
        );
      if (req.signing.keyId && req.signing.keyId !== pk.keyId)
        throw unprocessable(
          'key_id_mismatch',
          `the public key has key id ${pk.keyId}, not ${req.signing.keyId}`,
        );
      signing = {
        required: req.signing.required,
        keyId: pk.keyId,
        publicKey: line,
        artefact: req.signing.artefact ?? 'release/manifest.json',
      };
    }
    const before = targetSigning(t);
    if (before?.publicKey !== signing?.publicKey)
      // a prepare or sign in flight was asked for under the old key: it can no longer count
      await exec(
        tx,
        `UPDATE runner_commands SET status='failed', last_error=$2, done_at=$3
          WHERE type IN ('release.prepare','release.sign') AND payload->>'targetId'=$1 AND status IN ('pending','sent')`,
        [targetId, KEY_CHANGED, ctx.clock.now()],
      );
    await ctx.store.append(
      [
        {
          streamId: streamId.project(t.project_id),
          event: { type: 'DeployTargetSigningSet', payload: { targetId, signing, by: user.id } },
          actor: userActor(user.id),
          scope: projectScope(t.org_id, t.project_id),
        },
      ],
      { tx },
    );
    return signing;
  });
}

// ---------------------------------------------------------------- status per environment

async function envTargetRows(db: Queryable, projectId: string, env: string): Promise<Row[]> {
  const r = await loadRecipeRow(db, projectId);
  const recipe = (r?.approved_parsed ?? r?.parsed ?? null) as Recipe | null;
  const names = recipe?.environments.find((e) => e.name === env)?.targets ?? [];
  if (names.length === 0) return [];
  const list = await rows(
    db,
    `SELECT * FROM deploy_targets WHERE project_id=$1 AND removed_at IS NULL AND lower(name) = ANY($2::text[])`,
    [projectId, names.map((n) => n.toLowerCase())],
  );
  return names
    .map((n) => list.find((t) => t.name.toLowerCase() === n.toLowerCase()))
    .filter((t): t is Row => !!t);
}

async function latestCommand(
  db: Queryable,
  type: 'release.prepare' | 'release.sign',
  releaseId: string,
  targetId: string,
  artefactSha256?: string,
): Promise<Row | undefined> {
  return one(
    db,
    `SELECT id, status, last_error, done_at, expires_at, workstation_id FROM runner_commands
      WHERE type=$1 AND payload->>'releaseId'=$2 AND payload->>'targetId'=$3
        AND ($4::text IS NULL OR payload->>'artefactSha256'=$4)
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [type, releaseId, targetId, artefactSha256 ?? null],
  );
}

const waiting = (c: Row | undefined) => !!c && (c.status === 'pending' || c.status === 'sent');
/** Queued or delivered and not past its expiry: the workstation may still answer. */
const open = (c: Row | undefined, now: Date) =>
  waiting(c) && (!c?.expires_at || new Date(c.expires_at).getTime() > now.getTime());
/** Queued or delivered but past its expiry: it reads as failed, and the next action replaces it. */
const expired = (c: Row | undefined, now: Date) => waiting(c) && !open(c, now);
/** A command that failed, or expired unanswered: its reason, else null. */
const failure = (c: Row | undefined, now: Date): string | null =>
  c?.status === 'failed' ? (c.last_error ?? 'failed') : expired(c, now) ? EXPIRED : null;

async function targetState(
  db: Queryable,
  t: Row,
  release: ShippedRelease | null,
  now: Date,
): Promise<ReleaseSigningTarget> {
  const signing = targetSigning(t);
  const base: ReleaseSigningTarget = {
    targetId: t.id,
    targetName: t.name,
    signing,
    state: 'not_required',
    artefact: signing ? targetArtefactPath(signing.artefact, t.name) : null,
    artefactSha256: null,
    preparedAt: null,
    signature: null,
    error: null,
  };
  if (!signing?.required) return base;
  if (!release) return { ...base, state: 'no_release' };
  const a = await currentArtefact(db, release.id, t.id);
  const prep = await latestCommand(db, 'release.prepare', release.id, t.id);
  const preparedAt = a ? (iso(a.prepared_at) as string) : null;
  if (open(prep, now))
    return { ...base, state: 'preparing', artefactSha256: a?.artefact_sha256 ?? null, preparedAt };
  const prepFailed = failure(prep, now);
  if (!a) {
    if (prepFailed) return { ...base, state: 'prepare_failed', error: prepFailed };
    return { ...base, state: 'not_prepared' };
  }
  const withArtefact = { ...base, artefactSha256: a.artefact_sha256 as string, preparedAt };
  // a failure counts only when it is newer than the artefact (an expired one is newer by definition: it never answered)
  if (
    prepFailed &&
    (expired(prep, now) || (prep?.done_at && new Date(prep.done_at) > new Date(a.prepared_at)))
  )
    return { ...withArtefact, state: 'prepare_failed', error: prepFailed };
  const sig = await signatureFor(db, release.id, t.id, signing.keyId, a.artefact_sha256);
  if (sig)
    return {
      ...withArtefact,
      state: 'signed',
      signature: { keyId: sig.key_id, source: sig.source, at: iso(sig.at) as string },
    };
  const sign = await latestCommand(db, 'release.sign', release.id, t.id, a.artefact_sha256);
  if (open(sign, now)) return { ...withArtefact, state: 'signing' };
  const signFailed = failure(sign, now);
  if (signFailed) return { ...withArtefact, state: 'sign_failed', error: signFailed };
  return { ...withArtefact, state: 'waiting_signature' };
}

/** Where each target of an environment stands for the release of `commit` (the release sheet). */
export async function releaseSigningStatus(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  env: string,
  commit: string | null,
): Promise<ReleaseSigningStatus> {
  await loadVisibleProject(ctx.pool, user.id, projectId);
  const release = await releaseForCommit(ctx.pool, projectId, commit);
  const targets: ReleaseSigningTarget[] = [];
  for (const t of await envTargetRows(ctx.pool, projectId, env))
    targets.push(await targetState(ctx.pool, t, release, ctx.clock.now()));
  return {
    env,
    commit: commit || null,
    release: release ? { releaseId: release.id, version: release.version, tag: release.tag } : null,
    targets,
  };
}

/** Status of one state, for the answers of the write routes. */
async function stateOf(
  db: Queryable,
  t: Row,
  release: ShippedRelease,
  now: Date,
): Promise<ReleaseSigningState> {
  return (await targetState(db, t, release, now)).state;
}

/** An expired, unanswered command is closed as failed before a new one replaces it. */
async function closeIfExpired(ctx: Ctx, c: Row | undefined): Promise<void> {
  if (c && expired(c, ctx.clock.now())) await failCommandFinal(ctx.pool, c.id, EXPIRED, ctx.clock.now());
}

// ---------------------------------------------------------------- packaging (release.prepare)

/** Queues `release.prepare` on the workstation that deploys the target, for the shipped release of `commit`. */
export async function prepareReleaseArtefact(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: { targetId: string; commit: string; repackage?: true | undefined },
): Promise<{ commandId: string; releaseId: string; state: ReleaseSigningState }> {
  const project = await requireDeployer(ctx, user, projectId);
  const t = await projectTarget(ctx.pool, projectId, req.targetId);
  const s = requireSigning(t);
  const release = await releaseForCommit(ctx.pool, projectId, req.commit);
  if (!release)
    throw conflict(
      'not_a_release',
      `commit ${req.commit.slice(0, 10)} is not a shipped release: only a release is signed`,
    );
  // The releases kept for rollback (the current and the previous good deploy) stay signed (owner 2026-11-21): packaging one
  // again replaces the artefact its signature covers. Only on purpose (`repackage`, the workstation lost the files), and
  // then it needs a new signature.
  let repackage = false;
  if ((await keptForRollback(ctx.pool, projectId, t.id)).some((k) => k.id === release.id)) {
    const a = await currentArtefact(ctx.pool, release.id, t.id);
    if (a && (await signatureFor(ctx.pool, release.id, t.id, s.keyId, a.artefact_sha256))) {
      if (req.repackage !== true)
        throw conflict(
          ARTEFACT_KEPT_FOR_ROLLBACK,
          `the runner of ${release.version} is kept signed for a rollback of ${t.name}, so it is not packaged again. Only if the workstation that deploys ${t.name} lost its files, package it again on purpose (repackage); it then needs a new signature before it deploys`,
        );
      repackage = true;
    }
  }
  const pending = await latestCommand(ctx.pool, 'release.prepare', release.id, t.id);
  if (open(pending, ctx.clock.now()))
    return { commandId: pending?.id as string, releaseId: release.id, state: 'preparing' };
  await closeIfExpired(ctx, pending);
  const vault = await projectVault(ctx.pool, projectId);
  if (!vault) throw conflict('no_vault', 'the project has no vault, so no workstation can deploy it');
  const ws = await deployWorkstation(ctx.pool, project, vault, t);
  if ('error' in ws) throw conflict(ws.reason ?? 'no_workstation', ws.error);
  const repo = await one<{ remote_url_normalized: string | null }>(
    ctx.pool,
    'SELECT remote_url_normalized FROM project_repos WHERE id=$1',
    [release.repoId],
  );
  const payload: ReleasePreparePayload = {
    releaseId: release.id,
    targetId: t.id,
    targetName: t.name,
    projectName: String(project.name ?? project.key).slice(0, 120),
    version: release.version,
    repoId: release.repoId,
    ...(repo?.remote_url_normalized ? { remoteUrlNormalized: repo.remote_url_normalized } : {}),
    commit: release.commit,
    keyId: s.keyId,
    publicKey: s.publicKey,
    artefact: targetArtefactPath(s.artefact, t.name),
    ...(repackage ? { repackage: true as const } : {}),
  };
  const commandId = await enqueueRunnerCommand(
    ctx.pool,
    ws.id,
    'release.prepare',
    payload,
    new Date(ctx.clock.now().getTime() + PREPARE_TTL_MS),
  );
  void Promise.resolve(ctx.services.gateway.deliverPending(ws.id)).catch(() => undefined);
  return { commandId, releaseId: release.id, state: 'preparing' };
}

type PreparedMsg = z.infer<typeof ReleaseArtefactPreparedPayloadSchema>;

/**
 * Runner -> server `release.artefact.prepared` (in the inbox transaction): recorded only for a `release.prepare` this
 * workstation was sent for that release and target, with the manifest whose sha256 it claims. Returns why not, or null.
 */
export async function applyArtefactPrepared(
  ctx: Ctx,
  tx: Tx,
  workstationId: string,
  msg: PreparedMsg,
): Promise<string | null> {
  const cmd = await one(
    tx,
    `SELECT id, status, payload FROM runner_commands WHERE workstation_id=$1 AND type='release.prepare'
        AND payload->>'releaseId'=$2 AND payload->>'targetId'=$3
      ORDER BY created_at DESC LIMIT 1`,
    [workstationId, msg.releaseId, msg.targetId],
  );
  if (!cmd) return 'no release.prepare was sent to this workstation for that release and target';
  if (!waiting(cmd)) return `that release.prepare is ${cmd.status} already`;
  const t = await one(tx, 'SELECT org_id, project_id, signing FROM deploy_targets WHERE id=$1', [
    msg.targetId,
  ]);
  const s = targetSigning(t);
  const refusal = !t
    ? 'the deploy target is gone'
    : !s || s.publicKey !== cmd.payload.publicKey || s.keyId !== cmd.payload.keyId
      ? KEY_CHANGED
      : !msg.manifest
        ? 'the report carries no manifest: the runner must send the artefact text'
        : sha256(msg.manifest) !== msg.artefactSha256
          ? 'the manifest does not hash to the reported sha256'
          : cmd.payload.version !== msg.version
            ? `the artefact is for ${msg.version}, not ${cmd.payload.version}`
            : null;
  if (refusal || !t || !msg.manifest) {
    // the prepare ends with the reason, so the sheet shows it instead of falling back to "not prepared"
    const why = refusal ?? 'refused';
    await failCommandFinal(tx, cmd.id, why, ctx.clock.now());
    return why;
  }
  await ctx.store.append(
    [
      {
        streamId: streamId.release(msg.releaseId),
        event: {
          type: 'ReleaseArtefactPrepared',
          payload: {
            releaseId: msg.releaseId,
            targetId: msg.targetId,
            artefactSha256: msg.artefactSha256,
            version: msg.version,
            manifest: msg.manifest,
            ...(cmd.payload.repackage === true ? { repackaged: true as const } : {}),
          },
        },
        actor: runnerActor(workstationId),
        scope: projectScope(t.org_id, t.project_id),
      },
    ],
    { tx },
  );
  // The report is the prepare's answer: the command is done (its later `command.result` is then a no-op).
  if (cmd.status === 'pending' || cmd.status === 'sent')
    await completeCommand(tx, cmd.id, true, undefined, ctx.clock.now());
  return null;
}

/** `command.result` of `release.prepare`: the report came as its own message; a failure is final (the owner retries). */
export async function applyReleasePrepareResult(
  ctx: Ctx,
  commandId: string,
  ok: boolean,
  error: string | undefined,
): Promise<void> {
  if (ok) return completeCommand(ctx.pool, commandId, true, undefined, ctx.clock.now());
  await failCommandFinal(
    ctx.pool,
    commandId,
    error || 'packaging failed on the workstation',
    ctx.clock.now(),
  );
}

// ---------------------------------------------------------------- route 1: the workstation holding the key

/** Queues `release.sign` on the workstation that packaged the artefact (the file to sign is there); held for a local yes. */
export async function requestWorkstationSignature(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: { releaseId: string; targetId: string },
): Promise<{ commandId: string; state: ReleaseSigningState }> {
  const project = await requireDeployer(ctx, user, projectId);
  const t = await projectTarget(ctx.pool, projectId, req.targetId);
  const s = requireSigning(t);
  const release = await one(ctx.pool, 'SELECT * FROM release_ships WHERE id=$1 AND project_id=$2', [
    req.releaseId,
    projectId,
  ]);
  if (!release) throw notFound('release not found');
  const a = await currentArtefact(ctx.pool, req.releaseId, t.id);
  if (!a)
    throw conflict(
      ARTEFACT_NOT_PREPARED,
      `the runner of ${release.version} is not packaged for ${t.name} yet`,
    );
  if (await signatureFor(ctx.pool, req.releaseId, t.id, s.keyId, a.artefact_sha256))
    throw conflict('already_signed', `the runner of ${release.version} for ${t.name} is signed already`);
  const pending = await latestCommand(ctx.pool, 'release.sign', req.releaseId, t.id, a.artefact_sha256);
  if (open(pending, ctx.clock.now())) return { commandId: pending?.id as string, state: 'signing' };
  await closeIfExpired(ctx, pending);
  if (!a.workstation_id)
    throw conflict('no_workstation', 'the workstation that packaged the runner is not known');
  const ws = await one(ctx.pool, `SELECT id FROM workstations WHERE id=$1 AND status='active'`, [
    a.workstation_id,
  ]);
  if (!ws)
    throw conflict('no_workstation', 'the workstation that packaged the runner is gone: package it again');
  const payload: ReleaseSignPayload = {
    releaseId: req.releaseId,
    targetId: t.id,
    targetName: t.name,
    projectName: String(project.name ?? project.key).slice(0, 120),
    version: a.version,
    keyId: s.keyId,
    artefact: targetArtefactPath(s.artefact, t.name),
    repoId: release.repo_id,
    artefactSha256: a.artefact_sha256,
  };
  const commandId = await enqueueRunnerCommand(
    ctx.pool,
    ws.id,
    'release.sign',
    payload,
    new Date(ctx.clock.now().getTime() + SIGN_TTL_MS),
  );
  void Promise.resolve(ctx.services.gateway.deliverPending(ws.id)).catch(() => undefined);
  return { commandId, state: 'signing' };
}

type Verdict = { ok: true } | { ok: false; code: string; message: string };

/** The one check every signature passes before it is stored: the target's key, over exactly the packaged artefact. */
function checkSignature(s: DeployTargetSigning, a: Row, minisig: string): Verdict {
  if (!a.manifest)
    return { ok: false, code: ARTEFACT_NOT_PREPARED, message: 'the packaged artefact text is missing' };
  const v = verifyMinisign(s.publicKey, Buffer.from(a.manifest, 'utf8'), minisig);
  if (v.ok) return { ok: true };
  if (v.reason === 'wrong_key')
    return {
      ok: false,
      code: SIGNATURE_WRONG_KEY,
      message: `the signature is by key ${v.keyId ?? minisigKeyId(minisig) ?? '?'}, but this target trusts only ${s.keyId}`,
    };
  return {
    ok: false,
    code: SIGNATURE_INVALID,
    message:
      v.reason === 'malformed'
        ? 'that is not a minisign signature file (.minisig)'
        : `the signature does not verify over manifest.json sha256 ${String(a.artefact_sha256).slice(0, 12)}…: it was made over another file`,
  };
}

async function appendSigned(
  ctx: Ctx,
  tx: Tx,
  t: Row,
  a: Row,
  s: DeployTargetSigning,
  minisig: string,
  source: 'workstation' | 'upload',
  actor: ReturnType<typeof userActor> | ReturnType<typeof runnerActor>,
): Promise<void> {
  await ctx.store.append(
    [
      {
        streamId: streamId.release(a.release_id),
        event: {
          type: 'ReleaseArtefactSigned',
          payload: {
            releaseId: a.release_id,
            targetId: t.id,
            keyId: s.keyId,
            artefactSha256: a.artefact_sha256,
            minisig: minisig.replace(/\r\n/g, '\n'),
            source,
          },
        },
        actor,
        scope: projectScope(t.org_id, t.project_id),
      },
    ],
    { tx },
  );
}

/** `command.result` of `release.sign`: the signature is verified like an upload, or the command fails with the reason. */
export async function applyReleaseSignResult(
  ctx: Ctx,
  workstationId: string,
  commandId: string,
  payload: ReleaseSignPayload,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const now = ctx.clock.now();
  if (!ok) return failCommandFinal(ctx.pool, commandId, error || 'not signed on the workstation', now);
  const r = ReleaseSignResultSchema.safeParse(result);
  if (!r.success)
    return failCommandFinal(ctx.pool, commandId, 'the workstation answered without a signature', now);
  const fail = await withAppendTx(ctx.pool, async (tx) => {
    const t = await one(tx, 'SELECT * FROM deploy_targets WHERE id=$1 AND removed_at IS NULL', [
      payload.targetId,
    ]);
    const s = targetSigning(t);
    if (!t || !s) return 'the target no longer has a signing key';
    const a = await currentArtefact(tx, payload.releaseId, payload.targetId);
    if (!a || a.artefact_sha256 !== payload.artefactSha256 || r.data.artefactSha256 !== a.artefact_sha256)
      return 'the runner was packaged again since: sign the new artefact';
    if (r.data.keyId !== s.keyId)
      return `signed with key ${r.data.keyId}, but ${t.name} trusts only ${s.keyId}`;
    const v = checkSignature(s, a, r.data.minisig);
    if (!v.ok) return v.message;
    await appendSigned(ctx, tx, t, a, s, r.data.minisig, 'workstation', runnerActor(workstationId));
    return null;
  });
  if (fail) {
    ctx.log.warn({ commandId, workstationId }, `release.sign result refused: ${fail}`);
    return failCommandFinal(ctx.pool, commandId, fail, now);
  }
  await completeCommand(ctx.pool, commandId, true, undefined, now);
}

// ---------------------------------------------------------------- route 2: an offline signature

/** The packaged `manifest.json` (public data), for signing offline. */
export async function releaseManifest(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  releaseId: string,
  targetId: string,
): Promise<{ manifest: string; sha256: string }> {
  await loadVisibleProject(ctx.pool, user.id, projectId);
  await projectTarget(ctx.pool, projectId, targetId);
  const a = await currentArtefact(ctx.pool, releaseId, targetId);
  if (!a?.manifest) throw notFound('nothing was packaged for this release and target', ARTEFACT_NOT_PREPARED);
  return { manifest: a.manifest, sha256: a.artefact_sha256 };
}

/** Stores an uploaded `.minisig` once it verifies against the target's public key and the packaged artefact. */
export async function uploadReleaseSignature(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: ReleaseSignatureUploadRequest,
): Promise<{ state: ReleaseSigningState; keyId: string }> {
  await requireDeployer(ctx, user, projectId);
  return withAppendTx(ctx.pool, async (tx) => {
    const t = await projectTarget(tx, projectId, req.targetId);
    const s = requireSigning(t);
    const release = await one(tx, 'SELECT * FROM release_ships WHERE id=$1 AND project_id=$2', [
      req.releaseId,
      projectId,
    ]);
    if (!release) throw notFound('release not found');
    const a = await currentArtefact(tx, req.releaseId, t.id);
    if (!a)
      throw conflict(
        ARTEFACT_NOT_PREPARED,
        `the runner of ${release.version} is not packaged for ${t.name} yet`,
      );
    if (req.artefactSha256 && req.artefactSha256 !== a.artefact_sha256)
      throw conflict(
        ARTEFACT_CHANGED,
        `the runner for ${t.name} was packaged again since that manifest was downloaded (now sha256 ${String(a.artefact_sha256).slice(0, 12)}…): download it again and sign that`,
      );
    const v = checkSignature(s, a, req.minisig);
    if (!v.ok) throw new HttpError(422, v.code, v.message);
    if (!(await signatureFor(tx, req.releaseId, t.id, s.keyId, a.artefact_sha256)))
      await appendSigned(ctx, tx, t, a, s, req.minisig, 'upload', userActor(user.id));
    return {
      state: await stateOf(
        tx,
        t,
        {
          id: release.id,
          version: release.version,
          tag: release.tag,
          repoId: release.repo_id,
          commit: release.commit_sha,
        },
        ctx.clock.now(),
      ),
      keyId: s.keyId,
    };
  });
}
