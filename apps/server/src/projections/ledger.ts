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
  LedgerEntryEdited: async (tx, e) => {
    const p = (e.event as EventOf<'LedgerEntryEdited'>).payload;
    const by = e.actor.kind === 'user' || e.actor.kind === 'agent' ? e.actor.id : null;
    // The wording being replaced goes to the history first, with who wrote it and when it came into force.
    await exec(
      tx,
      `INSERT INTO ledger_entry_versions (entry_id, version, title, body, tags, saved_by_kind, saved_by_id, saved_at, replaced_at)
       SELECT id, version, title, body, tags, COALESCE(edited_by_kind, created_by_kind),
              CASE WHEN edited_at IS NULL THEN created_by_id ELSE edited_by_id END, COALESCE(edited_at, created_at), $2
         FROM ledger_entries WHERE id=$1`,
      [p.entryId, e.createdAt],
    );
    await exec(
      tx,
      `UPDATE ledger_entries SET title=$2, body=$3, tags=$4, version=version+1, edited_at=$5, edited_by_kind=$6, edited_by_id=$7
        WHERE id=$1`,
      [p.entryId, p.title, p.body, p.tags, e.createdAt, e.actor.kind, by],
    );
  },
  LedgerEntrySuperseded: async (tx, e) => {
    const p = (e.event as EventOf<'LedgerEntrySuperseded'>).payload;
    await exec(tx, 'UPDATE ledger_entries SET superseded_by=$2 WHERE id=$1', [p.entryId, p.supersededBy]);
  },
};
