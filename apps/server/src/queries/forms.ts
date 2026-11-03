import type { FormDto, FormStatus, FormSummaryDto, FormVersionDto, FormVersionInfo } from '@aom/shared';
import { FormDefinitionSchema } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, rows } from '../db/sql.ts';
import { notFound } from '../errors.ts';

/** Every query filters by the organization of the request: a form of another organization is "not found". */
export async function listForms(ctx: Ctx, orgId: string, status: FormStatus): Promise<FormSummaryDto[]> {
  const r = await rows(
    ctx.pool,
    `SELECT f.id, f.title, f.latest_version, f.status, f.field_count, f.updated_at, u.display_name AS updated_by_name
       FROM forms f LEFT JOIN users u ON u.id = f.updated_by
      WHERE f.org_id=$1 AND f.status=$2
      ORDER BY f.updated_at DESC, f.id`,
    [orgId, status],
  );
  return r.map((x) => ({
    id: x.id,
    title: x.title,
    latestVersion: x.latest_version,
    status: x.status,
    fieldCount: x.field_count,
    updatedAt: iso(x.updated_at) as string,
    updatedByName: x.updated_by_name ?? null,
  }));
}

export async function getForm(db: Queryable, orgId: string, formId: string): Promise<FormDto> {
  const f = await one(db, 'SELECT id, status, latest_version FROM forms WHERE id=$1 AND org_id=$2', [
    formId,
    orgId,
  ]);
  if (!f) throw notFound('form not found');
  const latest = await one(
    db,
    'SELECT definition FROM form_versions WHERE form_id=$1 AND org_id=$2 AND version=$3',
    [formId, orgId, f.latest_version],
  );
  if (!latest) throw notFound('form not found');
  const versions = await rows(
    db,
    `SELECT v.version, v.saved_at, u.display_name AS saved_by_name
       FROM form_versions v LEFT JOIN users u ON u.id = v.saved_by
      WHERE v.form_id=$1 AND v.org_id=$2 ORDER BY v.version DESC`,
    [formId, orgId],
  );
  const info: FormVersionInfo[] = versions.map((v) => ({
    version: v.version,
    savedAt: iso(v.saved_at) as string,
    savedByName: v.saved_by_name ?? null,
  }));
  return {
    id: f.id,
    status: f.status,
    latestVersion: f.latest_version,
    definition: FormDefinitionSchema.parse(latest.definition),
    versions: info,
  };
}

export async function getFormVersion(
  ctx: Ctx,
  orgId: string,
  formId: string,
  version: number,
): Promise<FormVersionDto> {
  const v = await one(
    ctx.pool,
    `SELECT v.version, v.definition, v.saved_at, u.display_name AS saved_by_name
       FROM form_versions v LEFT JOIN users u ON u.id = v.saved_by
      WHERE v.form_id=$1 AND v.org_id=$2 AND v.version=$3`,
    [formId, orgId, version],
  );
  if (!v) throw notFound('form version not found');
  return {
    formId,
    version: v.version,
    definition: FormDefinitionSchema.parse(v.definition),
    savedAt: iso(v.saved_at) as string,
    savedByName: v.saved_by_name ?? null,
  };
}
