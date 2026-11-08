import {
  acceptedUploadExtensions,
  type ClientLinkDto,
  type ClientLinkState,
  type CreateClientLink,
  type FormDefinition,
  FormDefinitionSchema,
  type FormPublicationDto,
  type FormPublicationWarning,
  type FormSubmissionDto,
  publicFormPath,
  type StorageReference,
  type SubmissionCleanupState,
  streamId,
} from '@aom/shared';
import type { Who } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { iso, one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';
import { queueFormUploadCleanup } from '../public-forms/cleanup.ts';
import { newLinkId, newPublicId, signClientLink } from '../public-forms/tokens.ts';
import { orgScope, userActor } from './common.ts';

/** `https://host/f/<id>`: the one string the QR code encodes. */
export const publicFormUrl = (ctx: Ctx, publicId: string): string =>
  `${ctx.config.publicOrigin.replace(/\/$/, '')}${publicFormPath(publicId)}`;

/** The connection ids a form writes to, with the fields (and `answers`) that use each. A null id is "not set". */
export function destinationsOf(def: FormDefinition, onlyFiles?: ReadonlySet<string>) {
  const out: Array<{ field: string; connectionId: string | null }> = [
    { field: 'answers', connectionId: def.settings.answersDestination.connectionId },
  ];
  for (const f of def.fields)
    if (f.type === 'file' && (!onlyFiles || onlyFiles.has(f.id)))
      out.push({ field: f.id, connectionId: f.destination.connectionId });
  return out;
}

async function latestDefinition(ctx: Ctx, orgId: string, formId: string) {
  const f = await one(ctx.pool, 'SELECT status, latest_version FROM forms WHERE id=$1 AND org_id=$2', [
    formId,
    orgId,
  ]);
  if (!f) throw notFound('form not found');
  const v = await one(
    ctx.pool,
    'SELECT definition FROM form_versions WHERE form_id=$1 AND org_id=$2 AND version=$3',
    [formId, orgId, f.latest_version],
  );
  if (!v) throw notFound('form not found');
  return {
    status: f.status as 'active' | 'archived',
    latestVersion: f.latest_version as number,
    definition: FormDefinitionSchema.parse(v.definition),
  };
}

/** Active connections of the org among these ids, with their workstation and health. */
async function connectionsOf(ctx: Ctx, orgId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, { workstationId: string; state: string | null }>();
  const r = await rows(
    ctx.pool,
    `SELECT c.id, c.workstation_id, h.state
       FROM storage_connections c LEFT JOIN storage_connection_health h ON h.connection_id = c.id
      WHERE c.org_id=$1 AND c.status='active' AND c.id = ANY($2::uuid[])`,
    [orgId, ids],
  );
  return new Map(
    r.map((x) => [
      x.id as string,
      { workstationId: x.workstation_id as string, state: x.state as string | null },
    ]),
  );
}

/** Everything that stops a form taking submissions, or may: used by publish (blocking) and the panel (warnings). */
async function assess(ctx: Ctx, orgId: string, def: FormDefinition) {
  const dest = destinationsOf(def);
  const conns = await connectionsOf(
    ctx,
    orgId,
    dest.flatMap((d) => (d.connectionId ? [d.connectionId] : [])),
  );
  const missing = dest.filter((d) => !d.connectionId || !conns.has(d.connectionId)).map((d) => d.field);
  const offline = dest
    .filter((d) => d.connectionId && conns.has(d.connectionId))
    .filter(
      (d) =>
        !ctx.services.runners.isOnline(
          (conns.get(d.connectionId as string) as { workstationId: string }).workstationId,
        ),
    )
    .map((d) => d.field);
  const unhealthy = dest
    .filter((d) => d.connectionId && conns.has(d.connectionId))
    .filter((d) => {
      const st = (conns.get(d.connectionId as string) as { state: string | null }).state;
      return st !== null && st !== 'connected' && st !== 'pending';
    })
    .map((d) => d.field);
  const unsupported: string[] = [];
  const unusable: string[] = [];
  for (const f of def.fields) {
    if (f.type !== 'file') continue;
    if (f.allowedTypes.some((t) => acceptedUploadExtensions([t]).length === 0)) unsupported.push(f.id);
    if (acceptedUploadExtensions(f.allowedTypes).length === 0) unusable.push(f.id);
  }
  return { missing, offline, unhealthy, unsupported, unusable };
}

export async function getPublication(ctx: Ctx, orgId: string, formId: string): Promise<FormPublicationDto> {
  const form = await latestDefinition(ctx, orgId, formId);
  const p = await one(ctx.pool, 'SELECT * FROM form_publications WHERE form_id=$1 AND org_id=$2', [
    formId,
    orgId,
  ]);
  const a = await assess(ctx, orgId, form.definition);
  const warnings: FormPublicationDto['warnings'] = [];
  const add = (code: FormPublicationWarning, fields: string[]) => {
    if (fields.length) warnings.push({ code, fields });
  };
  add('destination_missing', a.missing);
  add('destination_offline', a.offline);
  add('unsupported_file_types', a.unsupported);
  add('connection_unhealthy', a.unhealthy);
  return {
    status: p?.status === 'published' ? 'published' : 'unpublished',
    url: p ? publicFormUrl(ctx, p.public_id) : null,
    publicId: p?.public_id ?? null,
    version: p?.version ?? null,
    latestVersion: form.latestVersion,
    publishedAt: iso(p?.published_at),
    archived: form.status === 'archived',
    warnings,
  };
}

const append = (
  ctx: Ctx,
  tx: Parameters<Parameters<typeof withAppendTx>[1]>[0],
  who: Who,
  formId: string,
  event: any,
) =>
  ctx.store.append(
    [{ streamId: streamId.form(formId), event, actor: userActor(who.userId), scope: orgScope(who.orgId) }],
    { tx },
  );

/** Publish the latest version (also "Publish changes": the same public id, a newer version). */
export async function publishForm(ctx: Ctx, who: Who, formId: string): Promise<FormPublicationDto> {
  const form = await latestDefinition(ctx, who.orgId, formId);
  if (form.status === 'archived') throw conflict('form_archived', 'An archived form cannot be published.');
  const a = await assess(ctx, who.orgId, form.definition);
  if (a.missing.length)
    throw conflict(
      'destination_missing',
      'Choose an active storage connection for the answers and for every file field before publishing.',
      { fields: a.missing },
    );
  if (a.unusable.length)
    throw conflict('unsupported_file_types', 'A file field accepts no file type that public forms allow.', {
      fields: a.unusable,
    });
  await withAppendTx(ctx.pool, async (tx) => {
    const existing = await one(tx, 'SELECT public_id FROM form_publications WHERE form_id=$1 FOR UPDATE', [
      formId,
    ]);
    await append(ctx, tx, who, formId, {
      type: 'FormPublished',
      payload: {
        formId,
        orgId: who.orgId,
        publicId: existing?.public_id ?? newPublicId(),
        version: form.latestVersion,
        by: who.userId,
      },
    });
  });
  return getPublication(ctx, who.orgId, formId);
}

export async function unpublishForm(ctx: Ctx, who: Who, formId: string): Promise<FormPublicationDto> {
  await latestDefinition(ctx, who.orgId, formId);
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await one(
      tx,
      'SELECT status FROM form_publications WHERE form_id=$1 AND org_id=$2 FOR UPDATE',
      [formId, who.orgId],
    );
    if (!p || p.status !== 'published') return;
    await append(ctx, tx, who, formId, {
      type: 'FormUnpublished',
      payload: { formId, orgId: who.orgId, by: who.userId },
    });
  });
  return getPublication(ctx, who.orgId, formId);
}

