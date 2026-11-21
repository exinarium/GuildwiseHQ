import {
  SIGNED_RUNNER_REQUIRED,
  type SignedReleaseProof,
  streamId,
  type WorkstationRelease,
} from '@aom/shared';
import { securitySetting } from '../auth/security-settings.ts';
import { SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import { unlinkWorkstationIn } from '../commands/workstations.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { HttpError } from '../errors.ts';
import {
  belowPairableFloor,
  checkReleaseProof,
  type ReleaseProofVerdict,
  SIGNED_RUNNERS_SINCE,
  verifyServedRelease,
} from '../installer/release.ts';
import { brandedMail, PRODUCT } from '../mail/layout.ts';
import type { MailMessage } from '../mail/mailer.ts';

/**
 * The signed-runner sweep and the refusals of "Only signed runners" (R21, R27). One mechanism that behaves the same on
 * an empty DB, on a populated DB and when a self-hoster turns the setting on later: every active workstation without a
 * valid signed-release proof, or below `MIN_PAIRABLE_RUNNER`, is unlinked (`WorkstationUnlinked.by = 'signed_required'`)
 * and nothing it could use to come back survives: no runner token, workstation key, sudo key, pending command or
 * pairing. With the setting off (the core default) nothing here runs and every runner keeps working (R29).
 */

/** The one rule for "unsigned" (also what `countUnsignedWorkstations` counts, so the confirmation and the sweep agree). */
export async function unsignedWorkstations(db: Queryable): Promise<Array<{ id: string; userId: string }>> {
  const list = await rows<{
    id: string;
    user_id: string;
    release_signed: boolean;
    runner_version: string | null;
  }>(
    db,
    `SELECT id, user_id, release_signed, runner_version FROM workstations
      WHERE status = 'active' AND simulation_org_id IS NULL ORDER BY paired_at, id`,
  );
  return list
    .filter((w) => !w.release_signed || belowPairableFloor(w.runner_version))
    .map((w) => ({ id: w.id, userId: w.user_id }));
}

/**
 * Unlinks the given (or every) unsigned workstation inside the caller's transaction and deletes what would let its
 * runner back in. `by` is the super admin who turned the setting on; absent (boot, a refused hello) it is the system.
 * Returns how many workstations it unlinked.
 */
export async function sweepUnsignedRunnersIn(
  ctx: Ctx,
  tx: Tx,
  opts: { by?: string; only?: string[] } = {},
): Promise<number> {
  let list = await unsignedWorkstations(tx);
  if (opts.only) list = list.filter((w) => opts.only?.includes(w.id));
  let n = 0;
  for (const w of list) {
    const ws = await one<{ status: string; devops_sudo_key_id: string | null }>(
      tx,
      `SELECT status, devops_sudo_key_id FROM workstations WHERE id=$1 FOR UPDATE`,
      [w.id],
    );
    if (ws?.status !== 'active') continue;
    const actor = opts.by ? userActor(opts.by) : SYSTEM_ACTOR;
    // Pending commands go entirely (the unlink would only mark them failed): nothing queued reaches a reinstalled runner.
    await exec(tx, `DELETE FROM runner_commands WHERE workstation_id=$1 AND status IN ('pending','sent')`, [
      w.id,
    ]);
    await unlinkWorkstationIn(ctx, tx, opts.by ?? w.userId, w.id, w.userId, 'signed_required', actor);
    if (ws.devops_sudo_key_id)
      await ctx.store.append(
        [
          {
            streamId: streamId.workstation(w.id),
            event: {
              type: 'DevOpsSudoPasswordCleared',
              payload: { workstationId: w.id, by: opts.by ?? w.userId },
            },
            actor,
            scope: { orgId: null, projectId: null, audience: 'user', userId: w.userId },
          },
        ],
        { tx },
      );
    await exec(tx, 'DELETE FROM workstation_keys WHERE workstation_id=$1', [w.id]);
    await exec(tx, 'DELETE FROM runner_token_rotations WHERE workstation_id=$1', [w.id]);
    // The pairing that made it, and any code of its owner not used yet: no pairing of the old install survives.
    const codes = await rows<{ id: string }>(
      tx,
      `SELECT id FROM pairing_codes WHERE workstation_id=$1 OR (user_id=$2 AND used_at IS NULL)`,
      [w.id, w.userId],
    );
    const ids = codes.map((c) => c.id);
    if (ids.length) {
      await exec(tx, 'DELETE FROM installer_sessions WHERE pairing_code_id = ANY($1::uuid[])', [ids]);
      await exec(tx, 'DELETE FROM pairing_codes WHERE id = ANY($1::uuid[])', [ids]);
    }
    n++;
  }
  if (n) ctx.log.warn({ unlinked: n }, 'signed-runner sweep: unsigned or outdated runners unlinked');
  return n;
}

/** The sweep in its own transaction, only while the effective setting is on. */
export async function sweepUnsignedRunners(ctx: Ctx): Promise<number> {
  if (!(await securitySetting(ctx, 'requireSignedRunners'))) return 0;
  return withAppendTx(ctx.pool, (tx) => sweepUnsignedRunnersIn(ctx, tx));
}

/**
 * Boot, after the data migrations: with the setting on, the served runner release must verify (else boot refuses: an
 * image built with `RUNNER_RELEASE=dev` cannot enforce), then the sweep runs (idempotent; nothing on an empty DB) and the
 * reinstall mails go out. With the setting off it does nothing.
 */
export async function signedRunnersAtBoot(ctx: Ctx): Promise<{ unlinked: number; mailed: number }> {
  if (!(await securitySetting(ctx, 'requireSignedRunners'))) return { unlinked: 0, mailed: 0 };
  const served = await verifyServedRelease(ctx.config);
  if (!served.ok)
    throw new Error(
      `"Only signed runners" is on but this server's runner release does not verify (${served.reason}). Build the image with RUNNER_RELEASE=official or own-key (docs/SELF-HOSTING.md), or turn the setting off.`,
    );
  const unlinked = await sweepUnsignedRunners(ctx);
  const mailed = await mailRunnerReinstallNotices(ctx);
  return { unlinked, mailed };
}

// ------------------------------------------------------------------------------------------ refusals

/** 403 `signed_runner_required` at pairing. */
export class SignedRunnerRequiredError extends HttpError {
  constructor(reason: string) {
    super(
      403,
      SIGNED_RUNNER_REQUIRED,
      `this server accepts only signed runners from ${SIGNED_RUNNERS_SINCE} on (${reason}): install the runner with the installer this server serves`,
    );
  }
}

/**
 * The pairing check (`pairRunner`): with the setting on, a missing or invalid proof or a version below the floor is
 * refused with 403; with it off the pairing goes ahead. Returns what goes into `WorkstationPaired.release` (absent when
 * the runner sent no valid proof). Simulated workstations are not runners and are never checked.
 */
export async function pairingRelease(
  ctx: Ctx,
  input: {
    runnerVersion: string;
    release?: SignedReleaseProof | undefined;
    simulationOrgId?: string | undefined;
  },
): Promise<WorkstationRelease | undefined> {
  if (input.simulationOrgId) return undefined;
  const verdict = checkReleaseProof(ctx.config, input.runnerVersion, input.release);
  if (verdict.ok) return verdict.release;
  if (await securitySetting(ctx, 'requireSignedRunners')) throw new SignedRunnerRequiredError(verdict.reason);
  return undefined;
}

/**
 * The `hello` check (gateway): records whether this runner proved a signed release (`release_signed`,
 * `release_key_id`) and its start-up refusal, and answers whether the connection may go on. With the setting on, a
 * runner without a valid proof is refused and its workstation swept at once, so its token stops working too.
 */
export async function checkHelloRelease(
  ctx: Ctx,
  workstationId: string,
  hello: {
    runnerVersion: string;
    release?: SignedReleaseProof | undefined;
    startupRefused?: string | undefined;
  },
): Promise<{ allowed: boolean; verdict: ReleaseProofVerdict }> {
  const ws = await one<{ simulation_org_id: string | null }>(
    ctx.pool,
    'SELECT simulation_org_id FROM workstations WHERE id=$1',
    [workstationId],
  );
  const verdict = checkReleaseProof(ctx.config, hello.runnerVersion, hello.release);
  await exec(
    ctx.pool,
    `UPDATE workstations SET release_signed=$2, release_key_id=$3, startup_refused=$4 WHERE id=$1`,
    [workstationId, verdict.ok, verdict.ok ? verdict.release.keyId : null, hello.startupRefused ?? null],
  );
  if (verdict.ok || ws?.simulation_org_id) return { allowed: true, verdict };
  if (!(await securitySetting(ctx, 'requireSignedRunners'))) return { allowed: true, verdict };
  ctx.log.warn({ workstationId, reason: verdict.reason }, 'runner refused: not a signed runner release');
  await withAppendTx(ctx.pool, (tx) => sweepUnsignedRunnersIn(ctx, tx, { only: [workstationId] }));
  return { allowed: false, verdict };
}

// ------------------------------------------------------------------------------------------ notices

export const RUNNER_REINSTALL_NOTICE = 'runner_reinstall';

/** The workstations of a user that the sweep unlinked and that have not been replaced by a newer pairing of the same host. */
export async function reinstallRequired(
  db: Queryable,
  userId: string,
): Promise<Array<{ id: string; name: string; hostname: string; unlinkedAt: string }>> {
  const list = await rows<{ id: string; name: string; hostname: string; unlinked_at: Date }>(
    db,
    `SELECT w.id, w.name, w.hostname, w.unlinked_at FROM workstations w
      WHERE w.user_id = $1 AND w.status = 'unlinked'
        AND EXISTS (SELECT 1 FROM events e WHERE e.type = 'WorkstationUnlinked'
                     AND e.stream_id = 'workstation-' || w.id::text AND e.payload->>'by' = 'signed_required')
        AND NOT EXISTS (SELECT 1 FROM workstations n WHERE n.user_id = w.user_id AND n.status = 'active'
                         AND n.hostname = w.hostname AND n.paired_at > w.unlinked_at)
      ORDER BY w.unlinked_at DESC, w.name`,
    [userId],
  );
  return list.map((w) => ({
    id: w.id,
    name: w.name,
    hostname: w.hostname,
    unlinkedAt: new Date(w.unlinked_at).toISOString(),
  }));
}

export function runnerReinstallMail(opts: {
  to: string;
  displayName: string;
  workstations: string[];
  origin: string;
}): MailMessage {
  const origin = opts.origin.replace(/\/+$/, '');
  return brandedMail({
    to: opts.to,
    subject: `Reinstall the runner on ${opts.workstations.length === 1 ? opts.workstations[0] : `${opts.workstations.length} workstations`}`,
    preheader: 'This server now accepts only signed runners: your old runner was removed.',
    heading: 'Your workstation needs a fresh runner install',
    origin,
    body: [
      `Hi ${opts.displayName}, this ${PRODUCT} server now accepts only signed runners from ${SIGNED_RUNNERS_SINCE} on, so it unpaired the workstations below. Their old runner can no longer connect or update itself.`,
      { facts: opts.workstations.map((w) => ['Workstation', w] as [string, string]) },
      'Open the Workstations page and add the workstation again: the installer stops the old runner, moves its files into a quarantine folder and installs the signed runner. Never reuse the old runner’s files. If you had given the old runner sudo, change your computer password.',
    ],
    cta: { label: 'Open the Workstations page', url: `${origin}/workstations` },
    note: 'You get this once, because a workstation of yours ran an unsigned or outdated runner.',
  });
}

/**
 * Mails each owner of a swept workstation once (`security_notices`, kind `runner_reinstall`). The row is written only
 * when the mail went out, so a server without working mail tries again on a later tick. Nothing while the setting is
 * off. Returns how many were mailed.
 */
export async function mailRunnerReinstallNotices(ctx: Ctx): Promise<number> {
  // Only while the setting is on: after a switch back off, nobody is told this server accepts only signed runners.
  if (!(await securitySetting(ctx, 'requireSignedRunners'))) return 0;
  const owners = await rows<{ user_id: string; email: string; display_name: string; names: string[] }>(
    ctx.pool,
    `SELECT u.id AS user_id, u.email, u.display_name, array_agg(w.name ORDER BY w.name) AS names
       FROM workstations w JOIN users u ON u.id = w.user_id
      WHERE w.status = 'unlinked' AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM events e WHERE e.type = 'WorkstationUnlinked'
                     AND e.stream_id = 'workstation-' || w.id::text AND e.payload->>'by' = 'signed_required')
        AND NOT EXISTS (SELECT 1 FROM security_notices s WHERE s.user_id = u.id AND s.kind = $1)
      GROUP BY u.id, u.email, u.display_name`,
    [RUNNER_REINSTALL_NOTICE],
  );
  let mailed = 0;
  for (const o of owners) {
    try {
      await ctx.mailer.send(
        runnerReinstallMail({
          to: o.email,
          displayName: o.display_name,
          workstations: o.names,
          origin: ctx.config.publicOrigin,
        }),
      );
    } catch (err) {
      ctx.log.warn({ err, userId: o.user_id }, 'runner reinstall mail not sent; retried later');
      continue;
    }
    await exec(
      ctx.pool,
      `INSERT INTO security_notices (user_id, kind, sent_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [o.user_id, RUNNER_REINSTALL_NOTICE, ctx.clock.now()],
    );
    mailed++;
  }
  return mailed;
}
