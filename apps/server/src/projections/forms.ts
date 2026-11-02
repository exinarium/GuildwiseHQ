import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <T extends 'FormVersionSaved' | 'FormArchived' | 'FormUnarchived'>(e: StoredEvent) =>
  e.event as EventOf<T>;

/**
 * Forms and their versions. A version row is only ever inserted (never updated): a replay finds it and leaves it.
 * Writes use the event time. The logo bytes are not here (`org_brand_images` is operational).
 */
export const formProjectors: Record<string, Projector> = {
  FormVersionSaved: async (tx, e) => {
    const p = ev<'FormVersionSaved'>(e).payload;
    await exec(
      tx,
      `INSERT INTO form_versions (form_id, version, org_id, definition, definition_hash, saved_by, saved_at, event_seq)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)
       ON CONFLICT (form_id, version) DO NOTHING`,
      [
        p.formId,
        p.version,
        p.orgId,
        JSON.stringify(p.definition),
        p.definitionHash,
        p.by,
        e.createdAt,
        e.seq,
      ],
    );
    await exec(
      tx,
      `INSERT INTO forms (id, org_id, title, latest_version, status, field_count, created_by, created_at, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         latest_version = EXCLUDED.latest_version,
         field_count = EXCLUDED.field_count,
         updated_by = EXCLUDED.updated_by,
         updated_at = EXCLUDED.updated_at
       WHERE forms.latest_version < EXCLUDED.latest_version`,
      [
        p.formId,
        p.orgId,
        p.definition.settings.title,
        p.version,
        p.definition.fields.length,
        p.by,
        e.createdAt,
      ],
    );
  },
  FormArchived: async (tx, e) => {
    const p = ev<'FormArchived'>(e).payload;
    await exec(tx, `UPDATE forms SET status='archived' WHERE id=$1`, [p.formId]);
  },
  FormUnarchived: async (tx, e) => {
    const p = ev<'FormUnarchived'>(e).payload;
    await exec(tx, `UPDATE forms SET status='active' WHERE id=$1`, [p.formId]);
  },
};
