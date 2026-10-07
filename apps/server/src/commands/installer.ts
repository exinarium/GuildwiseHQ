import type {
  CreateInstallerRequest,
  InstallerProgressRequest,
  InstallerSession,
  InstallerState,
  InstallerStatus,
  InstallerStep,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { generatePairingCode, normalizePairingCode, randomToken, sha256Hex } from '../crypto.ts';
import { exec, iso, one, type Row } from '../db/sql.ts';
import { withTx } from '../db/tx.ts';
import { notFound } from '../errors.ts';
import { latestRelease } from '../installer/release.ts';
import { cleanName, oneLiner, renderBash, renderPowerShell, scriptFileName } from '../installer/render.ts';
import { createPairingCode } from './workstations.ts';

/** The one-time pairing code and the script links live this long. */
export const INSTALLER_TTL_MS = 30 * 60_000;
/** Progress reports are still accepted this long after the session was made (a Windows restart takes a while). */
const PROGRESS_WINDOW_MS = 6 * 3_600_000;
const MAX_STEPS = 300;

export type ScriptKind = 'linux' | 'macos' | 'windows';

const scriptPath = (kind: ScriptKind, token: string): string =>
  `/install/${token}/${kind === 'linux' ? 'install.sh' : kind === 'macos' ? 'install-mac.sh' : 'install.ps1'}`;

/** A wizard session: a fresh one-time pairing code, short-lived script links, and where to follow the progress. */
export async function createInstallerSession(
  ctx: Ctx,
  user: AuthSession['user'],
  input: CreateInstallerRequest,
): Promise<InstallerSession> {
  const now = ctx.clock.now();
  const expiresAt = new Date(now.getTime() + INSTALLER_TTL_MS);
  const token = randomToken(24);
  const name = cleanName(input.name ?? '');
  // Starting over (another system, a new command) retires the earlier unused sessions and their codes.
  const prior = await ctx.pool.query(
    `SELECT i.id, i.pairing_code_id FROM installer_sessions i JOIN pairing_codes c ON c.id = i.pairing_code_id
      WHERE i.user_id=$1 AND c.used_at IS NULL AND c.expires_at > $2`,
    [user.id, now],
  );
  const code = await createPairingCode(ctx, user, {
    ttlMs: INSTALLER_TTL_MS,
    supersedeIds: prior.rows.map((r) => String(r.pairing_code_id)).filter((x) => x !== 'null'),
  });
  const row = await withTx(ctx.pool, async (tx) => {
    await exec(tx, `UPDATE installer_sessions SET expires_at = $2 WHERE id = ANY($1::uuid[])`, [
      prior.rows.map((r) => r.id),
      now,
    ]);
    return one(
      tx,
      `INSERT INTO installer_sessions (user_id, token_hash, os, workstation_name, pairing_code_id, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [user.id, sha256Hex(token), input.os, name, code.id, now, expiresAt],
    );
  });
  const release = await latestRelease(ctx.config);
  const url = `${ctx.config.publicOrigin}${scriptPath(input.os, token)}`;
  return {
    id: String(row?.id),
    os: input.os,
    expiresAt: expiresAt.toISOString(),
    oneLiner: oneLiner(input.os, url),
    downloadUrl: `${url}?download=1`,
    fileName: scriptFileName(input.os),
    release: release ? { version: release.version, sha256: release.sha256, size: release.size } : null,
  };
}

const toStep = (s: Row): InstallerStep => ({
  step: String(s.step),
  status: s.status,
  detail: String(s.detail ?? ''),
  at: String(s.at),
});

/** Where an install stands, for the wizard (owner only). */
export async function installerStatus(ctx: Ctx, userId: string, id: string): Promise<InstallerStatus> {
  const s = await one(
    ctx.pool,
    `SELECT i.*, c.used_at, c.workstation_id, w.name AS workstation_name
       FROM installer_sessions i
       LEFT JOIN pairing_codes c ON c.id = i.pairing_code_id
       LEFT JOIN workstations w ON w.id = c.workstation_id
      WHERE i.id=$1 AND i.user_id=$2`,
    [id, userId],
  );
  if (!s) throw notFound('install session not found');
  const all = (s.steps as Row[]).map(toStep);
  const doctor = all
    .filter((x) => x.step.startsWith('doctor:'))
    .map((x) => ({ ...x, step: x.step.slice(7) }));
  const steps = all.filter((x) => !x.step.startsWith('doctor:'));
  const paired = !!(s.used_at || s.paired_at);
  const now = ctx.clock.now();
  let state: InstallerState = 'waiting';
  if (s.finished_at) state = 'done';
  else if (paired && doctor.length > 0) state = 'checking';
  else if (paired) state = 'paired';
  else if (s.started_at) state = 'running';
  else if (new Date(s.expires_at) <= now) state = 'expired';
  return {
    id: s.id,
    os: s.os,
    state,
    result: s.result === 'success' ? 'success' : s.result ? 'failed' : null,
    expiresAt: iso(s.expires_at) as string,
    workstationId: s.workstation_id ?? null,
    workstationName: s.workstation_name ?? null,
    steps,
    doctor,
  };
}

/** The script behind a short-lived link; null when the link is unknown or has expired. */
export async function installerScript(
  ctx: Ctx,
  token: string,
  kind: ScriptKind,
): Promise<{ text: string; fileName: string } | null> {
  const now = ctx.clock.now();
  const s = await one(
    ctx.pool,
    `SELECT i.id, i.workstation_name, i.expires_at, i.created_at, c.expires_at AS code_expires_at, c.id AS code_id
       FROM installer_sessions i JOIN pairing_codes c ON c.id = i.pairing_code_id
      WHERE i.token_hash=$1 AND i.expires_at > $2`,
    [sha256Hex(token), now],
  );
  if (!s) return null;
  const fresh = await mintCode(ctx, s.code_id, new Date(s.expires_at));
  const release = await latestRelease(ctx.config);
  const params = {
    serverUrl: ctx.config.publicOrigin,
    pairingCode: fresh,
    sessionToken: token,
    workstationName: String(s.workstation_name ?? ''),
    release: release ? { version: release.version, sha256: release.sha256 } : null,
    expiresAt: new Date(s.expires_at),
    generatedAt: now,
  };
  await exec(
    ctx.pool,
    `UPDATE installer_sessions SET script_fetched_at = COALESCE(script_fetched_at, $2) WHERE id=$1`,
    [s.id, now],
  );
  const origin = ctx.config.publicOrigin;
  if (kind === 'windows')
    return {
      text: renderPowerShell({
        ...params,
        scriptUrl: `${origin}${scriptPath('windows', token)}`,
        linuxScriptUrl: `${origin}/install/${token}/install-linux-wsl.sh`,
      }),
      fileName: scriptFileName('windows'),
    };
  return { text: renderBash(kind, params), fileName: scriptFileName(kind) };
}

/**
 * Only the hash of a pairing code is stored, so the code in a script is minted when the script is fetched: the session's
 * code row gets a fresh code (same expiry), and only the latest fetched copy of the script can pair. A code that was
 * already used stays used: the script is still served (a re-run upgrades or repairs a paired machine) with a code that
 * will not pair, and says so if it has to.
 */
async function mintCode(ctx: Ctx, codeId: string, expiresAt: Date): Promise<string> {
  const code = generatePairingCode();
  const n = await exec(
    ctx.pool,
    `UPDATE pairing_codes SET code_hash=$2, expires_at=$3, attempts=0 WHERE id=$1 AND used_at IS NULL`,
    [codeId, sha256Hex(normalizePairingCode(code)), expiresAt],
  );
  return n > 0 ? code : 'USED-CODE';
}

/** A progress report from an install script (the token is the credential). */
export async function recordInstallerProgress(
  ctx: Ctx,
  token: string,
  input: InstallerProgressRequest,
): Promise<boolean> {
  const now = ctx.clock.now();
  return withTx(ctx.pool, async (tx) => {
    const s = await one(
      tx,
      `SELECT id, jsonb_array_length(steps) AS n FROM installer_sessions WHERE token_hash=$1 AND created_at > $2 FOR UPDATE`,
      [sha256Hex(token), new Date(now.getTime() - PROGRESS_WINDOW_MS)],
    );
    if (!s) return false;
    if (Number(s.n) >= MAX_STEPS) return true;
    const entry = {
      step: input.step,
      status: input.status,
      detail: input.detail ?? '',
      at: now.toISOString(),
    };
    const paired =
      (input.step === 'Paired' && input.status === 'ok') ||
      (input.step === 'Pairing' && input.status === 'info');
    await exec(
      tx,
      `UPDATE installer_sessions SET
         steps = steps || $2::jsonb,
         started_at = CASE WHEN $3 THEN COALESCE(started_at, $6) ELSE started_at END,
         paired_at = CASE WHEN $4 THEN COALESCE(paired_at, $6) ELSE paired_at END,
         finished_at = CASE WHEN $5::text IS NOT NULL THEN $6 ELSE finished_at END,
         result = CASE WHEN $5::text IS NOT NULL THEN $5 ELSE result END
       WHERE id=$1`,
      [
        s.id,
        JSON.stringify([entry]),
        input.step === 'installer',
        paired,
        input.step === 'summary' && input.status === 'done'
          ? input.detail === 'success'
            ? 'success'
            : 'failed'
          : null,
        now,
      ],
    );
    return true;
  });
}
