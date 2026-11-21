import { openSeed, sealedWithCurrent, sealSeed, type TwoFactorKeyEnv } from '../auth/two-factor-key.ts';
import { exec, one, rows } from '../db/sql.ts';
import { withTx } from '../db/tx.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `two-factor-reseal-2026-11` (R11, R29): re-seals every two-factor seed that is not sealed with the current two-factor
 * key (`v1:` seeds from before 1.10.0, and `t2:` seeds of an older key) under the current key, at first boot. Nobody
 * re-enrols. Legacy recovery codes are not touched here: they keep verifying and are re-hashed on use.
 *
 * Idempotent: each seed is re-read under its row lock and skipped when it is already current; the run is recorded once
 * with its counts in `data_migrations.summary`. A seed no available key can read is left untouched and its user id is
 * logged (never the seed); that user recovers by email (R17-2).
 */
export const TWO_FACTOR_RESEAL_MIGRATION = 'two-factor-reseal-2026-11';

export interface TwoFactorResealReport {
  resealed: number;
  current: number;
  unreadable: string[];
}

export async function migrateTwoFactorReseal(env: DataMigrationEnv): Promise<TwoFactorResealReport | null> {
  const { pool, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [TWO_FACTOR_RESEAL_MIGRATION]))
    return null;
  const keyEnv: TwoFactorKeyEnv = {
    pool,
    config: { secretKey: env.secretKey, twoFactorKey: env.twoFactorKey },
  };
  const report: TwoFactorResealReport = { resealed: 0, current: 0, unreadable: [] };
  const users = await rows<{ user_id: string }>(pool, 'SELECT user_id FROM user_totp ORDER BY user_id');
  for (const { user_id: userId } of users) {
    await withTx(pool, async (tx) => {
      const row = await one<{ secret_enc: string }>(
        tx,
        'SELECT secret_enc FROM user_totp WHERE user_id=$1 FOR UPDATE',
        [userId],
      );
      if (!row) return;
      if (await sealedWithCurrent(keyEnv, row.secret_enc)) {
        report.current++;
        return;
      }
      let seed: string;
      try {
        seed = (await openSeed(keyEnv, userId, row.secret_enc)).seed;
      } catch {
        report.unreadable.push(userId);
        log(`two-factor-reseal: the seed of user ${userId} opens with no available key; left as it is`);
        return;
      }
      await exec(tx, 'UPDATE user_totp SET secret_enc=$2 WHERE user_id=$1', [
        userId,
        await sealSeed(keyEnv, userId, seed),
      ]);
      report.resealed++;
    });
  }
  await exec(
    pool,
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
    [TWO_FACTOR_RESEAL_MIGRATION, clock.now(), JSON.stringify(report)],
  );
  log(
    `two-factor-reseal: ${report.resealed} re-sealed, ${report.current} already current, ${report.unreadable.length} unreadable`,
  );
  return report;
}
