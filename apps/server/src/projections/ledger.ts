import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

export const ledgerProjectors: Record<string, Projector> = {
  LedgerEntryAdded: async (tx, e) => {
    const p = (e.event as EventOf<'LedgerEntryAdded'>).payload;
    await exec(
      tx,
      `INSERT INTO ledger_entries (id, org_id, project_id, card_id, scope, title, body, tags, source_desk_item_id, vault_path,
         created_by_kind, created_by_id, created_at, review_date, rule_pack_id, rule_pack_rule_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,$15,$16)`,
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
        p.reviewDate ?? null,
        p.rulePack?.packId ?? null,
        p.rulePack?.ruleId ?? null,
      ],
    );
  },
  RulePackInstalled: async (tx, e) => {
    const p = (e.event as EventOf<'RulePackInstalled'>).payload;
    await exec(
      tx,
      `INSERT INTO org_rule_packs (org_id, pack_id, pack_version, installed_at, installed_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id, pack_id) DO UPDATE
         SET pack_version=EXCLUDED.pack_version, removed_at=NULL, removed_by=NULL,
             installed_at = CASE WHEN org_rule_packs.removed_at IS NULL THEN org_rule_packs.installed_at ELSE EXCLUDED.installed_at END,
             installed_by = CASE WHEN org_rule_packs.removed_at IS NULL THEN org_rule_packs.installed_by ELSE EXCLUDED.installed_by END`,
      [e.scope.orgId, p.packId, p.packVersion, e.createdAt, e.actor.kind === 'user' ? e.actor.id : null],
    );
  },
  RulePackRemoved: async (tx, e) => {
    const p = (e.event as EventOf<'RulePackRemoved'>).payload;
    await exec(tx, 'UPDATE org_rule_packs SET removed_at=$3, removed_by=$4 WHERE org_id=$1 AND pack_id=$2', [
      e.scope.orgId,
      p.packId,
      e.createdAt,
      e.actor.kind === 'user' ? e.actor.id : null,
    ]);
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
  LedgerEntryRetired: async (tx, e) => {
    const p = (e.event as EventOf<'LedgerEntryRetired'>).payload;
    await exec(
      tx,
      `UPDATE ledger_entries SET retired_at=COALESCE(retired_at, $2), retired_reason=COALESCE(retired_reason, $3),
              retired_by=COALESCE(retired_by, $4), superseded_by=COALESCE(superseded_by, $5::uuid) WHERE id=$1`,
      [p.entryId, e.createdAt, p.reason, p.by ?? e.actor.kind, p.supersededBy ?? null],
    );
  },
  LedgerEntryReviewDateSet: async (tx, e) => {
    const p = (e.event as EventOf<'LedgerEntryReviewDateSet'>).payload;
    await exec(
      tx,
      `UPDATE ledger_entries SET review_date=$2::date, reviewed_at=CASE WHEN $3::boolean THEN $4::timestamptz ELSE reviewed_at END
        WHERE id=$1`,
      [p.entryId, p.reviewDate, p.confirmed, e.createdAt],
    );
  },
  LedgerEntryFlagged: async (tx, e) => {
    const p = (e.event as EventOf<'LedgerEntryFlagged'>).payload;
    await exec(tx, 'UPDATE ledger_entries SET conflicts_with=$2 WHERE id=$1', [p.entryId, p.conflictsWith]);
  },
};
