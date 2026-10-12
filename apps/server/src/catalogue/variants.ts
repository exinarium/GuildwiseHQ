import {
  type DefinitionIssue,
  type RoleDefinition,
  validateVariant,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  WorkflowVariantSpecSchema,
} from '@aom/shared';
import { one, type Queryable, type Row } from '../db/sql.ts';
import type { WorkflowVersionRow } from './loader.ts';
import { subworkflowLookupFor } from './subworkflow-lookup.ts';

/**
 * The exact base version a variant was authored on: an active or superseded, non-variant version of the key, from the
 * organization or built in.
 */
export async function loadBaseVersion(
  db: Queryable,
  orgId: string,
  key: string,
  version: number,
): Promise<WorkflowVersionRow | null> {
  const r = await one(
    db,
    `SELECT id, org_id, key, version, definition, project_id FROM workflow_versions
      WHERE key=$2 AND version=$3 AND project_id IS NULL AND status IN ('active','superseded')
        AND (org_id = $1 OR org_id IS NULL)
      ORDER BY (org_id IS NULL) LIMIT 1`,
    [orgId, key, version],
  );
  if (!r) return null;
  return {
    id: r.id,
    orgId: r.org_id,
    key: r.key,
    version: r.version,
    definition: WorkflowDefinitionSchema.parse(r.definition),
    projectId: null,
  };
}

/** Issues of a stored variant row (draft, submitted or being approved): re-validated from its insertions on its base. */
export async function variantIssues(
  db: Queryable,
  row: Row,
  roles: readonly RoleDefinition[],
  builtinWorkflowKeys: readonly string[],
): Promise<DefinitionIssue[]> {
  const spec = WorkflowVariantSpecSchema.safeParse(row.variant_spec);
  if (!spec.success)
    return [
      {
        severity: 'error',
        code: 'invalid_schema',
        message: 'the variant has no insertions on record',
        rule: 1,
      },
    ];
  const base = await loadBaseVersion(db, row.org_id, spec.data.base.key, spec.data.base.version);
  if (!base)
    return [
      {
        severity: 'error',
        code: 'variant_base_mismatch',
        message: `the base workflow ${spec.data.base.key} v${spec.data.base.version} no longer exists`,
        rule: 0,
      },
    ];
  const v = validateVariant(
    spec.data,
    base.definition,
    roles,
    {
      builtinWorkflowKeys,
      subworkflowLookup: await subworkflowLookupFor(db, row.org_id, base.definition, row.project_id),
    },
    { version: row.version, stored: row.definition as WorkflowDefinition },
  );
  return v.issues.map((i) => ({ ...i }));
}
