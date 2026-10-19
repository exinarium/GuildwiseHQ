import { randomUUID } from 'node:crypto';
import { NO_LIMITS, streamId } from '@aom/shared';
import type { Clock } from '../clock.ts';
import type { Pool } from '../db/pool.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { PgEventStore } from '../eventstore/pg-event-store.ts';

export const ORGS_MIGRATION = 'orgs-2026-10';

/** push_prefs.org_id sentinel for "all organizations" (see push/prefs.ts ALL_ORGS): never an organization or a user. */
const NIL_ORG_ID = '00000000-0000-0000-0000-000000000000';

export interface DataMigrationEnv {
  pool: Pool;
  store: PgEventStore;
  clock: Clock;
  log: (msg: string) => void;
  /** `AOM_INBOUND_DOMAIN`, for the data migration that gives every organisation an inbox. */
  inboundDomain?: string | undefined;
  /** `projectGraphs.enabled`: false skips the project-vaults data migration (it runs once the setting is on). */
  projectGraphs?: boolean | undefined;
}

export interface OrgMigrationPlan {
  /** Users that get an organization of their own (`org.id = user.id`). */
  orgs: Array<{
    userId: string;
    email: string;
    name: string;
    /** How many rows of org data refer to this user as their organization (0: an empty organization). */
    dataRows: number;
    legacyAdmin: boolean;
  }>;
  /** Users with active access to a project of an organization they will not be a member of: guests after the migration. */
  guests: Array<{ userId: string; email: string; projectKey: string; orgUserId: string }>;
  /** Constraints that will be validated. */
  constraints: Array<{ table: string; name: string }>;
  alreadyDone: boolean;
}

export interface OrgMigrationReport extends OrgMigrationPlan {
  dryRun: boolean;
  created: number;
  validated: number;
}

const orgName = (displayName: string) => `${displayName.trim() || 'My'}'s organization`.slice(0, 120);

const hasSchema = async (db: Queryable): Promise<boolean> =>
  Boolean((await one<{ t: string | null }>(db, `SELECT to_regclass('organizations') AS t`))?.t);

/** Tables with an `org_id` column that holds an organization (the user id before the migration). */
async function orgDataTables(db: Queryable): Promise<string[]> {
  const r = await rows<{ t: string }>(
    db,
    `SELECT c.table_name AS t FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema() AND c.column_name = 'org_id' AND t.table_type = 'BASE TABLE'
        AND c.table_name NOT IN ('organizations','platform_audit_log','invitations',
          -- push_prefs.org_id holds the ALL_ORGS nil-UUID sentinel ("every organization"), not an organization
          'push_prefs')
      ORDER BY 1`,
  );
  return r.map((x) => `"${x.t}"`);
}

/** The foreign keys that were re-pointed at `organizations` (migration 1311), with their validation state. */
async function orgTables(db: Queryable): Promise<Array<{ table: string; name: string; validated: boolean }>> {
  if (!(await hasSchema(db))) return [];
  const r = await rows<{ tbl: string; name: string; validated: boolean }>(
    db,
    `SELECT con.conrelid::regclass::text AS tbl, con.conname AS name, con.convalidated AS validated
       FROM pg_constraint con
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
      WHERE con.contype = 'f' AND con.confrelid = 'organizations'::regclass AND att.attname = 'org_id'
        AND con.connamespace = current_schema()::regnamespace
      ORDER BY 1`,
  );
  return r.map((x) => ({ table: x.tbl, name: x.name, validated: x.validated }));
}

/** Everything that is an `org_id` value today but not an organization yet. */
async function orgIdsInUse(db: Queryable, tables: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const sources = [
    ...tables.map((t) => `SELECT org_id, count(*) AS n FROM ${t} WHERE org_id IS NOT NULL GROUP BY org_id`),
  ];
  sources.push('SELECT org_id, count(*) AS n FROM events WHERE org_id IS NOT NULL GROUP BY org_id');
  for (const sql of sources) {
    for (const r of await rows<{ org_id: string; n: string }>(db, sql)) {
      if (r.org_id === NIL_ORG_ID) continue; // the ALL_ORGS sentinel is not an org_id in use
      counts.set(r.org_id, (counts.get(r.org_id) ?? 0) + Number(r.n));
    }
  }
  return counts;
}

