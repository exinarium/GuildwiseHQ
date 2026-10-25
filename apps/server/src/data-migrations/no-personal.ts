import { randomUUID } from 'node:crypto';
import { interestVaultDir, normalizeRemoteUrl, projectVaultFolder, streamId } from '@aom/shared';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { chooseVaultWriteTarget } from '../commands/vaults.ts';
import { exec, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `no-personal-2026-10`. Now that
 * every user has an organization of their own, "personal" is gone:
 *
 * - **Ranking.** The projects of each organization get the order the dispatcher used to apply: work before personal,
 *   then the priority tier (so personal projects land below the work projects and keep their relative tier order), then
 *   age. One `ProjectsRanked` event makes it durable, so a projection rebuild reproduces it.
 * - **Vault.** The organization's personal vault is merged into its organization vault under `personal/` by one
 *   runner command (`vault.merge`, idempotent and safe if interrupted; the old repository is never changed and stays a
 *   backup). The folders of personal interests are lifted to `interests/<slug>/` (where every interest lives) and the
 *   personal projects point at `personal/projects/<key>` (`ProjectVaultDirSet`). `VaultMerged` retires the vault row. An
 *   organization with a personal vault and no organization vault keeps the repository: it becomes the organization vault.
 *   When both vaults point at the SAME repository (after `normalizeRemoteUrl`), nothing is merged (copying a repository
 *   into itself would duplicate every file): no runner command is queued, no folder moves, the paths of projects and
 *   interests stay as they are (the layout inside the shared repository is already `projects/<key>`, `interests/<slug>`),
 *   and `VaultMerged{sameRepository:true}` only retires the personal registration.
 * - **Notice.** One desk alert tells the Owner what happened.
 *
 * One-off, idempotent and rebuild-safe: everything it decides is an event (`ProjectsRanked`, `ProjectVaultDirSet`,
 * `VaultMerged`, `DeskItemCreated`). Each organization runs two steps, each recorded in `data_migrations` in the same
 * transaction as its events, so a second run (or a crash between organizations) never repeats one. The old domain of a
 * project is read from `legacy_project_domains`, the snapshot migration 1322 took before it dropped the columns.
 * A vault step that finds no workstation to run the merge on waits for the next run; the ranking does not.
 */
export const NO_PERSONAL_MIGRATION = 'no-personal-2026-10';
const LOCK_ID = 7332;

export interface NoPersonalProjectPlan {
  key: string;
  name: string;
  status: string;
  domain: 'work' | 'personal';
  tier: number;
  /** Where it is in the ranking now (the SQL migration seeded it) and where the migration puts it. */
  currentRank: number | null;
  newRank: number;
  /** Personal project that has no vault of its own: its folder moves to `personal/...` when the vault is merged. */
  vaultDir: { from: string; to: string } | null;
}
export interface NoPersonalOrgPlan {
  orgId: string;
  name: string;
  rankPending: boolean;
  projects: NoPersonalProjectPlan[];
  vaultPending: boolean;
  /**
   * `merge`: files go into the organization vault under `personal/`; `promote`: the personal vault becomes the
   * organization vault; `retire`: both vaults use the same repository, so only the personal registration is retired.
   */
  vaultAction: 'none' | 'merge' | 'promote' | 'retire';
  personalVault: { name: string; remoteUrl: string } | null;
  /** Folders of personal interests that are lifted out of `personal/` into `interests/<slug>/`. */
  liftedInterests: string[];
  /** A workstation that can run the merge (the audience of the organization vault). */
  workstationAvailable: boolean;
}
export interface NoPersonalPlan {
  /** The migration is recorded as complete and no organization has a step left. */
  alreadyDone: boolean;
  /** The migration is recorded (it may still have steps left for an organization that was not ready). */
  hasRun?: boolean;
  orgs: NoPersonalOrgPlan[];
}
export interface NoPersonalOrgReport {
  orgId: string;
  ranked: number;
  personalProjects: number;
  vault: 'none' | 'merged' | 'promoted' | 'retired' | 'waiting';
  liftedInterests: number;
  warnings: string[];
}
export interface NoPersonalReport {
  dryRun: boolean;
  plan: NoPersonalPlan;
  orgs: NoPersonalOrgReport[];
}

const stepName = (step: 'rank' | 'vault', orgId: string) => `${NO_PERSONAL_MIGRATION}/${step}/${orgId}`;

async function stepDone(db: Queryable, step: 'rank' | 'vault', orgId: string): Promise<boolean> {
  return Boolean(await one(db, 'SELECT 1 FROM data_migrations WHERE name=$1', [stepName(step, orgId)]));
}

async function markStep(env: DataMigrationEnv, db: Queryable, step: 'rank' | 'vault', orgId: string) {
  await exec(
    db,
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,'{}') ON CONFLICT (name) DO NOTHING`,
    [stepName(step, orgId), env.clock.now()],
  );
}

async function hasSnapshot(db: Queryable): Promise<boolean> {
  return Boolean(
    (await one<{ t: string | null }>(db, `SELECT to_regclass('legacy_project_domains') AS t`))?.t,
  );
}

/** The projects of the organization in the order the migration ranks them. */
async function rankedProjects(db: Queryable, orgId: string): Promise<Row[]> {
  return rows(
    db,
    `SELECT p.id, p.key, p.name, p.status, p.rank, p.vault_folder, p.vault_dir,
            COALESCE(l.domain, 'work') AS domain, COALESCE(l.priority_tier, 2) AS tier,
            EXISTS (SELECT 1 FROM vaults v WHERE v.project_id = p.id) AS has_vault
       FROM projects p LEFT JOIN legacy_project_domains l ON l.project_id = p.id
      WHERE p.org_id = $1 AND p.kind = 'project'
      ORDER BY (p.status = 'active') DESC,
               -- a project created after migration 1322 has no snapshot row: it is already ranked, and stays below
               (l.project_id IS NOT NULL) DESC, (COALESCE(l.domain, 'work') = 'work') DESC,
               COALESCE(l.priority_tier, 2), p.created_at, p.id`,
    [orgId],
  );
}

/** Slugs of the interests whose backing project was personal. */
async function personalInterestDirs(db: Queryable, orgId: string): Promise<string[]> {
  const r = await rows<{ slug: string }>(
    db,
    `SELECT i.slug FROM interests i JOIN legacy_project_domains l ON l.project_id = i.project_id
      WHERE i.org_id = $1 AND l.domain = 'personal' AND i.slug IS NOT NULL ORDER BY i.slug`,
    [orgId],
  );
  return r.map((x) => interestVaultDir(x.slug));
}

/** Both vaults use one git remote (scp, ssh://, https://, `.git`, trailing slash and case differences ignored). */
const sameRepository = (a: Row | null, b: Row | null): boolean =>
  Boolean(a && b && normalizeRemoteUrl(String(a.remote_url)) === normalizeRemoteUrl(String(b.remote_url)));

const vaultsOf = async (db: Queryable, orgId: string) => ({
  org: await one(db, `SELECT * FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`, [orgId]),
  personal: await one(db, `SELECT * FROM vaults WHERE org_id=$1 AND kind='personal' AND project_id IS NULL`, [
    orgId,
  ]),
});

/** What the migration would do, read only (the `--dry-run` of the CLI). */
export async function planNoPersonal(db: Queryable): Promise<NoPersonalPlan> {
  if (!(await hasSnapshot(db))) return { alreadyDone: false, orgs: [] };
  const done = await one(db, 'SELECT 1 FROM data_migrations WHERE name=$1', [NO_PERSONAL_MIGRATION]);
  const orgs: NoPersonalOrgPlan[] = [];
  // Only organizations that existed when migration 1322 took its snapshot (or still hold a personal vault): the
  // ranking of an organization created later is its owner's.
  for (const o of await rows(
    db,
    `SELECT o.id, o.name FROM organizations o
      WHERE EXISTS (SELECT 1 FROM legacy_project_domains l WHERE l.org_id = o.id)
         OR EXISTS (SELECT 1 FROM vaults v WHERE v.org_id = o.id AND v.kind = 'personal')
      ORDER BY o.created_at, o.id`,
  )) {
    const rankPending = !(await stepDone(db, 'rank', o.id));
    const vaultPending = !(await stepDone(db, 'vault', o.id));
    const vaults = await vaultsOf(db, o.id);
    const projects = await rankedProjects(db, o.id);
    const action: NoPersonalOrgPlan['vaultAction'] =
      vaultPending && vaults.personal
        ? vaults.org
          ? sameRepository(vaults.org, vaults.personal)
            ? 'retire'
            : 'merge'
          : 'promote'
        : 'none';
    const plan: NoPersonalOrgPlan = {
      orgId: o.id,
      name: o.name,
      rankPending,
      projects: projects.map((p, i) => ({
        key: p.key,
        name: p.name,
        status: p.status,
        domain: p.domain,
        tier: Number(p.tier),
        currentRank: p.rank ?? null,
        newRank: i + 1,
        vaultDir:
          action === 'merge' && p.domain === 'personal' && !p.has_vault
            ? {
                from: projectVaultFolder({ key: p.key, vaultFolder: p.vault_folder, vaultDir: p.vault_dir }),
                to: `personal/${projectVaultFolder({ key: p.key, vaultFolder: p.vault_folder, vaultDir: p.vault_dir })}`,
              }
            : null,
      })),
      vaultPending,
      vaultAction: action,
      personalVault: vaults.personal
        ? { name: vaults.personal.name, remoteUrl: vaults.personal.remote_url }
        : null,
      liftedInterests: action === 'merge' ? await personalInterestDirs(db, o.id) : [],
      workstationAvailable: vaults.org
        ? (await chooseVaultWriteTarget(db, vaults.org as never)) !== null
        : false,
    };
    if (rankPending || vaultPending) orgs.push(plan);
  }
  const pending = orgs.filter((o) => o.projects.length > 0 || o.vaultAction !== 'none');
  // Done: recorded, and nothing left to do (an organization whose vault step waits for a workstation is not done).
  return { alreadyDone: Boolean(done) && pending.length === 0, hasRun: Boolean(done), orgs: pending };
}

export function formatNoPersonalPlan(r: NoPersonalPlan): string {
  const lines = [
    r.alreadyDone
      ? `${NO_PERSONAL_MIGRATION} has already run.`
      : r.hasRun
        ? `${NO_PERSONAL_MIGRATION} has run, but some organizations still have steps left:`
        : `${NO_PERSONAL_MIGRATION} has not run yet.`,
  ];
  if (r.orgs.length === 0) lines.push('No organization has projects to rank or a personal vault to merge.');
  for (const o of r.orgs) {
    lines.push(`Organization ${o.name} (${o.orgId}):`);
    if (o.rankPending && o.projects.length) {
      lines.push('  project ranking (work before personal, then the old priority tier, then age):');
      for (const p of o.projects)
        lines.push(
          `    ${String(p.newRank).padStart(2)}. ${p.key} "${p.name}" (${p.domain}, tier ${p.tier}${p.status === 'active' ? '' : `, ${p.status}`})${p.currentRank === p.newRank ? '' : ` was ${p.currentRank ?? 'unranked'}`}`,
        );
    } else if (!o.rankPending) lines.push('  project ranking: already done.');
    if (o.vaultAction === 'merge') {
      lines.push(
        `  personal vault "${o.personalVault?.name}" is merged into the organization vault under personal/ (vault.merge, ${o.workstationAvailable ? 'queued for a workstation of the Owner or an Admin' : 'NO workstation available: this step waits until one is paired'}); the old repository is not changed`,
      );
      for (const d of o.liftedInterests) lines.push(`    interest folder ${d} is kept at ${d}`);
      for (const p of o.projects.filter((x) => x.vaultDir))
        lines.push(`    project ${p.key}: folder ${p.vaultDir?.from} -> ${p.vaultDir?.to}`);
    } else if (o.vaultAction === 'retire')
      lines.push(
        `  personal vault "${o.personalVault?.name}" uses the same repository as the organization vault: nothing to move; the personal vault registration is retired (no vault.merge is queued, project and interest folders keep their paths)`,
      );
    else if (o.vaultAction === 'promote')
      lines.push(
        `  personal vault "${o.personalVault?.name}" becomes the organization vault (the organization had none); no files move`,
      );
    else if (o.vaultPending) lines.push('  no personal vault: nothing to merge');
    else lines.push('  vault merge: already done.');
  }
  return lines.join('\n');
}

interface OrgRun {
  env: DataMigrationEnv;
  orgId: string;
  report: NoPersonalOrgReport;
}

async function migrateOrg(tx: Tx, run: OrgRun): Promise<void> {
  const { env, orgId, report } = run;
  const org = await one(tx, 'SELECT id, owner_user_id FROM organizations WHERE id=$1', [orgId]);
  if (!org) return;
  const events: AppendInput[] = [];
  const notes: string[] = [];
  const commands: Array<() => Promise<unknown>> = [];

  // 1. The ranking.
  if (!(await stepDone(tx, 'rank', orgId))) {
    const projects = await rankedProjects(tx, orgId);
    if (projects.length > 0) {
      events.push({
        streamId: streamId.org(orgId),
        event: {
          type: 'ProjectsRanked',
          payload: { orgId, projectIds: projects.map((p) => p.id), reason: 'migration' },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(orgId),
      });
      report.ranked = projects.length;
      report.personalProjects = projects.filter((p) => p.domain === 'personal').length;
      const personal = projects.filter((p) => p.domain === 'personal');
      notes.push(
        personal.length
          ? `Projects are ranked now, in the order the dispatcher used to apply. ${personal.length} personal project${personal.length === 1 ? '' : 's'} (${personal.map((p) => p.key).join(', ')}) ${personal.length === 1 ? 'was' : 'were'} placed below your work projects, keeping their relative priority. Reorder them with drag and drop on the Projects page.`
          : 'Projects are ranked now: the old priority tiers became an order (the Projects page lets you change it with drag and drop, or with the move up and down buttons).',
      );
    }
    await markStep(env, tx, 'rank', orgId);
  }

  // 2. The vault.
  if (!(await stepDone(tx, 'vault', orgId))) {
    const vaults = await vaultsOf(tx, orgId);
    if (!vaults.personal) {
      await markStep(env, tx, 'vault', orgId);
    } else if (!vaults.org) {
      events.push({
        streamId: streamId.vault(vaults.personal.id),
        event: {
          type: 'VaultMerged',
          payload: { vaultId: vaults.personal.id, orgId, intoVaultId: null, folder: '.' },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(orgId),
      });
      report.vault = 'promoted';
      notes.push(
        'There are no personal vaults any more. Your organization had no organization vault, so the personal vault became it: nothing moved.',
      );
      await markStep(env, tx, 'vault', orgId);
    } else if (sameRepository(vaults.org, vaults.personal)) {
      // One repository behind both vaults: copying it into itself would duplicate every file. Retire the registration only.
      events.push({
        streamId: streamId.vault(vaults.personal.id),
        event: {
          type: 'VaultMerged',
          payload: {
            vaultId: vaults.personal.id,
            orgId,
            intoVaultId: vaults.org.id,
            folder: '.',
            sameRepository: true,
          },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(orgId),
      });
      report.vault = 'retired';
      notes.push(
        'There are no personal vaults any more. Your personal vault used the same repository as your organization vault, so nothing was moved or copied: the personal vault registration was simply retired, and your projects and interests keep their folders.',
      );
      await markStep(env, tx, 'vault', orgId);
    } else {
      const target = await chooseVaultWriteTarget(tx, vaults.org as never);
      if (!target) {
        report.vault = 'waiting';
        report.warnings.push(
          'the personal vault could not be merged yet: no workstation of the Owner or an Admin exists. Pair one and run the migration again (ranking:migrate).',
        );
      } else {
        const lift = await personalInterestDirs(tx, orgId);
        events.push({
          streamId: streamId.vault(vaults.personal.id),
          event: {
            type: 'VaultMerged',
            payload: { vaultId: vaults.personal.id, orgId, intoVaultId: vaults.org.id, folder: 'personal' },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(orgId),
        });
        const personalProjects = (await rankedProjects(tx, orgId)).filter(
          (p) => p.domain === 'personal' && !p.has_vault,
        );
        for (const p of personalProjects) {
          const folder = projectVaultFolder({
            key: p.key,
            vaultFolder: p.vault_folder,
            vaultDir: p.vault_dir,
          });
          events.push({
            streamId: streamId.project(p.id),
            event: {
              type: 'ProjectVaultDirSet',
              payload: { projectId: p.id, vaultDir: `personal/${folder}` },
            },
            actor: SYSTEM_ACTOR,
            scope: orgScope(orgId),
          });
        }
        commands.push(() =>
          enqueueRunnerCommand(tx, target, 'vault.merge', {
            vaultId: vaults.org?.id,
            from: { vaultId: vaults.personal?.id, remoteUrl: vaults.personal?.remote_url },
            into: 'personal',
            lift,
            commitMessage: 'merge the personal vault into the organization vault',
            push: true,
          }),
        );
        report.vault = 'merged';
        report.liftedInterests = lift.length;
        notes.push(
          `There are no personal vaults any more. The files of your personal vault are being merged into the organization vault under personal/${lift.length ? `, except the interest folders (${lift.join(', ')}), which stay where interests live` : ''}. Keep a workstation online: the merge runs there, and until it has finished agents read an empty personal/ folder. The old repository is not changed, so it stays as a backup.`,
        );
        await markStep(env, tx, 'vault', orgId);
      }
    }
  }

  if (events.length === 0) return;
  if (notes.length > 0) {
    const deskItemId = randomUUID();
    events.push({
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: 'no_personal_migrated',
          title: 'Projects are ranked now, and personal is gone',
          body: notes.join('\n\n'),
          options: [],
          blocking: false,
          pinned: false,
          affectedCardIds: [],
          askedBy: { kind: 'system' },
          addresseeUserId: org.owner_user_id,
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(orgId),
    });
  }
  await env.store.append(events, { tx });
  for (const c of commands) await c();
}

/**
 * Runs the migration (or, with `dryRun`, only reports what it would do). Safe to run again: a step that is recorded in
 * `data_migrations` is skipped, and the completion of the whole migration is recorded once every organization is done.
 */
export async function migrateNoPersonal(
  env: DataMigrationEnv,
  opts: { dryRun?: boolean } = {},
): Promise<NoPersonalReport> {
  const { pool, log } = env;
  const plan = await planNoPersonal(pool);
  if (opts.dryRun || !(await hasSnapshot(pool))) return { dryRun: true, plan, orgs: [] };

  const lock = await pool.connect();
  const reports: NoPersonalOrgReport[] = [];
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    for (const o of plan.orgs) {
      const report: NoPersonalOrgReport = {
        orgId: o.orgId,
        ranked: 0,
        personalProjects: 0,
        vault: 'none',
        liftedInterests: 0,
        warnings: [],
      };
      try {
        await withAppendTx(pool, (tx) => migrateOrg(tx, { env, orgId: o.orgId, report }));
      } catch (err) {
        report.warnings.push(
          `the organization was not migrated: ${err instanceof Error ? err.message : String(err)}`,
        );
        log(`${NO_PERSONAL_MIGRATION}: organization ${o.orgId} failed: ${String(err)}`);
      }
      reports.push(report);
    }
    const pending = reports.some((r) => r.warnings.length > 0);
    if (!pending)
      await exec(
        pool,
        `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3)
         ON CONFLICT (name) DO UPDATE SET completed_at=EXCLUDED.completed_at, summary=EXCLUDED.summary`,
        [NO_PERSONAL_MIGRATION, env.clock.now(), JSON.stringify({ orgs: reports })],
      );
    log(
      `${NO_PERSONAL_MIGRATION}: ${reports.reduce((n, r) => n + r.ranked, 0)} project(s) ranked, ${reports.filter((r) => r.vault === 'merged' || r.vault === 'promoted' || r.vault === 'retired').length} personal vault(s) handled${pending ? ' (some steps are waiting, see the warnings)' : ''}`,
    );
  } finally {
    try {
      await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    } finally {
      lock.release();
    }
  }
  return { dryRun: false, plan, orgs: reports };
}
