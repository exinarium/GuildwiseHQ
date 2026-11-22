import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import {
  type AddPasskeyRequest,
  type ApprovalItemDto,
  PASSKEY_ALGS,
  PASSKEY_APPROVABLE_KINDS,
  type PasskeyApprovalRequest,
  type PasskeyApprovalResponse,
  type PasskeyRegistrationOptionsResponse,
  type PasskeyRelayDto,
  streamId,
  type WorkstationApprovalsResponse,
  type WorkstationPasskeyDto,
  type WorkstationPasskeysResponse,
} from '@aom/shared';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import { cose, decodeClientDataJSON, decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';
import { signValue, verifySigned } from '../auth/secrets.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { completeCommand, enqueueRunnerCommand, failCommandFinal } from '../runner-gateway/commands-queue.ts';
import { heldItemsOf } from '../runner-gateway/held-items.ts';
import { userActor, userScope } from './common.ts';

/*
 * Passkey approvals (R22, DESIGN R18-S2). The rule: local approval on the workstation is the authority. The server
 * verifies a WebAuthn registration, offers the passkey to the runner (which trusts it only after a local
 * `guildwise-runner passkey trust`), lists what the runner holds, and relays an assertion for a held item of one of the
 * two passkey kinds. It never marks anything approved: only the runner's own check releases an item.
 */

/** A registration must be finished within this long after its options were issued. */
export const REGISTRATION_TTL_MS = 5 * 60_000;
/** The runner keeps at most 20 trusted passkeys (`policy.json`); the server offers no more than that per workstation. */
export const MAX_PASSKEYS_PER_WORKSTATION = 20;
/** How far back the approvals page shows relayed assertions and their answers. */
const RELAY_HISTORY_MS = 15 * 60_000;
const PASSKEY_COMMANDS = new Set(['passkey.offer', 'passkey.withdraw', 'approval.passkey']);
const TOKEN_PURPOSE = 'passkey-registration';

/** The relying party: the server host and the one public origin (a passkey made on another origin is refused). */
export function passkeyRp(ctx: Ctx): { rpId: string; origin: string } {
  const origin = new URL(ctx.config.publicOrigin).origin;
  return { rpId: new URL(origin).hostname, origin };
}

export const isPasskeyKind = (kind: string): boolean =>
  (PASSKEY_APPROVABLE_KINDS as readonly string[]).includes(kind);

async function ownWorkstation(db: Queryable, userId: string, id: string): Promise<{ name: string }> {
  const w = await one<{ name: string; user_id: string }>(
    db,
    `SELECT name, user_id FROM workstations WHERE id=$1 AND status='active'`,
    [id],
  );
  if (!w || w.user_id !== userId) throw notFound('workstation not found');
  return w;
}

export async function listPasskeys(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
): Promise<WorkstationPasskeysResponse> {
  await ownWorkstation(ctx.pool, user.id, workstationId);
  const list = await rows<{ id: string; name: string; credential_id: string; alg: number; created_at: Date }>(
    ctx.pool,
    `SELECT id, name, credential_id, alg, created_at FROM workstation_passkeys
      WHERE workstation_id=$1 AND removed_at IS NULL ORDER BY created_at, id`,
    [workstationId],
  );
  return {
    passkeys: list.map(
      (p): WorkstationPasskeyDto => ({
        id: p.id,
        name: p.name,
        credentialId: p.credential_id,
        alg: p.alg as WorkstationPasskeyDto['alg'],
        createdAt: p.created_at.toISOString(),
      }),
    ),
    ...passkeyRp(ctx),
  };
}

/** The WebAuthn user handle of one user's passkeys for one workstation: sha256(userId|workstationId). */
export const passkeyUserHandle = (userId: string, workstationId: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(createHash('sha256').update(`${userId}|${workstationId}`).digest());

/** WebAuthn `create` options (user verification required, attestation `none`) and the token binding their challenge. */
export async function registrationOptions(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
): Promise<PasskeyRegistrationOptionsResponse> {
  const ws = await ownWorkstation(ctx.pool, user.id, workstationId);
  const { rpId } = passkeyRp(ctx);
  const existing = await rows<{ credential_id: string }>(
    ctx.pool,
    `SELECT credential_id FROM workstation_passkeys WHERE workstation_id=$1 AND removed_at IS NULL`,
    [workstationId],
  );
  if (existing.length >= MAX_PASSKEYS_PER_WORKSTATION)
    throw conflict('passkey_limit', `A workstation keeps at most ${MAX_PASSKEYS_PER_WORKSTATION} passkeys.`);
  const options = await generateRegistrationOptions({
    rpName: 'Guildwise',
    rpID: rpId,
    userName: user.email,
    userDisplayName: `${user.displayName} (${ws.name})`,
    // One user handle per workstation: an authenticator replaces a discoverable credential with the same RP id and user
    // handle, so a shared handle would make a passkey for one workstation silently overwrite another's trusted one.
    userID: passkeyUserHandle(user.id, workstationId),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    excludeCredentials: existing.map((c) => ({ id: c.credential_id })),
    supportedAlgorithmIDs: [...PASSKEY_ALGS],
    timeout: 120_000,
  });
  const exp = Math.floor((ctx.clock.now().getTime() + REGISTRATION_TTL_MS) / 1000);
  const registrationToken = await signValue(
    ctx,
    TOKEN_PURPOSE,
    `${user.id}|${workstationId}|${options.challenge}|${exp}`,
  );
  return { options: options as unknown as Record<string, unknown>, registrationToken };
}

/** The challenge a registration token was issued for, if the token is ours, for this user and workstation, and fresh. */
async function challengeOf(ctx: Ctx, token: string, userId: string, workstationId: string): Promise<string> {
  const value = await verifySigned(ctx, TOKEN_PURPOSE, token);
  const [uid, wid, challenge, exp] = value?.split('|') ?? [];
  if (!value || uid !== userId || wid !== workstationId || !challenge || !exp)
    throw badRequest('passkey_invalid', 'This passkey registration is not valid. Start again.');
  if (Number(exp) * 1000 < ctx.clock.now().getTime())
    throw badRequest('passkey_expired', 'This passkey registration took too long. Start again.');
  return challenge;
}

/** COSE public key (from the authenticator) to SPKI DER, base64: the form the runner verifies with `node:crypto`. */
export function coseToSpki(coseKey: Uint8Array): { alg: (typeof PASSKEY_ALGS)[number]; spki: string } {
  const key = decodeCredentialPublicKey(new Uint8Array(coseKey));
  const alg = key.get(cose.COSEKEYS.alg);
  const b64 = (b: Uint8Array | undefined) => {
    if (!b) throw badRequest('passkey_invalid', 'The passkey public key is incomplete.');
    return Buffer.from(b).toString('base64url');
  };
  let jwk: Record<string, string>;
  if (
    alg === cose.COSEALG.ES256 &&
    cose.isCOSEPublicKeyEC2(key) &&
    key.get(cose.COSEKEYS.crv) === cose.COSECRV.P256
  )
    jwk = { kty: 'EC', crv: 'P-256', x: b64(key.get(cose.COSEKEYS.x)), y: b64(key.get(cose.COSEKEYS.y)) };
  else if (
    alg === cose.COSEALG.EdDSA &&
    cose.isCOSEPublicKeyOKP(key) &&
    key.get(cose.COSEKEYS.crv) === cose.COSECRV.ED25519
  )
    jwk = { kty: 'OKP', crv: 'Ed25519', x: b64(key.get(cose.COSEKEYS.x)) };
  else if (alg === cose.COSEALG.RS256 && cose.isCOSEPublicKeyRSA(key))
    jwk = { kty: 'RSA', n: b64(key.get(cose.COSEKEYS.n)), e: b64(key.get(cose.COSEKEYS.e)) };
  else
    throw badRequest(
      'passkey_algorithm',
      'This passkey uses an algorithm the runner cannot check (ES256, EdDSA or RS256 only).',
    );
  const spki = createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'der' });
  return { alg, spki: spki.toString('base64') };
}