/** A new public id: the old URL (and every printed QR code) stops working. */
export async function resetPublicLink(ctx: Ctx, who: Who, formId: string): Promise<FormPublicationDto> {
  await latestDefinition(ctx, who.orgId, formId);
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await one(
      tx,
      'SELECT 1 AS ok FROM form_publications WHERE form_id=$1 AND org_id=$2 FOR UPDATE',
      [formId, who.orgId],
    );
    if (!p) throw conflict('form_not_published', 'This form was never published.');
    await append(ctx, tx, who, formId, {
      type: 'FormPublicLinkReset',
      payload: { formId, orgId: who.orgId, publicId: newPublicId(), by: who.userId },
    });
  });
  return getPublication(ctx, who.orgId, formId);
}

// ------------------------------------------------------------------------------------------- client links

function linkState(
  r: { revoked_at: unknown; used_at: unknown; expires_at: Date },
  now: Date,
): ClientLinkState {
  if (r.revoked_at) return 'revoked';
  if (r.used_at) return 'used';
  return new Date(r.expires_at).getTime() <= now.getTime() ? 'expired' : 'active';
}

async function toDto(ctx: Ctx, formId: string, publicId: string | null, r: any): Promise<ClientLinkDto> {
  const token = await signClientLink(ctx, formId, r.id, new Date(r.expires_at));
  return {
    id: r.id,
    reference: r.reference,
    state: linkState(r, ctx.clock.now()),
    expiresAt: iso(r.expires_at) as string,
    createdAt: iso(r.created_at) as string,
    url: publicId ? `${publicFormUrl(ctx, publicId)}#c=${token}` : null,
  };
}

