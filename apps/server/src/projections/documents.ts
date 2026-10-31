import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <
  T extends
    | 'DocumentCreated'
    | 'DocumentVersionSaved'
    | 'DocumentStatusChanged'
    | 'DocumentPublishQueued'
    | 'DocumentTagsChanged',
>(
  e: StoredEvent,
) => e.event as EventOf<T>;

/** Documents and their versions. Every write uses the event's time, never now(), so a rebuild gives the same rows. */
export const documentProjectors: Record<string, Projector> = {
  DocumentCreated: async (tx, e) => {
    const p = ev<'DocumentCreated'>(e).payload;
    await exec(
      tx,
      `INSERT INTO documents (id, org_id, project_id, kind, title, slug, status, current_version, source_thread_ids, created_by, created_at, updated_at,
                              tags, file_name, file_content_type, file_size, file_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',0,$7,$8,$9,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.docId,
        p.orgId,
        p.projectId ?? null,
        p.kind,
        p.title,
        p.slug,
        p.sourceThreadIds,
        p.createdBy,
        e.createdAt,
        p.tags ?? [],
        p.file?.name ?? null,
        p.file?.contentType ?? null,
        p.file?.size ?? null,
        p.file?.sha256 ?? null,
      ],
    );
  },
  DocumentTagsChanged: async (tx, e) => {
    const p = ev<'DocumentTagsChanged'>(e).payload;
    // The vault copy carries the tags, so an approved document owes the vault a new copy.
    await exec(
      tx,
      `UPDATE documents SET tags = $2::text[], updated_at = $3,
              publish_state = CASE WHEN status IN ('approved','handed_off') AND publish_version IS NOT NULL
                                   THEN 'pending' ELSE publish_state END
        WHERE id = $1`,
      [p.docId, p.tags, e.createdAt],
    );
  },
  DocumentVersionSaved: async (tx, e) => {
    const p = ev<'DocumentVersionSaved'>(e).payload;
    await exec(
      tx,
      `INSERT INTO document_versions (id, document_id, version, content, note, saved_by_kind, saved_by_id, event_seq, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (document_id, version) DO NOTHING`,
      [
        p.versionId,
        p.docId,
        p.version,
        p.content,
        p.note ?? null,
        p.savedBy.kind,
        p.savedBy.id,
        e.seq.toString(),
        e.createdAt,
      ],
    );
    await exec(
      tx,
      `UPDATE documents SET current_version = GREATEST(current_version, $2), title = COALESCE($3, title),
              source_thread_ids = COALESCE($4::uuid[], source_thread_ids), updated_at = $5
        WHERE id = $1`,
      [p.docId, p.version, p.title ?? null, p.sourceThreadIds ?? null, e.createdAt],
    );
  },
  DocumentStatusChanged: async (tx, e) => {
    const p = ev<'DocumentStatusChanged'>(e).payload;
    // Approving owes the vault a copy of that version (`pending` until a `DocumentPublishQueued` says it was handed on).
    await exec(
      tx,
      `UPDATE documents SET status = $2,
              approved_version = CASE WHEN $2 = 'approved' THEN $3 WHEN $2 = 'draft' THEN NULL ELSE approved_version END,
              publish_state = CASE WHEN $2 = 'approved' THEN 'pending' ELSE publish_state END,
              publish_version = CASE WHEN $2 = 'approved' THEN $3 ELSE publish_version END,
              updated_at = $4
        WHERE id = $1`,
      [p.docId, p.to, p.version, e.createdAt],
    );
  },
  DocumentPublishQueued: async (tx, e) => {
    const p = ev<'DocumentPublishQueued'>(e).payload;
    // A newer approval (publish_version moved on) keeps the document pending.
    await exec(
      tx,
      `UPDATE documents SET published_version = $2, vault_id = $3, vault_path = $4,
              publish_state = CASE WHEN publish_version = $2 THEN 'queued' ELSE publish_state END,
              updated_at = $5
        WHERE id = $1`,
      [p.docId, p.version, p.vaultId, p.vaultPath, e.createdAt],
    );
  },
};
