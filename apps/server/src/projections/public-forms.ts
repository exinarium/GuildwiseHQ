import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

type T =
  | 'FormPublished'
  | 'FormUnpublished'
  | 'FormPublicLinkReset'
  | 'FormClientLinkCreated'
  | 'FormClientLinkRevoked'
  | 'FormClientLinkUsed';
const ev = <K extends T>(e: StoredEvent) => e.event as EventOf<K>;

/** Public hosting of forms and the per-client links. No answers, no tokens: the link id and its expiry only. */
export const publicFormProjectors: Record<string, Projector> = {
  FormPublished: async (tx, e) => {
    const p = ev<'FormPublished'>(e).payload;
    await exec(
      tx,
      `INSERT INTO form_publications (form_id, org_id, public_id, version, status, published_at, published_by)
       VALUES ($1,$2,$3,$4,'published',$5,$6)
       ON CONFLICT (form_id) DO UPDATE SET public_id=EXCLUDED.public_id, version=EXCLUDED.version, status='published',
         published_at=EXCLUDED.published_at, published_by=EXCLUDED.published_by, unpublished_at=NULL`,
      [p.formId, p.orgId, p.publicId, p.version, e.createdAt, p.by],
    );
  },
  FormUnpublished: async (tx, e) => {
    const p = ev<'FormUnpublished'>(e).payload;
    await exec(tx, `UPDATE form_publications SET status='unpublished', unpublished_at=$2 WHERE form_id=$1`, [
      p.formId,
      e.createdAt,
    ]);
  },
  FormPublicLinkReset: async (tx, e) => {
    const p = ev<'FormPublicLinkReset'>(e).payload;
    await exec(tx, `UPDATE form_publications SET public_id=$2 WHERE form_id=$1`, [p.formId, p.publicId]);
  },
  FormClientLinkCreated: async (tx, e) => {
    const p = ev<'FormClientLinkCreated'>(e).payload;
    await exec(
      tx,
      `INSERT INTO form_client_links (id, org_id, form_id, reference, record_kind, record_id, expires_at, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.linkId,
        p.orgId,
        p.formId,
        p.reference,
        p.recordKind ?? null,
        p.recordId ?? null,
        p.expiresAt,
        p.by,
        e.createdAt,
      ],
    );
  },
  FormClientLinkRevoked: async (tx, e) => {
    const p = ev<'FormClientLinkRevoked'>(e).payload;
    await exec(
      tx,
      `UPDATE form_client_links SET revoked_at=COALESCE(revoked_at,$2), revoked_by=COALESCE(revoked_by,$3) WHERE id=$1`,
      [p.linkId, e.createdAt, p.by],
    );
  },
  FormClientLinkUsed: async (tx, e) => {
    const p = ev<'FormClientLinkUsed'>(e).payload;
    await exec(
      tx,
      `UPDATE form_client_links SET used_at=COALESCE(used_at,$2), used_by_submission=COALESCE(used_by_submission,$3) WHERE id=$1`,
      [p.linkId, e.createdAt, p.submissionId],
    );
  },
};
