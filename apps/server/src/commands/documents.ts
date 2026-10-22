import { randomUUID } from 'node:crypto';
import {
  type ChangeDocumentStatusRequest,
  type CreateDocumentRequest,
  canTransitionDocument,
  type DocumentDto,
  type DocumentStatus,
  type DocumentVersionDto,
  type DocumentWithContentDto,
  documentIsEditable,
  documentSlug,
  documentVaultPath,
  isOrgManager,
  type ListDocumentsQuery,
  projectVaultFolder,
  renderDocumentFile,
  type SaveDocumentVersionRequest,
  streamId,
} from '@aom/shared';
import type { Who } from '../auth/org-context.ts';
import { loadVisibleProject, visibleProjectIds } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { orgScope, projectScope, userActor } from './common.ts';
import { enqueueVaultWrite } from './vaults.ts';

export function documentDto(r: Row): DocumentDto {
  return {
    id: r.id,
    orgId: r.org_id,
    projectId: r.project_id ?? null,
    kind: r.kind,
    title: r.title,
    slug: r.slug,
    status: r.status,
    currentVersion: r.current_version,
    approvedVersion: r.approved_version ?? null,
    sourceThreadIds: r.source_thread_ids ?? [],
    publishState: r.publish_state,
    publishedVersion: r.published_version ?? null,
    vaultPath: r.vault_path ?? null,
    createdBy: r.created_by ?? null,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

const scopeOf = (d: { org_id: string; project_id: string | null }) =>
  d.project_id ? projectScope(d.org_id, d.project_id) : orgScope(d.org_id);
export const scopeOfDoc = scopeOf;

/** Reading: the project's members (project document), or an organization member (organization document). Others get 404. */
async function loadDocument(db: Queryable, who: Who, docId: string, lock = false): Promise<Row> {
  const d = await one(db, `SELECT * FROM documents WHERE id=$1 AND org_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [
    docId,
    who.orgId,
  ]);
  if (!d) throw notFound('document not found');
  if (d.project_id) {
    try {
      await loadVisibleProject(db, who.userId, d.project_id);
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 409))
        throw notFound('document not found');
      throw e;
    }
  }
  return d;
}

/** Writing: the organization Owner and Admins (the people who run discovery sessions and start intakes). */
function assertManager(who: Who): void {
  if (!isOrgManager({ orgRole: who.role })) throw forbidden('only an Owner or an Admin can change documents');
}

async function assertThreads(db: Queryable, who: Who, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const found = await rows(
    db,
    `SELECT t.id FROM threads t
      WHERE t.id = ANY($1::uuid[]) AND t.org_id=$2 AND t.kind IN ('discovery','boardroom') AND t.deleted_at IS NULL
        AND (t.created_by=$3 OR EXISTS (SELECT 1 FROM thread_participants p WHERE p.thread_id=t.id AND p.kind='user'
             AND p.ref_id=$3::text AND p.removed_at IS NULL))`,
    [[...ids], who.orgId, who.userId],
  );
  if (found.length !== new Set(ids).size)
    throw badRequest('unknown_session', 'a source session was not found');
}

async function uniqueSlug(
  db: Queryable,
  orgId: string,
  projectId: string | null,
  title: string,
): Promise<string> {
  const base = documentSlug(title);
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base.slice(0, 56)}-${n}`;
    const taken = await one(
      db,
      'SELECT 1 FROM documents WHERE org_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND slug=$3',
      [orgId, projectId, slug],
    );
    if (!taken) return slug;
  }
}

async function dtoWithContent(db: Queryable, d: Row): Promise<DocumentWithContentDto> {
  const versions = await rows(
    db,
    `SELECT id, document_id, version, note, saved_by_kind, saved_by_id, created_at FROM document_versions
      WHERE document_id=$1 ORDER BY version DESC`,
    [d.id],
  );
  const cur = await one(db, 'SELECT content FROM document_versions WHERE document_id=$1 AND version=$2', [
    d.id,
    d.current_version,
  ]);
  return {
    ...documentDto(d),
    content: cur?.content ?? '',
    versions: versions.map((v) => ({
      id: v.id,
      documentId: v.document_id,
      version: v.version,
      note: v.note ?? null,
      savedBy: { kind: v.saved_by_kind, id: v.saved_by_id ?? null },
      createdAt: iso(v.created_at) as string,
    })),
  };
}

export async function createDocument(
  ctx: Ctx,
  who: Who,
  req: CreateDocumentRequest,
): Promise<DocumentWithContentDto> {
  assertManager(who);
  return withAppendTx(ctx.pool, async (tx) => {
    if (req.projectId) {
      const p = await loadVisibleProject(tx, who.userId, req.projectId);
      if (p.org_id !== who.orgId) throw notFound('project not found');
    }
    await assertThreads(tx, who, req.sourceThreadIds);
    const docId = randomUUID();
    const slug = await uniqueSlug(tx, who.orgId, req.projectId ?? null, req.title);
    const scope = req.projectId ? projectScope(who.orgId, req.projectId) : orgScope(who.orgId);
    await ctx.store.append(
      [
        {
          streamId: streamId.document(docId),
          event: {
            type: 'DocumentCreated',
            payload: {
              docId,
              orgId: who.orgId,
              ...(req.projectId ? { projectId: req.projectId } : {}),
              kind: req.kind,
              title: req.title,
              slug,
              createdBy: who.userId,
              sourceThreadIds: req.sourceThreadIds,
            },
          },
          actor: userActor(who.userId),
          scope,
        },
        versionEvent(docId, 1, req.content, { kind: 'user', id: who.userId }, scope, userActor(who.userId)),
      ],
      { tx },
    );
    return dtoWithContent(tx, (await one(tx, 'SELECT * FROM documents WHERE id=$1', [docId])) as Row);
  });
}

export function versionEvent(
  docId: string,
  version: number,
  content: string,
  savedBy: { kind: 'user' | 'agent' | 'persona' | 'system'; id: string | null },
  scope: AppendInput['scope'],
  actor: AppendInput['actor'],
  extra: {
    title?: string | undefined;
    note?: string | undefined;
    sourceThreadIds?: string[] | undefined;
  } = {},
): AppendInput {
  return {
    streamId: streamId.document(docId),
    event: {
      type: 'DocumentVersionSaved',
      payload: {
        docId,
        versionId: randomUUID(),
        version,
        content,
        savedBy,
        ...(extra.title ? { title: extra.title } : {}),
        ...(extra.note ? { note: extra.note } : {}),
        ...(extra.sourceThreadIds ? { sourceThreadIds: extra.sourceThreadIds } : {}),
      },
    },
    actor,
    scope,
  };
}

export async function listDocuments(ctx: Ctx, who: Who, q: ListDocumentsQuery): Promise<DocumentDto[]> {
  const visible = await visibleProjectIds(ctx.pool, who.userId);
  const list = await rows(
    ctx.pool,
    `SELECT * FROM documents d
      WHERE d.org_id=$1 AND (d.project_id IS NULL OR d.project_id = ANY($2::uuid[]))
        AND ($3::uuid IS NULL OR d.project_id=$3) AND ($4::text IS NULL OR d.kind=$4) AND ($5::text IS NULL OR d.status=$5)
        AND ($6::boolean IS NOT TRUE OR d.project_id IS NULL)
        AND ($7::uuid IS NULL OR $7 = ANY(d.source_thread_ids))
      ORDER BY d.updated_at DESC, d.id`,
    [
      who.orgId,
      visible,
      q.projectId ?? null,
      q.kind ?? null,
      q.status ?? null,
      q.orgOnly === 'true' ? true : null,
      q.threadId ?? null,
    ],
  );
  return list.map(documentDto);
}

export async function getDocument(ctx: Ctx, who: Who, docId: string): Promise<DocumentWithContentDto> {
  return dtoWithContent(ctx.pool, await loadDocument(ctx.pool, who, docId));
}

export async function getDocumentVersion(
  ctx: Ctx,
  who: Who,
  docId: string,
  version: number,
): Promise<DocumentVersionDto> {
  await loadDocument(ctx.pool, who, docId);
  const v = await one(ctx.pool, 'SELECT * FROM document_versions WHERE document_id=$1 AND version=$2', [
    docId,
    version,
  ]);
  if (!v) throw notFound('version not found');
  return {
    id: v.id,
    documentId: v.document_id,
    version: v.version,
    content: v.content,
    note: v.note ?? null,
    savedBy: { kind: v.saved_by_kind, id: v.saved_by_id ?? null },
    createdAt: iso(v.created_at) as string,
  };
}

export async function saveDocumentVersion(
  ctx: Ctx,
  who: Who,
  docId: string,
  req: SaveDocumentVersionRequest,
): Promise<DocumentWithContentDto> {
  assertManager(who);
  return withAppendTx(ctx.pool, async (tx) => {
    const d = await loadDocument(tx, who, docId, true);
    if (!documentIsEditable(d.status))
      throw conflict(
        'document_locked',
        `a ${String(d.status).replace('_', ' ')} document cannot be edited: reopen it first`,
      );
    if (req.baseVersion !== undefined && req.baseVersion !== d.current_version)
      throw conflict(
        'version_conflict',
        `the document is at version ${d.current_version}, not ${req.baseVersion}`,
        {
          currentVersion: d.current_version,
        },
      );
    if (req.sourceThreadIds) await assertThreads(tx, who, req.sourceThreadIds);
    const cur = await one(tx, 'SELECT content FROM document_versions WHERE document_id=$1 AND version=$2', [
      docId,
      d.current_version,
    ]);
    const sameTitle = !req.title || req.title === d.title;
    if (cur && cur.content === req.content && sameTitle && !req.sourceThreadIds) return dtoWithContent(tx, d);
    await ctx.store.append(
      [
        versionEvent(
          docId,
          d.current_version + 1,
          req.content,
          { kind: 'user', id: who.userId },
          scopeOf(d as never),
          userActor(who.userId),
          {
            title: sameTitle ? undefined : req.title,
            note: req.note,
            sourceThreadIds: req.sourceThreadIds,
          },
        ),
      ],
      { tx },
    );
    return dtoWithContent(tx, (await one(tx, 'SELECT * FROM documents WHERE id=$1', [docId])) as Row);
  });
}

export async function changeDocumentStatus(
  ctx: Ctx,
  who: Who,
  docId: string,
  req: ChangeDocumentStatusRequest,
): Promise<DocumentWithContentDto> {
  assertManager(who);
  const out = await withAppendTx(ctx.pool, async (tx) => {
    const d = await loadDocument(tx, who, docId, true);
    const from = d.status as DocumentStatus;
    if (from === req.status) return dtoWithContent(tx, d);
    if (!canTransitionDocument(from, req.status))
      throw conflict(
        'invalid_transition',
        `a ${from.replace('_', ' ')} document cannot become ${req.status.replace('_', ' ')}`,
      );
    if (req.status === 'approved') {
      const cur = await one(tx, 'SELECT content FROM document_versions WHERE document_id=$1 AND version=$2', [
        docId,
        d.current_version,
      ]);
      if (!cur?.content?.trim()) throw conflict('document_empty', 'an empty document cannot be approved');
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.document(docId),
          event: {
            type: 'DocumentStatusChanged',
            payload: {
              docId,
              from,
              to: req.status,
              version: d.current_version,
              by: who.userId,
              ...(req.note ? { note: req.note } : {}),
            },
          },
          actor: userActor(who.userId),
          scope: scopeOf(d as never),
        },
      ],
      { tx },
    );
    return dtoWithContent(tx, (await one(tx, 'SELECT * FROM documents WHERE id=$1', [docId])) as Row);
  });
  if (req.status === 'approved') {
    // The approval stands whether or not the vault copy could be queued: it is retried (`publishPendingDocuments`).
    await publishDocument(ctx, docId).catch((err) => ctx.log.warn({ err, docId }, 'document publish failed'));
    return getDocument(ctx, who, docId);
  }
  return out;
}

