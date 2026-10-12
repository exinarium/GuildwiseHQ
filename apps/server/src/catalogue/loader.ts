import {
  type RoleDefinition,
  RoleDefinitionSchema,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from '@aom/shared';
import { one, type Queryable } from '../db/sql.ts';

export interface WorkflowVersionRow {
  id: string;
  orgId: string | null;
  key: string;
  version: number;
  definition: WorkflowDefinition;
  /** Set for a project variant: the only project whose cards may use it. */
  projectId: string | null;
}

// Versions are immutable once registered, so definitions can be cached forever by id.
const byId = new Map<string, WorkflowVersionRow>();

const toRow = (r: Record<string, any>): WorkflowVersionRow => {
  const row: WorkflowVersionRow = {
    id: r.id,
    orgId: r.org_id,
    key: r.key,
    version: r.version,
    definition: WorkflowDefinitionSchema.parse(r.definition),
    projectId: r.project_id ?? null,
  };
  byId.set(row.id, row);
  return row;
};

export async function loadWorkflowById(db: Queryable, id: string): Promise<WorkflowVersionRow | null> {
  const hit = byId.get(id);
  if (hit) return hit;
  const r = await one(
    db,
    'SELECT id, org_id, key, version, definition, project_id FROM workflow_versions WHERE id=$1',
    [id],
  );
  return r ? toRow(r) : null;
}

/**
 * Newest active version for `key`, preferring the org's own over the built-in. A project variant resolves only for its
 * own project (`projectId`); without a project, variants are never returned.
 */
export async function resolveWorkflow(
  db: Queryable,
  orgId: string,
  key: string,
  projectId?: string | null,
): Promise<WorkflowVersionRow | null> {
  const r = await one(
    db,
    `SELECT id, org_id, key, version, definition, project_id FROM workflow_versions
      WHERE key=$2 AND status='active' AND (org_id = $1 OR org_id IS NULL)
        AND (project_id IS NULL OR project_id = $3::uuid)
      ORDER BY (org_id IS NULL), version DESC LIMIT 1`,
    [orgId, key, projectId ?? null],
  );
  return r ? toRow(r) : null;
}

export interface RoleRow {
  id: string;
  orgId: string | null;
  key: string;
  version: number;
  definition: RoleDefinition;
}

export async function loadRole(
  db: Queryable,
  orgId: string,
  key: string,
  version?: number,
): Promise<RoleRow | null> {
  const r = await one(
    db,
    `SELECT id, org_id, key, version, definition FROM role_definitions
      WHERE key=$2 AND (org_id = $1 OR org_id IS NULL) AND ($3::int IS NULL OR version = $3)
        AND status IN ('active','superseded')
      ORDER BY (status = 'active') DESC, (org_id IS NULL), version DESC LIMIT 1`,
    [orgId, key, version ?? null],
  );
  if (!r) return null;
  return {
    id: r.id,
    orgId: r.org_id,
    key: r.key,
    version: r.version,
    definition: RoleDefinitionSchema.parse(r.definition),
  };
}