export async function planOrgMigration(db: Queryable): Promise<OrgMigrationPlan> {
  const schema = await hasSchema(db);
  const done = schema
    ? await one(db, 'SELECT 1 FROM data_migrations WHERE name=$1', [ORGS_MIGRATION])
    : undefined;
  const constraints = await orgTables(db);
  const inUse = await orgIdsInUse(db, await orgDataTables(db));
  const existing = schema
    ? new Set((await rows<{ id: string }>(db, 'SELECT id FROM organizations')).map((r) => r.id))
    : new Set<string>();
  // Before the schema migration (a dry run against an older database) users have `role`, not `kind`/`legacy_role`.
  const users = schema
    ? await rows<{
        id: string;
        email: string;
        display_name: string;
        kind: string;
        legacy_role: string | null;
      }>(db, 'SELECT id, email, display_name, kind, legacy_role FROM users ORDER BY created_at, id')
    : await rows<{
        id: string;
        email: string;
        display_name: string;
        kind: string;
        legacy_role: string | null;
      }>(
        db,
        `SELECT id, email, display_name, 'user' AS kind, role AS legacy_role FROM users ORDER BY created_at, id`,
      );
  const byId = new Map(users.map((u) => [u.id, u]));
  const members = schema
    ? new Set(
        (await rows<{ user_id: string }>(db, `SELECT user_id FROM org_members WHERE status='active'`)).map(
          (r) => r.user_id,
        ),
      )
    : new Set<string>();
  // Every org id in use must be a user (the legacy rule: the organization of a user is that user).
  const unknown = [...inUse.keys()].filter((id) => !existing.has(id) && !byId.has(id));
  if (unknown.length)
    throw new Error(
      `orgs migration aborted: org_id values that are neither an organization nor a user: ${unknown.join(', ')}`,
    );
  const orgs: OrgMigrationPlan['orgs'] = [];
  for (const u of users) {
    if (u.kind === 'super_admin') continue;
    if (existing.has(u.id)) continue;
    // Someone who already belongs to an organization (created after the upgrade) needs nothing.
    if (members.has(u.id)) continue;
    orgs.push({
      userId: u.id,
      email: u.email,
      name: orgName(u.display_name),
      dataRows: inUse.get(u.id) ?? 0,
      legacyAdmin: u.legacy_role === 'admin',
    });
  }
  for (const id of inUse.keys()) {
    if (!existing.has(id) && !orgs.some((o) => o.userId === id)) {
      const u = byId.get(id);
      if (u?.kind === 'super_admin')
        throw new Error(`orgs migration aborted: a super admin (${id}) owns org data`);
    }
  }
  const migrated = new Set([...existing, ...orgs.map((o) => o.userId)]);
  const guests = (
    await rows<{ user_id: string; email: string; key: string; org_id: string }>(
      db,
      `SELECT pm.user_id, u.email, p.key, p.org_id FROM project_members pm
         JOIN projects p ON p.id = pm.project_id JOIN users u ON u.id = pm.user_id
        WHERE pm.status = 'active' AND pm.user_id <> p.org_id ORDER BY p.key`,
    )
  )
    .filter((g) => migrated.has(g.org_id))
    .map((g) => ({ userId: g.user_id, email: g.email, projectKey: g.key, orgUserId: g.org_id }));
  return {
    orgs,
    guests,
    constraints: constraints.filter((c) => !c.validated).map((c) => ({ table: c.table, name: c.name })),
    alreadyDone: Boolean(done),
  };
}

/**
 * Every user becomes the Owner of an organization with the same id (docs/design/organizations.md section 2.3 and owner
 * decisions 2/3 and 14): no `org_id` column, event or vault path is rewritten. Idempotent (an organization that exists
 * is skipped) and safe to re-run; it appends `OrganizationCreated` + `OrgMemberAdded` per organization (so a projection
 * rebuild reproduces it), one desk notice per organization, then validates the re-pointed foreign keys and records itself.
 */
