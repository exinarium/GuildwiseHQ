import {
  CONFIRM_UNLINK_REQUIRED,
  type EventMeta,
  LEGACY_TWO_FACTOR_REFUSED,
  SECURITY_SETTING_KEYS,
  SETTING_LOCKED,
  type SecuritySettingKey,
  type SecuritySettingState,
  type SecuritySettingsResponse,
  streamId,
  TWO_FACTOR_KEY_REQUIRED,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { afterCommit, withAppendTx } from '../db/tx.ts';
import { conflict, HttpError } from '../errors.ts';
import { verifyServedRelease } from '../installer/release.ts';
import {
  mailRunnerReinstallNotices,
  sweepUnsignedRunnersIn,
  unsignedWorkstations,
} from '../runner-gateway/signed-sweep.ts';

/** 409 of turning "Only signed runners" on while this server's own runner release does not verify. */
export const RUNNER_RELEASE_UNSIGNED = 'runner_release_unsigned';

/**
 * Security settings (R27, R28): "Only signed runners" (`requireSignedRunners`), "Require two-factor login"
 * (`enforceTwoFactor`) and "Refuse legacy two-factor" (`refuseLegacyTwoFactor`, owner 2026-11-21: Cloud only, locked).
 * All off by default in core. Effective value = the extension lock (`lockedSecuritySettings`),
 * else the platform setting (`platform_settings`), else the env default (`AOM_REQUIRE_SIGNED_RUNNERS`,
 * `AOM_ENFORCE_TWO_FACTOR`), else off. A hosted build locks both on, so neither the UI, the API nor the config can turn
 * them off there. Every change is a `SecuritySettingChanged` event (platform audit, `always`).
 */

/** Where each setting is stored in `platform_settings`. */
export const SECURITY_SETTING_STORE_KEYS: Record<SecuritySettingKey, string> = {
  requireSignedRunners: 'security.require_signed_runners',
  enforceTwoFactor: 'security.enforce_two_factor',
  refuseLegacyTwoFactor: 'security.refuse_legacy_two_factor',
};

/** Whether a two-factor key outside the database is configured (`AOM_TWO_FACTOR_KEY`, or one derived from `AOM_SECRET_KEY`). */
export const hasEnvTwoFactorKey = (config: {
  twoFactorKey?: string | undefined;
  secretKey?: string | undefined;
}) => !!(config.twoFactorKey || config.secretKey);

/**
 * Boot: "Refuse legacy two-factor" on from any source (lock, platform setting, env default) without a two-factor key
 * outside the database would refuse every two-factor login (every seed and code is then under the database key, and a new
 * enrolment too). The server refuses to start instead.
 */
export async function legacyTwoFactorAtBoot(ctx: Ctx): Promise<void> {
  if (hasEnvTwoFactorKey(ctx.config)) return;
  const s = await securitySettingState(ctx, 'refuseLegacyTwoFactor');
  if (!s.value) return;
  throw new Error(
    `"Refuse legacy two-factor" is on (${s.source === 'locked' ? 'locked by the hosting platform' : s.source === 'env' ? 'AOM_REFUSE_LEGACY_TWO_FACTOR' : 'platform setting'}) but no two-factor key is set outside the database, so every two-factor login would be refused. Set AOM_TWO_FACTOR_KEY (or AOM_SECRET_KEY) and start again${s.source === 'locked' ? '' : ', or turn the setting off'}.`,
  );
}

/** 403 `legacy_two_factor_refused`: a right but legacy second factor while "Refuse legacy two-factor" is on. */
export const legacyTwoFactorRefused = (what: 'recovery' | 'totp') =>
  new HttpError(
    403,
    LEGACY_TWO_FACTOR_REFUSED,
    `${what === 'recovery' ? 'This recovery code was made before Guildwise 1.10.0' : 'Your authenticator app was set up with a key this server no longer accepts'}: this server refuses old two-factor logins. Reset two-factor login by email ("Lost your authenticator and your recovery codes?" on the sign-in page), then set it up again; you get new recovery codes.`,
    { reenrol: '/api/auth/2fa/recovery/start' },
  );

// Read on every pairing, hello and session lookup: cached per process, dropped after a change commits.
const cache = new WeakMap<Ctx, Map<SecuritySettingKey, SecuritySettingState>>();
const cacheOf = (ctx: Ctx) => {
  const c = cache.get(ctx) ?? new Map<SecuritySettingKey, SecuritySettingState>();
  cache.set(ctx, c);
  return c;
};
export const invalidateSecuritySettings = (ctx: Ctx): void => {
  cache.delete(ctx);
};

async function storedValue(db: Queryable, key: SecuritySettingKey): Promise<boolean | null> {
  const r = await one<{ value: unknown }>(db, 'SELECT value FROM platform_settings WHERE key=$1', [
    SECURITY_SETTING_STORE_KEYS[key],
  ]);
  return typeof r?.value === 'boolean' ? r.value : null;
}

function resolve(ctx: Ctx, key: SecuritySettingKey, stored: boolean | null): SecuritySettingState {
  if (ctx.ext.lockedSecuritySettings[key] === true) return { value: true, locked: true, source: 'locked' };
  if (stored !== null) return { value: stored, locked: false, source: 'platform' };
  if (ctx.config.securityDefaults[key]) return { value: true, locked: false, source: 'env' };
  return { value: false, locked: false, source: 'default' };
}

/** The effective value, whether it is locked, and where it comes from. Pass `db` to read inside a transaction (no cache). */
export async function securitySettingState(
  ctx: Ctx,
  key: SecuritySettingKey,
  db?: Queryable,
): Promise<SecuritySettingState> {
  if (db) return resolve(ctx, key, await storedValue(db, key));
  const c = cacheOf(ctx);
  const hit = c.get(key);
  if (hit) return hit;
  const state = resolve(ctx, key, await storedValue(ctx.pool, key));
  c.set(key, state);
  return state;
}

/** The effective value of a security setting. */
export async function securitySetting(ctx: Ctx, key: SecuritySettingKey, db?: Queryable): Promise<boolean> {
  return (await securitySettingState(ctx, key, db)).value;
}

/**
 * Active, non-simulated workstations without a valid signed-release proof or below `MIN_PAIRABLE_RUNNER` (what turning
 * signed runners on unlinks). The same rule as the sweep (`runner-gateway/signed-sweep.ts unsignedWorkstations`).
 */
export async function countUnsignedWorkstations(db: Queryable): Promise<number> {
  return (await unsignedWorkstations(db)).length;
}

/** Active accounts (not platform accounts) without two-factor login. */
export async function countUsersWithout2fa(db: Queryable): Promise<number> {
  const r = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM users WHERE kind = 'user' AND status = 'active' AND NOT two_factor_enabled`,
  );
  return r?.n ?? 0;
}

/** `GET /api/platform/security-settings`. */
export async function securitySettingsView(ctx: Ctx): Promise<SecuritySettingsResponse> {
  return {
    requireSignedRunners: await securitySettingState(ctx, 'requireSignedRunners'),
    enforceTwoFactor: await securitySettingState(ctx, 'enforceTwoFactor'),
    refuseLegacyTwoFactor: await securitySettingState(ctx, 'refuseLegacyTwoFactor'),
    unsignedWorkstations: await countUnsignedWorkstations(ctx.pool),
    usersWithout2fa: await countUsersWithout2fa(ctx.pool),
  };
}

/**
 * Changes one security setting as the platform setting. 409 `setting_locked` for a key the build locks; 409
 * `confirm_unlink_required {unsignedWorkstations}` when turning signed runners on would unlink workstations and
 * `confirmUnlink` is not set. Writing the value it already has appends nothing.
 */
export async function setSecuritySetting(
  ctx: Ctx,
  by: { id: string },
  key: SecuritySettingKey,
  value: boolean,
  opts: { confirmUnlink?: boolean | undefined; meta?: EventMeta } = {},
): Promise<{ changed: boolean; unlinked: number }> {
  if (ctx.ext.lockedSecuritySettings[key] === true)
    throw conflict(SETTING_LOCKED, 'this setting is set by the hosting platform and cannot be changed here', {
      key,
    });
  // A server whose own runner release does not verify cannot enforce: turning the setting on would make the next boot
  // refuse (R18-U), so it is refused here instead and nobody is locked out.
  if (key === 'requireSignedRunners' && value && !(await securitySetting(ctx, key))) {
    const served = await verifyServedRelease(ctx.config);
    if (!served.ok)
      throw conflict(
        RUNNER_RELEASE_UNSIGNED,
        `this server's runner release does not verify (${served.reason}): build it with RUNNER_RELEASE=official or own-key first`,
      );
  }
  // With only the database-stored key, refusing it would refuse every two-factor login: an env key comes first.
  if (key === 'refuseLegacyTwoFactor' && value && !hasEnvTwoFactorKey(ctx.config))
    throw conflict(
      TWO_FACTOR_KEY_REQUIRED,
      'set AOM_TWO_FACTOR_KEY (or AOM_SECRET_KEY) first: this server keeps its only two-factor key in the database, so refusing it would refuse every two-factor login',
    );
  const out = await withAppendTx(ctx.pool, async (tx) => {
    const before = await securitySettingState(ctx, key, tx);
    const stored = await storedValue(tx, key);
    if (stored === value) return { changed: false, unlinked: 0 };
    let unlinked = 0;
    if (key === 'requireSignedRunners' && value && !before.value) {
      const unsigned = await countUnsignedWorkstations(tx);
      if (unsigned > 0 && opts.confirmUnlink !== true)
        throw conflict(
          CONFIRM_UNLINK_REQUIRED,
          `${unsigned} workstation(s) run an unsigned or outdated runner and will be unlinked: confirm to continue`,
          { unsignedWorkstations: unsigned },
        );
      unlinked = await sweepUnsignedRunnersIn(ctx, tx, { by: by.id });
    }
    await exec(
      tx,
      `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [SECURITY_SETTING_STORE_KEYS[key], JSON.stringify(value), by.id, ctx.clock.now()],
    );
    await ctx.store.append(
      [
        {
          streamId: streamId.platformSecurity(),
          event: {
            type: 'SecuritySettingChanged',
            payload: {
              key,
              value,
              by: by.id,
              ...(key === 'requireSignedRunners' && value ? { unlinked } : {}),
              ...(opts.meta ? { meta: opts.meta } : {}),
            },
          },
          actor: { kind: 'user', id: by.id },
          scope: { orgId: null, projectId: null, audience: 'admin' },
        },
      ],
      { tx },
    );
    afterCommit(tx, () => invalidateSecuritySettings(ctx));
    return { changed: true, unlinked };
  });
  invalidateSecuritySettings(ctx);
  // The owners of the workstations just unlinked get their one reinstall mail (R21); a mail problem never fails the change.
  if (out.unlinked > 0)
    await mailRunnerReinstallNotices(ctx).catch((err) =>
      ctx.log.warn({ err }, 'runner reinstall mails not sent'),
    );
  return out;
}

/** One line per setting for the boot log: effective value and its source. */
export async function describeSecuritySettings(ctx: Ctx): Promise<Record<SecuritySettingKey, string>> {
  const stored = new Map(
    (
      await rows<{ key: string; value: unknown }>(
        ctx.pool,
        `SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])`,
        [Object.values(SECURITY_SETTING_STORE_KEYS)],
      )
    ).map((r) => [r.key, r.value]),
  );
  const out = {} as Record<SecuritySettingKey, string>;
  for (const key of SECURITY_SETTING_KEYS) {
    const v = stored.get(SECURITY_SETTING_STORE_KEYS[key]);
    const s = resolve(ctx, key, typeof v === 'boolean' ? v : null);
    out[key] = `${s.value ? 'on' : 'off'} (${s.source})`;
  }
  return out;
}
