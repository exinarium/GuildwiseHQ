import { definitionVaultPath, type EventOf, type WorkflowDefinition } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { Projector } from '../eventstore/types.ts';

async function insertStages(tx: Tx, workflowVersionId: string, stages: WorkflowDefinition['stages']) {
  for (const [i, s] of stages.entries()) {
    await exec(
      tx,
      `INSERT INTO workflow_stages (workflow_version_id, stage_id, ordinal, kind, claim_role, senior_only, column_key, fallback_role, environment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        workflowVersionId,
        s.id,
        i,
        s.kind,
        s.claimRole,
        s.seniorOnly,
        s.column,
        s.fallbackRole ?? null,
        s.environment ?? 'none',
      ],
    );
  }
}

export const catalogueProjectors: Record<string, Projector> = {
  WorkflowVersionRegistered: async (tx, e) => {
    const p = (e.event as EventOf<'WorkflowVersionRegistered'>).payload;
    await exec(
      tx,
      `INSERT INTO workflow_versions (id, org_id, key, version, name, department, definition, status, created_at, drafted_by_kind,
         project_id, base_key, base_version, variant_spec)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        p.workflowVersionId,
        p.orgId,
        p.key,
        p.version,
        p.name,
        p.department ?? null,
        JSON.stringify(p.definition),
        p.status,
        e.createdAt,
        p.draftedBy?.kind ?? null,
        p.projectId ?? null,
        p.definition.extends?.key ?? null,
        p.definition.extends?.version ?? null,
        p.variantSpec ? JSON.stringify(p.variantSpec) : null,
      ],
    );
    await insertStages(tx, p.workflowVersionId, p.definition.stages);
  },
  WorkflowDraftUpdated: async (tx, e) => {
    const p = (e.event as EventOf<'WorkflowDraftUpdated'>).payload;
    await exec(
      tx,
      `UPDATE workflow_versions SET name=$2, department=$3, definition=$4,
              base_key=$5, base_version=$6, variant_spec=COALESCE($7::jsonb, variant_spec)
        WHERE id=$1 AND status='draft'`,
      [
        p.workflowVersionId,
        p.name,
        p.department ?? null,
        JSON.stringify(p.definition),
        p.definition.extends?.key ?? null,
        p.definition.extends?.version ?? null,
        p.variantSpec ? JSON.stringify(p.variantSpec) : null,
      ],
    );
    await exec(tx, 'DELETE FROM workflow_stages WHERE workflow_version_id=$1', [p.workflowVersionId]);
    await insertStages(tx, p.workflowVersionId, p.definition.stages);
  },
  WorkflowVersionSubmitted: async (tx, e) => {
    const p = (e.event as EventOf<'WorkflowVersionSubmitted'>).payload;
    await exec(tx, `UPDATE workflow_versions SET status='pending_approval', desk_item_id=$2 WHERE id=$1`, [
      p.workflowVersionId,
      p.deskItemId,
    ]);
  },
  WorkflowVersionApproved: async (tx, e) => {
    const p = (e.event as EventOf<'WorkflowVersionApproved'>).payload;
    const wf = await one<{ org_id: string | null; key: string; version: number }>(
      tx,
      'SELECT org_id, key, version FROM workflow_versions WHERE id=$1',
      [p.workflowVersionId],
    );
    if (!wf) return;
    await exec(
      tx,
      `UPDATE workflow_versions SET status='superseded'
        WHERE key=$2 AND org_id IS NOT DISTINCT FROM $1 AND status='active' AND id <> $3`,
      [wf.org_id, wf.key, p.workflowVersionId],
    );
    await exec(
      tx,
      `UPDATE workflow_versions SET status='active',
              vault_path = CASE WHEN org_id IS NULL OR project_id IS NOT NULL THEN NULL ELSE $2 END WHERE id=$1`,
      [p.workflowVersionId, definitionVaultPath('workflow', wf.key, wf.version)],
    );
  },
  WorkflowVersionRejected: async (tx, e) => {
    const p = (e.event as EventOf<'WorkflowVersionRejected'>).payload;
    await exec(tx, `UPDATE workflow_versions SET status='rejected' WHERE id=$1`, [p.workflowVersionId]);
  },
  RoleVersionRegistered: async (tx, e) => {
    const p = (e.event as EventOf<'RoleVersionRegistered'>).payload;
    await exec(
      tx,
      `INSERT INTO role_definitions (id, org_id, key, version, definition, status, created_at, department, drafted_by_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        p.roleVersionId,
        p.orgId,
        p.key,
        p.version,
        JSON.stringify(p.definition),
        p.status,
        e.createdAt,
        p.definition.department ?? null,
        p.draftedBy?.kind ?? null,
      ],
    );
  },
  RoleDraftUpdated: async (tx, e) => {
    const p = (e.event as EventOf<'RoleDraftUpdated'>).payload;
    await exec(
      tx,
      `UPDATE role_definitions SET definition=$2, department=$3 WHERE id=$1 AND status='draft'`,
      [p.roleVersionId, JSON.stringify(p.definition), p.definition.department ?? null],
    );
  },
  RoleVersionSubmitted: async (tx, e) => {
    const p = (e.event as EventOf<'RoleVersionSubmitted'>).payload;
    await exec(tx, `UPDATE role_definitions SET status='pending_approval', desk_item_id=$2 WHERE id=$1`, [
      p.roleVersionId,
      p.deskItemId,
    ]);
  },
  DefinitionDraftDiscarded: async (tx, e) => {
    const p = (e.event as EventOf<'DefinitionDraftDiscarded'>).payload;
    if (p.kind === 'role') {
      await exec(tx, `DELETE FROM role_definitions WHERE id=$1 AND status IN ('draft','rejected')`, [
        p.versionId,
      ]);
    } else {
      await exec(
        tx,
        `DELETE FROM workflow_stages WHERE workflow_version_id=$1
           AND workflow_version_id IN (SELECT id FROM workflow_versions WHERE id=$1 AND status IN ('draft','rejected'))`,
        [p.versionId],
      );
      await exec(tx, `DELETE FROM workflow_versions WHERE id=$1 AND status IN ('draft','rejected')`, [
        p.versionId,
      ]);
    }
  },
  DepartmentCreated: async (tx, e) => {
    const p = (e.event as EventOf<'DepartmentCreated'>).payload;
    await exec(
      tx,
      `INSERT INTO departments (id, org_id, name, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [p.departmentId, p.orgId, p.name, e.createdAt],
    );
  },
  RoleVersionApproved: async (tx, e) => {
    const p = (e.event as EventOf<'RoleVersionApproved'>).payload;
    const r = await one<{ org_id: string | null; key: string; version: number }>(
      tx,
      'SELECT org_id, key, version FROM role_definitions WHERE id=$1',
      [p.roleVersionId],
    );
    if (!r) return;
    await exec(
      tx,
      `UPDATE role_definitions SET status='superseded'
        WHERE key=$2 AND org_id IS NOT DISTINCT FROM $1 AND status='active' AND id <> $3`,
      [r.org_id, r.key, p.roleVersionId],
    );
    await exec(
      tx,
      `UPDATE role_definitions SET status='active',
              vault_path = CASE WHEN org_id IS NULL THEN NULL ELSE $2 END WHERE id=$1`,
      [p.roleVersionId, definitionVaultPath('role', r.key, r.version)],
    );
  },
  RoleVersionRejected: async (tx, e) => {
    const p = (e.event as EventOf<'RoleVersionRejected'>).payload;
    await exec(tx, `UPDATE role_definitions SET status='rejected' WHERE id=$1`, [p.roleVersionId]);
  },
  RoleExtended: async (tx, e) => {
    const p = (e.event as EventOf<'RoleExtended'>).payload;
    await exec(
      tx,
      `INSERT INTO role_extensions (org_id, role_key, base_version, extensions, updated_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id, role_key) DO UPDATE
         SET base_version=EXCLUDED.base_version, extensions=EXCLUDED.extensions, updated_at=EXCLUDED.updated_at`,
      [p.orgId, p.roleKey, p.baseVersion, JSON.stringify(p.extensions), e.createdAt],
    );
  },
  RoleResetToDefault: async (tx, e) => {
    const p = (e.event as EventOf<'RoleResetToDefault'>).payload;
    await exec(tx, 'DELETE FROM role_extensions WHERE org_id=$1 AND role_key=$2', [p.orgId, p.roleKey]);
  },
};
