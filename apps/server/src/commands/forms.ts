import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalFormDefinition,
  FORM_LIMITS,
  type FormDefinition,
  type FormDto,
  type FormLogoDto,
  formLogoUrl,
  streamId,
  validateFormDefinition,
} from '@aom/shared';
import type { Who } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, notFound, unprocessable } from '../errors.ts';
import { getForm } from '../queries/forms.ts';
import { orgScope, userActor } from './common.ts';

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** The definition checked, or 422 `invalid_form` with every issue. */
function checked(input: unknown): FormDefinition {
  const r = validateFormDefinition(input);
  if (!r.ok) throw unprocessable('invalid_form', 'the form is not valid', { issues: r.issues });
  return r.definition;
}

/** The logo must be an image of the same organization. */
async function checkLogo(db: Queryable, orgId: string, def: FormDefinition): Promise<void> {
  const id = def.settings.logo?.imageId;
  if (!id) return;
  const img = await one(db, 'SELECT 1 AS ok FROM org_brand_images WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (!img) throw unprocessable('logo_not_found', 'the logo image was not found');
}

function appendVersion(ctx: Ctx, tx: Tx, who: Who, formId: string, version: number, def: FormDefinition) {
  return ctx.store.append(
    [
      {
        streamId: streamId.form(formId),
        event: {
          type: 'FormVersionSaved',
          payload: {
            formId,
            orgId: who.orgId,
            version,
            definition: def,
            definitionHash: sha256(canonicalFormDefinition(def)),
            by: who.userId,
          },
        },
        actor: userActor(who.userId),
        scope: orgScope(who.orgId),
      },
    ],
    { tx },
  );
}

export async function createForm(ctx: Ctx, who: Who, input: unknown): Promise<FormDto> {
  const def = checked(input);
  const formId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    await checkLogo(tx, who.orgId, def);
    await appendVersion(ctx, tx, who, formId, 1, def);
  });
  return getForm(ctx.pool, who.orgId, formId);
}

/**
 * Save = a new immutable version. `baseVersion` must be the latest (else 409); an unchanged definition appends nothing.
 */
export async function saveForm(
  ctx: Ctx,
  who: Who,
  formId: string,
  body: { baseVersion: number; definition: unknown },
): Promise<{ form: FormDto; created: boolean }> {
  const def = checked(body.definition);
  const created = await withAppendTx(ctx.pool, async (tx) => {
    const f = await one(tx, 'SELECT latest_version FROM forms WHERE id=$1 AND org_id=$2 FOR UPDATE', [
      formId,
      who.orgId,
    ]);
    if (!f) throw notFound('form not found');
    if (body.baseVersion !== f.latest_version)
      throw conflict(
        'form_version_conflict',
        `This form was changed by someone else. Reload to see version ${f.latest_version}.`,
        { latestVersion: f.latest_version },
      );
    const latest = await one(
      tx,
      'SELECT definition_hash FROM form_versions WHERE form_id=$1 AND version=$2',
      [formId, f.latest_version],
    );
    if (latest?.definition_hash === sha256(canonicalFormDefinition(def))) return false;
    await checkLogo(tx, who.orgId, def);
    await appendVersion(ctx, tx, who, formId, f.latest_version + 1, def);
    return true;
  });
  return { form: await getForm(ctx.pool, who.orgId, formId), created };
}

async function setArchived(ctx: Ctx, who: Who, formId: string, archived: boolean): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const f = await one(tx, 'SELECT status FROM forms WHERE id=$1 AND org_id=$2 FOR UPDATE', [
      formId,
      who.orgId,
    ]);
    if (!f) throw notFound('form not found');
    if ((f.status === 'archived') === archived) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.form(formId),
          event: {
            type: archived ? 'FormArchived' : 'FormUnarchived',
            payload: { formId, orgId: who.orgId, by: who.userId },
          },
          actor: userActor(who.userId),
          scope: orgScope(who.orgId),
        },
      ],
      { tx },
    );
  });
}

export const archiveForm = (ctx: Ctx, who: Who, formId: string) => setArchived(ctx, who, formId, true);
export const unarchiveForm = (ctx: Ctx, who: Who, formId: string) => setArchived(ctx, who, formId, false);

/** Kind of an image from its first bytes (the client's content type is ignored). SVG is never accepted. */
export function logoContentType(b: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}

/** Branding asset of the organization (not client data). Bytes live in `org_brand_images`, never in an event. */
export async function uploadFormLogo(ctx: Ctx, who: Who, bytes: Buffer): Promise<FormLogoDto> {
  if (bytes.length > FORM_LIMITS.logoBytes)
    throw unprocessable('logo_too_large', 'The logo is too large (512 KB at most).');
  const type = logoContentType(bytes);
  if (!type) throw unprocessable('logo_type', 'Use a PNG, JPEG or WebP image.');
  const id = randomUUID();
  await exec(
    ctx.pool,
    `INSERT INTO org_brand_images (id, org_id, purpose, content_type, size, sha256, data, created_by, created_at)
     VALUES ($1,$2,'form_logo',$3,$4,$5,$6,$7,$8)`,
    [id, who.orgId, type, bytes.length, sha256(bytes), bytes, who.userId, ctx.clock.now()],
  );
  return { imageId: id, url: formLogoUrl(id) };
}

/** The logo bytes for a member of the owning organization; anything else is "not found". */
export async function readFormLogo(
  ctx: Ctx,
  orgId: string,
  imageId: string,
): Promise<{ contentType: string; data: Buffer }> {
  const r = await one(ctx.pool, 'SELECT content_type, data FROM org_brand_images WHERE id=$1 AND org_id=$2', [
    imageId,
    orgId,
  ]);
  if (!r) throw notFound('logo not found');
  return { contentType: r.content_type, data: r.data };
}