/**
 * Verifies the browser's registration (challenge, origin, RP id, user verification), records `WorkstationPasskeyAdded`
 * and queues `passkey.offer`. The offer is not trust: the runner keeps it pending until `guildwise-runner passkey trust`.
 */
export async function addPasskey(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  body: AddPasskeyRequest,
): Promise<WorkstationPasskeyDto> {
  await ownWorkstation(ctx.pool, user.id, workstationId);
  const expectedChallenge = await challengeOf(ctx, body.registrationToken, user.id, workstationId);
  const { rpId, origin } = passkeyRp(ctx);
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response as unknown as Parameters<typeof verifyRegistrationResponse>[0]['response'],
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      expectedType: 'webauthn.create',
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...PASSKEY_ALGS],
    });
  } catch (err) {
    ctx.log.info({ code: (err as { code?: string }).code }, 'passkey registration refused');
    throw badRequest('passkey_invalid', 'The passkey registration could not be verified.');
  }
  if (!verification.verified || !verification.registrationInfo.userVerified)
    throw badRequest('passkey_invalid', 'The passkey registration could not be verified.');
  const info = verification.registrationInfo;
  const credentialId = info.credential.id;
  const { alg, spki } = coseToSpki(info.credential.publicKey);
  const passkeyId = randomUUID();
  const now = ctx.clock.now();
  await withAppendTx(ctx.pool, async (tx) => {
    // under the append lock: a second registration of the same credential, or one over the cap, cannot slip in
    await ownWorkstation(tx, user.id, workstationId);
    if (await one(tx, 'SELECT 1 FROM workstation_passkeys WHERE credential_id=$1', [credentialId]))
      throw conflict('passkey_exists', 'This passkey is already registered.');
    const n = await one<{ n: number }>(
      tx,
      'SELECT count(*)::int AS n FROM workstation_passkeys WHERE workstation_id=$1 AND removed_at IS NULL',
      [workstationId],
    );
    if ((n?.n ?? 0) >= MAX_PASSKEYS_PER_WORKSTATION)
      throw conflict(
        'passkey_limit',
        `A workstation keeps at most ${MAX_PASSKEYS_PER_WORKSTATION} passkeys.`,
      );
    await ctx.store.append(
      [
        {
          streamId: streamId.workstation(workstationId),
          event: {
            type: 'WorkstationPasskeyAdded',
            payload: {
              workstationId,
              passkeyId,
              credentialId,
              publicKey: spki,
              alg,
              name: body.name,
              by: user.id,
            },
          },
          actor: userActor(user.id),
          scope: userScope(user.id),
        },
      ],
      { tx },
    );
    await enqueueRunnerCommand(tx, workstationId, 'passkey.offer', {
      passkeyId,
      credentialId,
      publicKey: spki,
      alg,
      name: body.name,
      ...(info.aaguid && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(info.aaguid) ? { aaguid: info.aaguid } : {}),
      createdAt: now.toISOString(),
      rpId,
      origin,
    });
  });
  void Promise.resolve(ctx.services.gateway.deliverPending(workstationId)).catch(() => undefined);
  return { id: passkeyId, name: body.name, credentialId, alg, createdAt: now.toISOString() };
}

