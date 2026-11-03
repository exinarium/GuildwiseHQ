import type { EventOf, EventType } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;

/**
 * Journeys: definitions, the shared record (status, step, timestamps and references only), instances and one row per
 * visit of a step. Every projector is an insert or update keyed by the event's ids, so a rebuild gives the same rows.
 */
export const journeyProjectors: Record<string, Projector> = {
  JourneySaved: async (tx, e) => {
    const p = ev<'JourneySaved'>(e).payload;
    await exec(
      tx,
      `INSERT INTO journeys (id, org_id, project_id, name, record_type, current_version, status, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$8)
       ON CONFLICT (id) DO UPDATE SET name=$4, record_type=$5, current_version=$6, updated_at=$8`,
      [
        p.journeyId,
        p.orgId,
        p.projectId,
        p.definition.name,
        p.definition.recordType,
        p.version,
        p.by,
        e.createdAt,
      ],
    );
    await exec(
      tx,
      `INSERT INTO journey_versions (journey_id, version, definition, saved_by, saved_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (journey_id, version) DO NOTHING`,
      [p.journeyId, p.version, JSON.stringify(p.definition), p.by, e.createdAt],
    );
  },

  JourneyArchived: async (tx, e) => {
    const p = ev<'JourneyArchived'>(e).payload;
    await exec(tx, `UPDATE journeys SET status='archived', updated_at=$2 WHERE id=$1`, [
      p.journeyId,
      e.createdAt,
    ]);
  },

  JourneyRecordCreated: async (tx, e) => {
    const p = ev<'JourneyRecordCreated'>(e).payload;
    await exec(
      tx,
      `INSERT INTO journey_records (id, org_id, project_id, record_type, external_id, display_name, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$7) ON CONFLICT (id) DO NOTHING`,
      [p.recordId, p.orgId, p.projectId, p.recordType, p.externalId ?? null, p.displayName, e.createdAt],
    );
  },

  JourneyRecordReferenceAdded: async (tx, e) => {
    const p = ev<'JourneyRecordReferenceAdded'>(e).payload;
    await addRef(tx, p.recordId, p.kind, p.ref, p.label ?? null, e.createdAt);
  },

  JourneyRecordClosed: async (tx, e) => {
    const p = ev<'JourneyRecordClosed'>(e).payload;
    await exec(tx, `UPDATE journey_records SET status='closed', updated_at=$2 WHERE id=$1`, [
      p.recordId,
      e.createdAt,
    ]);
  },

  JourneyInstanceStarted: async (tx, e) => {
    const p = ev<'JourneyInstanceStarted'>(e).payload;
    await exec(
      tx,
      `INSERT INTO journey_instances (id, org_id, project_id, journey_id, journey_version, record_id, status,
         current_visit, current_step_id, started_by, started_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'running',0,$7,$8,$9,$9) ON CONFLICT (id) DO NOTHING`,
      [
        p.instanceId,
        p.orgId,
        p.projectId,
        p.journeyId,
        p.version,
        p.recordId,
        p.firstStepId,
        p.startedBy,
        e.createdAt,
      ],
    );
    await exec(
      tx,
      `UPDATE journey_records SET current_instance_id=$2, current_step_id=$3, updated_at=$4 WHERE id=$1`,
      [p.recordId, p.instanceId, p.firstStepId, e.createdAt],
    );
  },

  JourneyStepEntered: async (tx, e) => {
    const p = ev<'JourneyStepEntered'>(e).payload;
    const placeholder = p.kind !== 'workflow';
    await exec(
      tx,
      `INSERT INTO journey_step_runs (instance_id, visit, step_id, handoff_id, from_visit, status, entered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (instance_id, visit) DO NOTHING`,
      [
        p.instanceId,
        p.visit,
        p.stepId,
        p.handoffId ?? null,
        p.fromVisit ?? null,
        placeholder ? 'waiting' : 'pending',
        e.createdAt,
      ],
    );
    await exec(
      tx,
      `UPDATE journey_instances SET status=$2, current_visit=$3, current_step_id=$4, updated_at=$5 WHERE id=$1`,
      [p.instanceId, placeholder ? 'waiting' : 'running', p.visit, p.stepId, e.createdAt],
    );
    await exec(
      tx,
      `UPDATE journey_records SET current_step_id=$2, updated_at=$3
        WHERE id=(SELECT record_id FROM journey_instances WHERE id=$1)`,
      [p.instanceId, p.stepId, e.createdAt],
    );
  },

  JourneyStepCardStarted: async (tx, e) => {
    const p = ev<'JourneyStepCardStarted'>(e).payload;
    await exec(
      tx,
      `UPDATE journey_step_runs SET status='open', card_id=$3, started_at=$4 WHERE instance_id=$1 AND visit=$2`,
      [p.instanceId, p.visit, p.cardId, e.createdAt],
    );
    await exec(tx, `UPDATE journey_instances SET status='running', updated_at=$2 WHERE id=$1`, [
      p.instanceId,
      e.createdAt,
    ]);
    await exec(
      tx,
      `INSERT INTO journey_record_refs (record_id, kind, ref, label, added_at)
       SELECT record_id, 'card', $2, $3, $4 FROM journey_instances WHERE id=$1
       ON CONFLICT (record_id, kind, ref) DO NOTHING`,
      [p.instanceId, p.cardId, p.workflowKey, e.createdAt],
    );
  },

  JourneyStepRefused: async (tx, e) => {
    const p = ev<'JourneyStepRefused'>(e).payload;
    await exec(
      tx,
      `UPDATE journey_step_runs SET status='refused', desk_item_id=$3, ended_at=$4 WHERE instance_id=$1 AND visit=$2`,
      [p.instanceId, p.visit, p.deskItemId ?? null, e.createdAt],
    );
  },

  JourneyStepCompleted: async (tx, e) => {
    const p = ev<'JourneyStepCompleted'>(e).payload;
    await exec(
      tx,
      `UPDATE journey_step_runs SET status=$3, ended_at=$4 WHERE instance_id=$1 AND visit=$2`,
      [p.instanceId, p.visit, p.result, e.createdAt],
    );
  },

  JourneyStepPlaybookStarted: async (tx, e) => {
    const p = ev<'JourneyStepPlaybookStarted'>(e).payload;
    await exec(
      tx,
      `UPDATE journey_step_runs SET playbook_thread_id=$3 WHERE instance_id=$1 AND visit=$2`,
      [p.instanceId, p.visit, p.threadId],
    );
    await exec(
      tx,
      `INSERT INTO journey_record_refs (record_id, kind, ref, label, added_at)
       SELECT record_id, 'playbook_session', $2, $3, $4 FROM journey_instances WHERE id=$1
       ON CONFLICT (record_id, kind, ref) DO NOTHING`,
      [p.instanceId, p.threadId, p.playbookKey, e.createdAt],
    );
  },

  JourneyInstanceStuck: async (tx, e) => {
    const p = ev<'JourneyInstanceStuck'>(e).payload;
    await exec(tx, `UPDATE journey_instances SET status='stuck', updated_at=$2 WHERE id=$1`, [
      p.instanceId,
      e.createdAt,
    ]);
    if (p.deskItemId)
      await exec(
        tx,
        `UPDATE journey_step_runs SET desk_item_id=COALESCE(desk_item_id,$3) WHERE instance_id=$1 AND visit=$2`,
        [p.instanceId, p.visit, p.deskItemId],
      );
  },

  JourneyInstanceCompleted: async (tx, e) => {
    const p = ev<'JourneyInstanceCompleted'>(e).payload;
    await endInstance(tx, p.instanceId, 'completed', e.createdAt);
  },

  JourneyInstanceCancelled: async (tx, e) => {
    const p = ev<'JourneyInstanceCancelled'>(e).payload;
    await endInstance(tx, p.instanceId, 'cancelled', e.createdAt);
  },
};

async function endInstance(
  tx: Parameters<Projector>[0],
  instanceId: string,
  status: 'completed' | 'cancelled',
  at: Date | string,
): Promise<void> {
  await exec(tx, `UPDATE journey_instances SET status=$2, ended_at=$3, updated_at=$3 WHERE id=$1`, [
    instanceId,
    status,
    at,
  ]);
  await exec(
    tx,
    `UPDATE journey_records SET current_instance_id=NULL, current_step_id=NULL, updated_at=$2
      WHERE id=(SELECT record_id FROM journey_instances WHERE id=$1) AND current_instance_id=$1`,
    [instanceId, at],
  );
}

async function addRef(
  tx: Parameters<Projector>[0],
  recordId: string,
  kind: string,
  ref: string,
  label: string | null,
  at: Date | string,
): Promise<void> {
  await exec(
    tx,
    `INSERT INTO journey_record_refs (record_id, kind, ref, label, added_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (record_id, kind, ref) DO NOTHING`,
    [recordId, kind, ref, label, at],
  );
}