export type PublishResult =
  | { queued: true; path: string; workstationId: string }
  | { queued: false; reason: 'not_pending' | 'no_vault' | 'no_workstation' };

/**
 * Hands the approved version to a workstation as a durable `vault.write` command (the pattern of the decision files):
 * `<project folder>/docs/<slug>.md` in the project's vault (else the organization vault), or `org/docs/<slug>.md` for an
 * organization document. With no vault or no workstation the document stays `pending` and is retried.
 */
export async function publishDocument(ctx: Ctx, docId: string): Promise<PublishResult> {
  const d = await one(ctx.pool, 'SELECT * FROM documents WHERE id=$1', [docId]);
  if (
    !d ||
    d.publish_state !== 'pending' ||
    !['approved', 'handed_off'].includes(d.status) ||
    !d.publish_version
  )
    return { queued: false, reason: 'not_pending' };
  let folder: string | null = null;
  let vaultId: string | undefined;
  if (d.project_id) {
    const p = await one(ctx.pool, 'SELECT key, vault_folder, vault_dir FROM projects WHERE id=$1', [
      d.project_id,
    ]);
    if (p) folder = projectVaultFolder({ key: p.key, vaultFolder: p.vault_folder, vaultDir: p.vault_dir });
    vaultId = (await one(ctx.pool, 'SELECT id FROM vaults WHERE project_id=$1', [d.project_id]))?.id;
  }
  vaultId ??= (
    await one(ctx.pool, `SELECT id FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`, [
      d.org_id,
    ])
  )?.id;
  if (!vaultId) return { queued: false, reason: 'no_vault' };
  const v = await one(ctx.pool, 'SELECT content FROM document_versions WHERE document_id=$1 AND version=$2', [
    docId,
    d.publish_version,
  ]);
  if (!v) return { queued: false, reason: 'not_pending' };
  const path = documentVaultPath(d.slug, folder);
  const r = await enqueueVaultWrite(ctx, ctx.pool, vaultId, {
    path,
    mode: 'replace',
    content: renderDocumentFile({
      id: d.id,
      title: d.title,
      kind: d.kind,
      version: d.publish_version,
      status: 'approved',
      content: v.content,
      approvedAt: iso(d.updated_at) as string,
      sourceThreadIds: d.source_thread_ids ?? [],
    }),
    commitMessage: `docs: ${d.kind} ${d.title.replace(/\s+/g, ' ').slice(0, 60)} v${d.publish_version}`,
  });
  if (!r.queued || !r.workstationId || !r.commandId) return { queued: false, reason: 'no_workstation' };
  await ctx.store.append([
    {
      streamId: streamId.document(docId),
      event: {
        type: 'DocumentPublishQueued',
        payload: {
          docId,
          version: d.publish_version,
          vaultId,
          vaultPath: path,
          workstationId: r.workstationId,
          commandId: r.commandId,
        },
      },
      actor: { kind: 'system', id: null },
      scope: scopeOf(d as never),
    },
  ]);
  await ctx.services.gateway.deliverPending(r.workstationId);
  return { queued: true, path, workstationId: r.workstationId };
}

/** Retries the vault copy of every approved document that is still waiting for a vault or a workstation. */
export async function publishPendingDocuments(ctx: Ctx): Promise<number> {
  const pending = await rows(
    ctx.pool,
    `SELECT id FROM documents WHERE publish_state='pending' AND status IN ('approved','handed_off') ORDER BY updated_at LIMIT 50`,
  );
  let n = 0;
  for (const d of pending) {
    const r = await publishDocument(ctx, d.id).catch((err) => {
      ctx.log.warn({ err, docId: d.id }, 'document publish retry failed');
      return undefined;
    });
    if (r?.queued) n++;
  }
  return n;
}