/** Removes a passkey here and asks the runner to drop a pending offer (a locally trusted one stays until `passkey remove`). */
export async function removePasskey(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  passkeyId: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    await ownWorkstation(tx, user.id, workstationId);
    const p = await one<{ credential_id: string }>(
      tx,
      `SELECT credential_id FROM workstation_passkeys WHERE id=$1 AND workstation_id=$2 AND removed_at IS NULL`,
      [passkeyId, workstationId],
    );
    if (!p) throw notFound('passkey not found');
    await ctx.store.append(
      [
        {
          streamId: streamId.workstation(workstationId),
          event: { type: 'WorkstationPasskeyRemoved', payload: { workstationId, passkeyId, by: user.id } },
          actor: userActor(user.id),
          scope: userScope(user.id),
        },
      ],
      { tx },
    );
    // an offer not yet delivered is never sent
    await exec(
      tx,
      `DELETE FROM runner_commands WHERE workstation_id=$1 AND type='passkey.offer' AND status='pending'
          AND payload->>'passkeyId' = $2`,
      [workstationId, passkeyId],
    );
    await enqueueRunnerCommand(tx, workstationId, 'passkey.withdraw', {
      passkeyId,
      credentialId: p.credential_id,
    });
  });
  void Promise.resolve(ctx.services.gateway.deliverPending(workstationId)).catch(() => undefined);
}