/** Creates a personal link inside the caller's append transaction (journey steps). The form must be published. */
export async function createClientLinkIn(
  tx: Parameters<Parameters<typeof withAppendTx>[1]>[0],
  ctx: Ctx,
  a: {
    orgId: string;
    formId: string;
    by: string;
    reference: string;
    recordKind?: string | undefined;
    recordId?: string | undefined;
    expiresAt: Date;
    purpose?: 'offline' | undefined;
    offlineRequestId?: string | undefined;
  },
): Promise<{ linkId: string; expiresAt: Date }> {
  const p = await one(tx, 'SELECT status FROM form_publications WHERE form_id=$1 AND org_id=$2', [
    a.formId,
    a.orgId,
  ]);
  if (!p || p.status !== 'published')
    throw conflict('form_not_published', 'Publish the form before creating personal links.');
  const linkId = newLinkId();
  await append(ctx, tx, { userId: a.by, orgId: a.orgId } as Who, a.formId, {
    type: 'FormClientLinkCreated',
    payload: {
      linkId,
      formId: a.formId,
      orgId: a.orgId,
      reference: a.reference,
      ...(a.recordKind ? { recordKind: a.recordKind } : {}),
      ...(a.recordId ? { recordId: a.recordId } : {}),
      expiresAt: a.expiresAt.toISOString(),
      by: a.by,
      ...(a.purpose ? { purpose: a.purpose } : {}),
      ...(a.offlineRequestId ? { offlineRequestId: a.offlineRequestId } : {}),
    },
  });
  return { linkId, expiresAt: a.expiresAt };
}

/** Revokes an unrevoked link inside the caller's transaction. A link that is gone or already revoked is left alone. */
export async function revokeClientLinkIn(
  tx: Parameters<Parameters<typeof withAppendTx>[1]>[0],
  ctx: Ctx,
  a: { orgId: string; formId: string; linkId: string; by: string },
): Promise<boolean> {
  const l = await one(
    tx,
    'SELECT revoked_at FROM form_client_links WHERE id=$1 AND form_id=$2 AND org_id=$3 FOR UPDATE',
    [a.linkId, a.formId, a.orgId],
  );
  if (!l || l.revoked_at) return false;
  await append(ctx, tx, { userId: a.by, orgId: a.orgId } as Who, a.formId, {
    type: 'FormClientLinkRevoked',
    payload: { linkId: a.linkId, formId: a.formId, orgId: a.orgId, by: a.by },
  });
  return true;
}

/** The signed URL of a link, computed on read; null when the form is not published. */
export async function clientLinkUrl(
  ctx: Ctx,
  orgId: string,
  formId: string,
  linkId: string,
): Promise<string | null> {
  const r = await one(ctx.pool, 'SELECT * FROM form_client_links WHERE id=$1 AND org_id=$2', [linkId, orgId]);
  const p = await one(ctx.pool, 'SELECT public_id FROM form_publications WHERE form_id=$1 AND org_id=$2', [
    formId,
    orgId,
  ]);
  if (!r || !p) return null;
  return (await toDto(ctx, formId, p.public_id, r)).url;
}

/** A personal link for one client (or record). Also used by journey steps. */
export async function createClientLink(
  ctx: Ctx,
  who: Who,
  formId: string,
  input: CreateClientLink,
): Promise<ClientLinkDto> {
  await latestDefinition(ctx, who.orgId, formId);
  const p = await one(
    ctx.pool,
    'SELECT public_id, status FROM form_publications WHERE form_id=$1 AND org_id=$2',
    [formId, who.orgId],
  );
  if (!p || p.status !== 'published')
    throw conflict('form_not_published', 'Publish the form before creating personal links.');
  const linkId = newLinkId();
  const expiresAt = new Date(ctx.clock.now().getTime() + input.expiresInDays * 86_400_000);
  await withAppendTx(ctx.pool, (tx) =>
    append(ctx, tx, who, formId, {
      type: 'FormClientLinkCreated',
      payload: {
        linkId,
        formId,
        orgId: who.orgId,
        reference: input.reference,
        ...(input.recordKind ? { recordKind: input.recordKind } : {}),
        ...(input.recordId ? { recordId: input.recordId } : {}),
        expiresAt: expiresAt.toISOString(),
        by: who.userId,
      },
    }),
  );
  const r = await one(ctx.pool, 'SELECT * FROM form_client_links WHERE id=$1', [linkId]);
  return toDto(ctx, formId, p.public_id, r);
}

export async function listClientLinks(ctx: Ctx, orgId: string, formId: string): Promise<ClientLinkDto[]> {
  await latestDefinition(ctx, orgId, formId);
  const p = await one(
    ctx.pool,
    'SELECT public_id, status FROM form_publications WHERE form_id=$1 AND org_id=$2',
    [formId, orgId],
  );
  const r = await rows(
    ctx.pool,
    'SELECT * FROM form_client_links WHERE form_id=$1 AND org_id=$2 ORDER BY created_at DESC, id LIMIT 200',
    [formId, orgId],
  );
  return Promise.all(r.map((x) => toDto(ctx, formId, p?.status === 'published' ? p.public_id : null, x)));
}

