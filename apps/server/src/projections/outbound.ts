import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <
  T extends
    | 'OutboundDrafted'
    | 'OutboundHeld'
    | 'OutboundBlocked'
    | 'OutboundApproved'
    | 'OutboundRejected'
    | 'OutboundPosted'
    | 'OutboundPostFailed'
    | 'OutboundRetryRequested',
>(
  e: StoredEvent,
) => e.event as EventOf<T>;

const COLUMNS = `id, org_id, project_id, card_id, external_system, external_key, external_url, kind, body, status,
       desk_item_id, drafted_by_kind, drafted_by_id, blocked_matches, created_at, updated_at`;

export const outboundProjectors: Record<string, Projector> = {
  OutboundDrafted: async (tx, e) => {
    const p = ev<'OutboundDrafted'>(e).payload;
    await exec(
      tx,
      `INSERT INTO outbound_drafts (${COLUMNS})
       SELECT $1, $2, c.project_id, c.id, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, '[]', $11, $11 FROM cards c WHERE c.id=$12`,
      [
        p.draftId,
        e.scope.orgId,
        p.externalSystem,
        p.externalKey,
        p.externalUrl ?? null,
        p.kind,
        p.body,
        p.deskItemId,
        p.draftedBy?.kind ?? null,
        p.draftedBy ? (p.draftedBy.kind === 'agent' ? p.draftedBy.agentId : p.draftedBy.userId) : null,
        e.createdAt,
        p.cardId,
      ],
    );
  },

  // A draft held until manual QA passes or is skipped: no desk item yet.
  OutboundHeld: async (tx, e) => {
    const p = ev<'OutboundHeld'>(e).payload;
    await exec(
      tx,
      `INSERT INTO outbound_drafts (${COLUMNS})
       SELECT $1, $2, c.project_id, c.id, $3, $4, $5, $6, $7, 'held', NULL, $8, $9, '[]', $10, $10 FROM cards c WHERE c.id=$11`,
      [
        p.draftId,
        e.scope.orgId,
        p.externalSystem,
        p.externalKey,
        p.externalUrl ?? null,
        p.kind,
        p.body,
        p.draftedBy?.kind ?? null,
        p.draftedBy ? (p.draftedBy.kind === 'agent' ? p.draftedBy.agentId : p.draftedBy.userId) : null,
        e.createdAt,
        p.cardId,
      ],
    );
  },

  OutboundBlocked: async (tx, e) => {
    const p = ev<'OutboundBlocked'>(e).payload;
    await exec(
      tx,
      `INSERT INTO outbound_drafts (${COLUMNS})
       SELECT $1, $2, c.project_id, c.id, $3, $4, NULL, $5, $6, 'blocked', NULL, $7, $8, $9, $10, $10 FROM cards c WHERE c.id=$11`,
      [
        p.draftId,
        e.scope.orgId,
        p.externalSystem,
        p.externalKey,
        p.kind,
        p.body,
        p.draftedBy?.kind ?? null,
        p.draftedBy ? (p.draftedBy.kind === 'agent' ? p.draftedBy.agentId : p.draftedBy.userId) : null,
        JSON.stringify(p.matches),
        e.createdAt,
        p.cardId,
      ],
    );
  },

  OutboundApproved: async (tx, e) => {
    const p = ev<'OutboundApproved'>(e).payload;
    await exec(
      tx,
      `UPDATE outbound_drafts SET status='approved', final_body=$2, edited=$3, approved_by=$4, approved_at=$5,
              error=NULL, updated_at=$5 WHERE id=$1`,
      [p.draftId, p.finalBody, p.edited, p.approvedBy, e.createdAt],
    );
  },

  OutboundRejected: async (tx, e) => {
    const p = ev<'OutboundRejected'>(e).payload;
    await exec(
      tx,
      `UPDATE outbound_drafts SET status='rejected', reject_reason=$2, updated_at=$3 WHERE id=$1`,
      [p.draftId, p.reason ?? null, e.createdAt],
    );
  },

  OutboundPosted: async (tx, e) => {
    const p = ev<'OutboundPosted'>(e).payload;
    await exec(
      tx,
      `UPDATE outbound_drafts SET status='posted', external_ref=$2, posted_at=$3, error=NULL, updated_at=$3 WHERE id=$1`,
      [p.draftId, p.externalRef ?? null, e.createdAt],
    );
  },

  OutboundPostFailed: async (tx, e) => {
    const p = ev<'OutboundPostFailed'>(e).payload;
    await exec(
      tx,
      `UPDATE outbound_drafts SET status='failed', error=$2, attempts = attempts + 1,
              desk_item_id = COALESCE($3, desk_item_id), updated_at=$4 WHERE id=$1`,
      [p.draftId, p.error, p.alertDeskItemId ?? null, e.createdAt],
    );
  },

  OutboundRetryRequested: async (tx, e) => {
    const p = ev<'OutboundRetryRequested'>(e).payload;
    await exec(tx, `UPDATE outbound_drafts SET status='approved', error=NULL, updated_at=$2 WHERE id=$1`, [
      p.draftId,
      e.createdAt,
    ]);
  },
};
