import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

export const ledgerProjectors: Record<string, Projector> = {
  LedgerEntryAdded: async (tx, e) => {
    const p = (e.event as EventOf<'LedgerEntryAdded'>).payload;
    await exec(
      tx,
      `INSERT INTO ledger_entries (id, org_id, project_id, card_id, scope, title, body, tags, source_desk_item_id, vault_path,
         created_by_kind, created_by_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        p.entryId,
        e.scope.orgId,
        p.projectId ?? null,
        p.cardId ?? null,
        p.scope,
        p.title,
        p.body,
        p.tags,
        p.sourceDeskItemId ?? null,
        p.vaultPath ?? null,
        e.actor.kind,
        e.actor.kind === 'user' || e.actor.kind === 'agent' ? e.actor.id : null,
        e.createdAt,
      ],
    );
  },
  LedgerEntrySuperseded: async (tx, e) => {
    const p = (e.event as EventOf<'LedgerEntrySuperseded'>).payload;
    await exec(tx, 'UPDATE ledger_entries SET superseded_by=$2 WHERE id=$1', [p.entryId, p.supersededBy]);
  },
};
