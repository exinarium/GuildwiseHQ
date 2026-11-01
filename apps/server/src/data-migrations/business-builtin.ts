import { BUSINESS_WORKFLOW_KEY, BUSINESS_WORKFLOWS, streamId, WorkflowDefinitionSchema } from '@aom/shared';
import { orgScope, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { exec, one, rows as selectRows } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `business-builtin-2026-11`: release 1.4.0 installed the six business workflows as per-organization custom workflows;
 * they are now true built-ins (org_id NULL, registered at boot). For every organization-scoped row with a reserved
 * `business-*` key:
 *  - UNEDITED (one version, the shipped one, definition equal to the shipped definition): the organization copy is
 *    deactivated (`WorkflowVersionDeactivated`: status superseded), so key lookups fall through to the built-in. Cards in
 *    flight stay pinned to the deactivated row and finish on it; projects keep their key and now use the built-in.
 *  - EDITED (any other version, a changed definition, a draft, or an organization's own workflow that used the key): the
 *    versions are kept and given a free key `<key>-custom` and the name "<name> (edited)" (`WorkflowKeyChanged`, the
 *    versions keep their ids, so pinned cards follow). Projects that used the key are repointed to the new key
 *    (`ProjectPrimaryWorkflowChanged` for a primary, `ProjectWorkflowsSet` for the enabled set), with their default card types.
 * One append per organization and key, so a failure leaves nothing half done. Recorded once in `data_migrations`, under an
 * advisory lock; idempotent (a second run finds no active reserved-key organization row); a projection rebuild
 * reproduces the result, it is all events. `AOM_DATA_MIGRATIONS=false` skips it.
 */
export const BUSINESS_BUILTIN_MIGRATION = 'business-builtin-2026-11';
const LOCK_ID = 7337;

export interface BusinessBuiltinReport {
  retired: Array<{ orgId: string; key: string }>;
  converted: Array<{ orgId: string; key: string; to: string; projects: number }>;
}

const RESERVED: readonly string[] = Object.values(BUSINESS_WORKFLOW_KEY);

/** The definition as the 1.4.0 copies were stored: the shipped one, not built in. */
const shippedAsCopy = (key: string): string | null => {
  const def = BUSINESS_WORKFLOWS.find((w) => w.key === key);
  return def ? JSON.stringify(WorkflowDefinitionSchema.parse({ ...def, builtIn: false })) : null;
};

interface WfRow {
  id: string;
  org_id: string;
  key: string;
  version: number;
  status: string;
  name: string;
  definition: unknown;
  project_id: string | null;
}

function isUnedited(group: WfRow[]): boolean {
  const [only] = group;
  if (group.length !== 1 || !only) return false;
  const shipped = BUSINESS_WORKFLOWS.find((w) => w.key === only.key);
  if (!shipped || only.version !== shipped.version || only.project_id) return false;
  const parsed = WorkflowDefinitionSchema.safeParse(only.definition);
  // jsonb does not keep key order: compare the schema-normalised forms.
  return parsed.success && JSON.stringify(parsed.data) === shippedAsCopy(only.key);
}

export async function migrateBusinessBuiltin(env: DataMigrationEnv): Promise<BusinessBuiltinReport | null> {
  const { pool, store, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [BUSINESS_BUILTIN_MIGRATION]))
    return null;
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [BUSINESS_BUILTIN_MIGRATION]))
      return null;
    const report: BusinessBuiltinReport = { retired: [], converted: [] };
    const found = await selectRows<WfRow>(
      pool,
      `SELECT id, org_id, key, version, status, name, definition, project_id FROM workflow_versions
        WHERE org_id IS NOT NULL AND key = ANY($1::text[]) ORDER BY org_id, key, version`,
      [RESERVED],
    );
    const groups = new Map<string, WfRow[]>();
    for (const r of found)
      groups.set(`${r.org_id}/${r.key}`, [...(groups.get(`${r.org_id}/${r.key}`) ?? []), r]);

    for (const group of groups.values()) {
      const first = group[0] as WfRow;
      const { org_id: orgId, key } = first;
      const events: AppendInput[] = [];
      if (isUnedited(group)) {
        for (const r of group.filter((x) => x.status === 'active'))
          events.push({
            streamId: streamId.workflow(orgId, key),
            event: {
              type: 'WorkflowVersionDeactivated',
              payload: {
                workflowVersionId: r.id,
                reason: `${key} is a built-in workflow now; cards in flight finish on this version`,
              },
            },
            actor: SYSTEM_ACTOR,
            scope: orgScope(orgId),
          });
        if (!events.length) continue;
        await store.append(events);
        report.retired.push({ orgId, key });
        log(
          `${BUSINESS_BUILTIN_MIGRATION}: ${orgId} ${key}: unedited copy retired (the built-in takes over)`,
        );
        continue;
      }

      // Edited (or somebody's own workflow with the reserved key): keep it under a free key.
      const taken = new Set(
        (
          await selectRows<{ key: string }>(
            pool,
            'SELECT DISTINCT key FROM workflow_versions WHERE org_id=$1',
            [orgId],
          )
        ).map((r) => r.key),
      );
      let toKey = `${key}-custom`;
      for (let n = 2; taken.has(toKey); n++) toKey = `${key}-custom-${n}`;
      const newest = group[group.length - 1] as WfRow;
      const base = newest.name.replace(/\s*\(edited\)$/, '');
      const name = `${base} (edited)`;
      events.push({
        streamId: streamId.workflow(orgId, key),
        event: {
          type: 'WorkflowKeyChanged',
          payload: {
            orgId,
            fromKey: key,
            toKey,
            name,
            reason: `${key} is a built-in workflow now; this edited copy of the organization stays as ${toKey}`,
          },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(orgId),
      });

      // Projects that used the key move to the new one, keeping their default card types.
      const projects = await selectRows<{ id: string; created_by: string; workflow_key: string }>(
        pool,
        `SELECT DISTINCT p.id, p.created_by, p.workflow_key FROM projects p
           JOIN project_workflows pw ON pw.project_id = p.id
          WHERE p.org_id=$1 AND pw.workflow_key=$2 ORDER BY p.id`,
        [orgId, key],
      );
      for (const p of projects) {
        if (p.workflow_key === key)
          events.push({
            streamId: streamId.project(p.id),
            event: {
              type: 'ProjectPrimaryWorkflowChanged',
              payload: { projectId: p.id, from: key, to: toKey, by: p.created_by },
            },
            actor: SYSTEM_ACTOR,
            scope: projectScope(orgId, p.id),
          });
        const enabled = await selectRows<{ workflow_key: string; default_card_types: string[] | null }>(
          pool,
          `SELECT workflow_key, default_card_types FROM project_workflows WHERE project_id=$1
            ORDER BY is_primary DESC, enabled_at, workflow_key`,
          [p.id],
        );
        events.push({
          streamId: streamId.project(p.id),
          event: {
            type: 'ProjectWorkflowsSet',
            payload: {
              projectId: p.id,
              enabled: enabled.map((e) => ({
                workflowKey: e.workflow_key === key ? toKey : e.workflow_key,
                defaultCardTypes: e.default_card_types ?? [],
              })),
              by: p.created_by,
            },
          },
          actor: SYSTEM_ACTOR,
          scope: projectScope(orgId, p.id),
        });
      }
      await store.append(events);
      report.converted.push({ orgId, key, to: toKey, projects: projects.length });
      log(
        `${BUSINESS_BUILTIN_MIGRATION}: ${orgId} ${key}: edited copy kept as ${toKey} ("${name}"), ${projects.length} project(s) repointed`,
      );
    }
    await exec(
      pool,
      `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO NOTHING`,
      [BUSINESS_BUILTIN_MIGRATION, clock.now(), JSON.stringify(report)],
    );
    log(
      `${BUSINESS_BUILTIN_MIGRATION}: ${report.retired.length} unedited copy(ies) retired, ${report.converted.length} edited copy(ies) kept under a new key`,
    );
    return report;
  } finally {
    try {
      await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    } finally {
      lock.release();
    }
  }
}
