import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerUpdateSettings } from '@aom/shared';
import type { Config } from '../config.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable } from '../db/sql.ts';

/**
 * The runner release the app serves (`aom-runner-<version>.tgz`, built by `pnpm package:runner`), with its sha256.
 * The directory comes from `AOM_RUNNER_RELEASE_DIR`; otherwise `release/` next to the working directory or the repo.
 */
export interface RunnerRelease {
  version: string;
  file: string;
  sha256: string;
  size: number;
}

const FILE = /^aom-runner-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz$/;
export const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

function releaseDirs(config: Pick<Config, 'runnerReleaseDir'>): string[] {
  if (config.runnerReleaseDir) return [resolve(config.runnerReleaseDir)];
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(process.cwd(), 'release'),
    resolve(process.cwd(), '../../release'),
    resolve(here, '../../../../release'), // apps/server/src/installer -> repo root
    resolve(here, '../../../release'), // apps/server/dist -> repo root
  ];
}

const cmp = (a: string, b: string): number => {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

const sums = new Map<string, { key: string; sha256: string }>();

async function sha256File(file: string, key: string): Promise<string> {
  const hit = sums.get(file);
  if (hit && hit.key === key) return hit.sha256;
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  const sha256 = h.digest('hex');
  sums.set(file, { key, sha256 });
  return sha256;
}

/** All releases in the directory, newest first. */
export async function listReleases(config: Pick<Config, 'runnerReleaseDir'>): Promise<RunnerRelease[]> {
  const dir = releaseDirs(config).find((d) => existsSync(d));
  if (!dir) return [];
  const out: RunnerRelease[] = [];
  for (const name of readdirSync(dir)) {
    const m = FILE.exec(name);
    if (!m?.[1]) continue;
    const file = join(dir, name);
    const st = statSync(file);
    if (!st.isFile()) continue;
    out.push({
      version: m[1],
      file,
      size: st.size,
      sha256: await sha256File(file, `${st.size}:${st.mtimeMs}`),
    });
  }
  return out.sort((a, b) => cmp(b.version, a.version));
}

export async function latestRelease(config: Pick<Config, 'runnerReleaseDir'>): Promise<RunnerRelease | null> {
  return (await listReleases(config))[0] ?? null;
}

/** The kill switch for runner auto-updates (a super admin sets it on the platform Runners page). */
export const RUNNER_UPDATES_PAUSED_KEY = 'runners.auto_update_paused';

export async function runnerUpdatesPaused(db: Queryable): Promise<boolean> {
  const r = await one(db, 'SELECT value FROM platform_settings WHERE key=$1', [RUNNER_UPDATES_PAUSED_KEY]);
  return r?.value === true;
}

export async function setRunnerUpdatesPaused(ctx: Ctx, paused: boolean, by: string): Promise<void> {
  await exec(
    ctx.pool,
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1,$2::jsonb,$3,$4)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
    [RUNNER_UPDATES_PAUSED_KEY, JSON.stringify(paused), by, ctx.clock.now()],
  );
  ctx.log.info({ paused, by }, 'runner auto-updates switch changed');
}

export async function runnerUpdateSettings(ctx: Ctx): Promise<RunnerUpdateSettings> {
  const row = await one(ctx.pool, 'SELECT value, updated_at FROM platform_settings WHERE key=$1', [
    RUNNER_UPDATES_PAUSED_KEY,
  ]);
  return {
    paused: row?.value === true,
    updatedAt: iso(row?.updated_at ?? null),
    latestVersion: (await latestRelease(ctx.config))?.version ?? null,
  };
}

export async function findRelease(
  config: Pick<Config, 'runnerReleaseDir'>,
  version: string,
): Promise<RunnerRelease | null> {
  return (await listReleases(config)).find((r) => r.version === version) ?? null;
}