/** What the runner holds right now, and the passkey assertions relayed in the last minutes with the runner's answers. */
export async function workstationApprovals(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
): Promise<WorkstationApprovalsResponse> {
  await ownWorkstation(ctx.pool, user.id, workstationId);
  const held = heldItemsOf(ctx.services.runners, workstationId);
  const now = ctx.clock.now();
  const items = held.items.map((i): ApprovalItemDto => {
    // A passkey challenge on any other kind is dropped here as well (the runner refuses it in any case).
    const allowed = isPasskeyKind(i.kind) && !!i.passkey;
    const { passkey, ...rest } = i;
    return allowed
      ? { ...rest, passkey, passkeyApprovable: Date.parse(passkey?.expiresAt ?? '') > now.getTime() }
      : { ...rest, passkeyApprovable: false };
  });
  const relays = await rows<{
    id: string;
    item_id: string;
    status: string;
    last_error: string | null;
    created_at: Date;
    expires_at: Date | null;
  }>(
    ctx.pool,
    `SELECT id, payload->>'itemId' AS item_id, status, last_error, created_at, expires_at FROM runner_commands
      WHERE workstation_id=$1 AND type='approval.passkey' AND created_at > $2
      ORDER BY created_at DESC, id LIMIT 20`,
    [workstationId, new Date(now.getTime() - RELAY_HISTORY_MS)],
  );
  const conn = ctx.services.runners.isOnline(workstationId)
    ? ctx.services.runners.get(workstationId)
    : undefined;
  return {
    online: held.online,
    reportedAt: held.reportedAt?.toISOString() ?? null,
    items,
    steps: conn?.localSteps ?? [],
    windowPort: conn?.local && !conn.local.windowError ? (conn.local.windowPort ?? null) : null,
    relays: relays.map(
      (r): PasskeyRelayDto => ({
        commandId: r.id,
        itemId: r.item_id,
        status:
          r.status === 'done'
            ? 'accepted'
            : r.status === 'failed'
              ? 'refused'
              : r.expires_at && r.expires_at.getTime() <= now.getTime()
                ? 'expired'
                : 'sent',
        error: r.status === 'failed' ? (r.last_error ?? 'refused') : null,
        at: r.created_at.toISOString(),
      }),
    ),
  };
}

/**
 * Relays a WebAuthn assertion for a held item to the runner (`approval.passkey`). The checks here only spare a round trip
 * for an assertion the runner would refuse anyway; the runner verifies the signature, challenge, origin, RP id, UV flag,
 * sign count, nonce and kind on its own and releases the item only then. Nothing is approved by the server.
 */
export async function relayPasskeyApproval(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  itemId: string,
  body: PasskeyApprovalRequest,
): Promise<PasskeyApprovalResponse> {
  await ownWorkstation(ctx.pool, user.id, workstationId);
  const held = heldItemsOf(ctx.services.runners, workstationId);
  if (!held.online)
    throw conflict(
      'workstation_offline',
      'This workstation is offline. Approve when its runner is connected.',
    );
  const item = held.items.find((i) => i.id === itemId);
  if (!item) throw notFound('This item is no longer held by the workstation.', 'held_item_not_found');
  if (!isPasskeyKind(item.kind) || !item.passkey)
    throw conflict(
      'passkey_not_allowed',
      `This needs a yes on the workstation itself: guildwise-runner approve ${item.id}`,
    );
  const now = ctx.clock.now();
  if (Date.parse(item.passkey.expiresAt) <= now.getTime())
    throw conflict(
      'passkey_challenge_expired',
      'The approval request expired. Wait for the workstation to renew it.',
    );
  if (!item.passkey.credentialIds.includes(body.credentialId))
    throw conflict('passkey_not_trusted', 'The workstation does not trust this passkey.');
  let client: { type: string; challenge: string };
  try {
    client = decodeClientDataJSON(body.clientDataJSON);
  } catch {
    throw badRequest('passkey_invalid', 'The passkey answer could not be read.');
  }
  if (client.type !== 'webauthn.get' || client.challenge !== item.passkey.challenge)
    throw badRequest('passkey_invalid', 'The passkey answer is not for this item.');
  const commandId = await enqueueRunnerCommand(
    ctx.pool,
    workstationId,
    'approval.passkey',
    { itemId, ...body },
    new Date(item.passkey.expiresAt),
  );
  void Promise.resolve(ctx.services.gateway.deliverPending(workstationId)).catch(() => undefined);
  return { relayed: true, commandId };
}

/**
 * The runner's answer to a passkey command. A refusal is final: retrying the same offer, withdrawal or assertion cannot
 * change it (an assertion's nonce is spent). Returns false for any other command.
 */
export async function applyPasskeyCommandResult(
  ctx: Ctx,
  type: string | undefined,
  commandId: string,
  ok: boolean,
  error: string | undefined,
): Promise<boolean> {
  if (!type || !PASSKEY_COMMANDS.has(type)) return false;
  const now = ctx.clock.now();
  if (ok) await completeCommand(ctx.pool, commandId, true, undefined, now);
  else await failCommandFinal(ctx.pool, commandId, error ?? 'refused by the workstation', now);
  return true;
}