export async function migrateOrgs(
  env: DataMigrationEnv,
  opts: { dryRun?: boolean } = {},
): Promise<OrgMigrationReport> {
  const { pool, store, log } = env;
  const plan = await planOrgMigration(pool);
  if (opts.dryRun) return { ...plan, dryRun: true, created: 0, validated: 0 };

  let created = 0;
  for (const o of plan.orgs) {
    const did = await withAppendTx(pool, async (tx) => {
      // Re-check inside the lock: a concurrent boot or a user created meanwhile must not get two organizations.
      if (await one(tx, 'SELECT 1 FROM organizations WHERE id=$1', [o.userId])) return false;
      if (await one(tx, `SELECT 1 FROM org_members WHERE user_id=$1 AND status='active'`, [o.userId]))
        return false;
      const deskItemId = randomUUID();
      const scope = { orgId: o.userId, projectId: null, audience: 'org' } as const;
      const actor = { kind: 'system', id: null } as const;
      const text = o.legacyAdmin
        ? ' It replaces the old administrator role: run "superadmin:create" on the server to manage accounts and organizations.'
        : '';
      await store.append(
        [
          {
            streamId: streamId.org(o.userId),
            event: {
              type: 'OrganizationCreated',
              payload: {
                orgId: o.userId,
                name: o.name,
                ownerUserId: o.userId,
                plan: 'founding',
                status: 'active',
                limits: NO_LIMITS,
                features: {},
                createdVia: 'legacy_migration',
              },
            },
            actor,
            scope,
          },
          {
            streamId: streamId.org(o.userId),
            event: {
              type: 'OrgMemberAdded',
              payload: { orgId: o.userId, userId: o.userId, role: 'owner', via: 'migration' },
            },
            actor,
            scope,
          },
          {
            streamId: streamId.desk(deskItemId),
            event: {
              type: 'DeskItemCreated',
              payload: {
                deskItemId,
                kind: 'alert',
                subkind: 'org_migrated',
                title: `Your workspace is now the organization '${o.name}'`,
                body: `You are its Owner. Rename it in Settings > Organization, and invite colleagues as members from there.${text}`,
                options: [],
                blocking: false,
                pinned: false,
                affectedCardIds: [],
                askedBy: { kind: 'system' },
                addresseeUserId: o.userId,
              },
            },
            actor,
            scope,
          },
        ],
        { tx },
      );
      return true;
    });
    if (did) created++;
  }

  // Validate the re-pointed foreign keys (last step: a crash before it leaves the migration pending and re-runnable).
  let validated = 0;
  for (const c of await orgTables(pool)) {
    if (c.validated) continue;
    await exec(pool, `ALTER TABLE ${c.table} VALIDATE CONSTRAINT "${c.name}"`);
    validated++;
  }
  await exec(
    pool,
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3)
     ON CONFLICT (name) DO UPDATE SET completed_at=EXCLUDED.completed_at, summary=EXCLUDED.summary`,
    [ORGS_MIGRATION, env.clock.now(), JSON.stringify({ created, validated, guests: plan.guests.length })],
  );
  log(
    `orgs-2026-10: ${created} organization(s) created, ${validated} constraint(s) validated, ${plan.guests.length} guest access row(s) found`,
  );
  return { ...plan, dryRun: false, created, validated };
}

export function formatPlan(r: OrgMigrationPlan & { dryRun?: boolean }): string {
  const lines: string[] = [];
  lines.push(r.alreadyDone ? 'orgs-2026-10 has already run.' : 'orgs-2026-10 has not run yet.');
  lines.push(
    `${r.orgs.length} organization(s) to create (organization id = user id, the user becomes its Owner):`,
  );
  for (const o of r.orgs)
    lines.push(
      `  - ${o.email}: "${o.name}", ${o.dataRows} row(s) of org data${o.legacyAdmin ? ', legacy administrator' : ''}`,
    );
  lines.push(`${r.guests.length} guest access row(s) (a user on a project of another user's organization):`);
  for (const g of r.guests)
    lines.push(`  - ${g.email} on ${g.projectKey} (organization of user ${g.orgUserId})`);
  lines.push(
    `${r.constraints.length} foreign key(s) to validate: ${r.constraints.map((c) => `${c.table}.${c.name}`).join(', ') || 'none'}`,
  );
  return lines.join('\n');
}
