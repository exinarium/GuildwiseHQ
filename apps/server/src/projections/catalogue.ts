import type { EventOf } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

export const catalogueProjectors: Record<string, Projector> = {
  WorkflowVersionRegistered: async (tx, e) => {
    const p = (e.event as EventOf<'WorkflowVersionRegistered'>).payload;
    await exec(
      tx,
      `INSERT INTO workflow_versions (id, org_id, key, version, name, department, definition, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
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
      ],
    );
    for (const [i, s] of p.definition.stages.entries()) {
      await exec(
        tx,
        `INSERT INTO workflow_stages (workflow_version_id, stage_id, ordinal, kind, claim_role, senior_only, column_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [p.workflowVersionId, s.id, i, s.kind, s.claimRole, s.seniorOnly, s.column],
      );
    }
  },
  WorkflowVersionApproved: async (tx, e) => {
    const p = (e.event as EventOf<'WorkflowVersionApproved'>).payload;
    const wf = await one<{ org_id: string | null; key: string }>(
      tx,
      'SELECT org_id, key FROM workflow_versions WHERE id=$1',
      [p.workflowVersionId],
    );
    if (!wf) return;
    await exec(
      tx,
      `UPDATE workflow_versions SET status='superseded'
        WHERE key=$2 AND org_id IS NOT DISTINCT FROM $1 AND status='active' AND id <> $3`,
      [wf.org_id, wf.key, p.workflowVersionId],
    );
    await exec(tx, `UPDATE workflow_versions SET status='active' WHERE id=$1`, [p.workflowVersionId]);
  },
  WorkflowVersionRejected: async (tx, e) => {
    const p = (e.event as EventOf<'WorkflowVersionRejected'>).payload;
    await exec(tx, `UPDATE workflow_versions SET status='rejected' WHERE id=$1`, [p.workflowVersionId]);
  },
  RoleVersionRegistered: async (tx, e) => {
    const p = (e.event as EventOf<'RoleVersionRegistered'>).payload;
    await exec(
      tx,
      `INSERT INTO role_definitions (id, org_id, key, version, definition, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [p.roleVersionId, p.orgId, p.key, p.version, JSON.stringify(p.definition), p.status, e.createdAt],
    );
  },
  RoleVersionApproved: async (tx, e) => {
    const p = (e.event as EventOf<'RoleVersionApproved'>).payload;
    const r = await one<{ org_id: string | null; key: string }>(
      tx,
      'SELECT org_id, key FROM role_definitions WHERE id=$1',
      [p.roleVersionId],
    );
    if (!r) return;
    await exec(
      tx,
      `UPDATE role_definitions SET status='superseded'
        WHERE key=$2 AND org_id IS NOT DISTINCT FROM $1 AND status='active' AND id <> $3`,
      [r.org_id, r.key, p.roleVersionId],
    );
    await exec(tx, `UPDATE role_definitions SET status='active' WHERE id=$1`, [p.roleVersionId]);
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