export async function revokeClientLink(ctx: Ctx, who: Who, formId: string, linkId: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const l = await one(
      tx,
      'SELECT revoked_at FROM form_client_links WHERE id=$1 AND form_id=$2 AND org_id=$3 FOR UPDATE',
      [linkId, formId, who.orgId],
    );
    if (!l) throw notFound('link not found');
    if (l.revoked_at) return;
    await append(ctx, tx, who, formId, {
      type: 'FormClientLinkRevoked',
      payload: { linkId, formId, orgId: who.orgId, by: who.userId },
    });
  });
}

// ------------------------------------------------------------------------------------------- submissions

/** The desk's list: status, times, the client reference and where things were stored. No content. */
export async function listSubmissions(
  ctx: Ctx,
  orgId: string,
  formId: string,
  before?: string,
): Promise<{ submissions: FormSubmissionDto[]; nextCursor: string | null }> {
  await latestDefinition(ctx, orgId, formId);
  const r = await rows(
    ctx.pool,
    `SELECT s.*, l.reference FROM form_submissions s LEFT JOIN form_client_links l ON l.id = s.link_id
      WHERE s.form_id=$1 AND s.org_id=$2 AND ($3::timestamptz IS NULL OR s.created_at < $3::timestamptz)
      ORDER BY s.created_at DESC LIMIT 51`,
    [formId, orgId, before ?? null],
  );
  const page = r.slice(0, 50);
  const cleanup = new Map<
    string,
    Map<string, { state: SubmissionCleanupState; attempts: number; error: string | null }>
  >();
  if (page.length) {
    const c = await rows<{
      submission_id: string;
      label: string;
      path: string;
      state: SubmissionCleanupState;
      attempts: number;
      last_error: string | null;
    }>(
      ctx.pool,
      'SELECT submission_id, label, path, state, attempts, last_error FROM form_submission_cleanup WHERE submission_id = ANY($1::uuid[])',
      [page.map((x) => x.id)],
    );
    for (const x of c) {
      const m = cleanup.get(x.submission_id) ?? new Map();
      m.set(`${x.label}\u0000${x.path}`, { state: x.state, attempts: x.attempts, error: x.last_error });
      cleanup.set(x.submission_id, m);
    }
  }
  return {
    submissions: page.map((x) => {
      const stored: FormSubmissionDto['stored'] = [];
      const refs = x.answers_refs as {
        html?: StorageReference;
        json?: StorageReference;
        pdf?: StorageReference;
      };
      if (refs.json) stored.push({ label: 'Answers (JSON)', path: refs.json.path });
      if (refs.html) stored.push({ label: 'Answers (readable)', path: refs.html.path });
      if (refs.pdf) stored.push({ label: 'Answers (PDF)', path: refs.pdf.path });
      for (const p of x.parts as Array<{ field: string; reference?: StorageReference }>)
        if (p.reference) stored.push({ label: p.field, path: p.reference.path });
      const queued = cleanup.get(x.id);
      let counts: FormSubmissionDto['cleanup'] = null;
      if (queued) {
        counts = { pending: 0, removed: 0, failed: 0 };
        for (const f of stored) {
          const c = queued.get(`${f.label}\u0000${f.path}`);
          if (!c) continue;
          f.cleanup = c;
          counts[c.state]++;
        }
      }
      return {
        id: x.id,
        status: x.status,
        formVersion: x.form_version,
        reference: x.reference ?? null,
        errorCode: x.error_code ?? null,
        createdAt: iso(x.created_at) as string,
        completedAt: iso(x.completed_at),
        stored,
        cleanup: counts,
      };
    }),
    nextCursor: r.length > 50 ? (iso(page[49]?.created_at) as string) : null,
  };
}

/** Expires submissions that ran out, and deletes expired ones older than 30 days. `complete` rows stay. */
export async function pruneFormSubmissions(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  await ctx.pool.query(
    `UPDATE form_submissions SET status='expired', updated_at=$1
      WHERE expires_at < $1 AND status IN ('receiving','failed','storing')`,
    [now],
  );
  await queueFormUploadCleanup(ctx);
  // A row whose files still wait to be removed is kept: the desk shows them and the sweep needs the row.
  await ctx.pool.query(
    `DELETE FROM form_submissions f WHERE f.status='expired' AND f.updated_at < $1
        AND NOT EXISTS (SELECT 1 FROM form_submission_cleanup c WHERE c.submission_id = f.id AND c.state='pending')`,
    [new Date(now.getTime() - 30 * 86_400_000)],
  );
}
