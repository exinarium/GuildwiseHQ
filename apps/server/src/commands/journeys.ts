import { randomUUID } from 'node:crypto';
import {
  type CreateJourneyBody,
  getJourneyTemplate,
  getJourneyStep,
  type JourneyDefinition,
  JourneyDefinitionSchema,
  type JourneyReferenceInput,
  type StartInstanceBody,
  streamId,
  validateJourney,
} from '@aom/shared';
import type { Who } from '../auth/org-context.ts';
import { loadVisibleProject, visibleProjectIds } from '../authz/scope.ts';
import { enabledWorkflows } from '../catalogue/project-workflows.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { runPlaybookSession } from '../sessions/playbooks.ts';
import { projectScope, userActor } from './common.ts';
import {
  cancelInstance as cancelInstanceRuntime,
  continuePlaceholder,
  loadDefinition,
} from './journey-runtime.ts';

/** Journeys: the definitions, the shared record and the instances (the runtime that moves them is journey-runtime.ts). */

async function validationFor(db: Queryable, project: Row, def: JourneyDefinition) {
  const enabled = (await enabledWorkflows(db, project)).map((e) => e.workflowKey);
  const forms = await rows(
    db,
    `SELECT form_id FROM form_publications WHERE org_id=$1 AND status='published'`,
    [project.org_id],
  );
  return validateJourney(def, {
    enabledWorkflowKeys: new Set(enabled),
    publishedFormIds: new Set(forms.map((f) => f.form_id as string)),
  });
}

function assertAuthor(project: Row): void {
  if (project.my_role !== 'owner') throw forbidden('only the project owner and the organization Owner and Admins can edit journeys');
}

async function loadJourney(db: Queryable, userId: string, id: string): Promise<{ journey: Row; project: Row }> {
  const journey = await one(db, 'SELECT * FROM journeys WHERE id=$1', [id]);
  if (!journey) throw notFound('journey not found');
  const project = await loadVisibleProject(db, userId, journey.project_id);
  return { journey, project };
}

export async function listJourneys(ctx: Ctx, who: Who, projectId?: string) {
  const ids = projectId
    ? [(await loadVisibleProject(ctx.pool, who.userId, projectId)).id as string]
    : await visibleProjectIds(ctx.pool, who.userId);
  const list = await rows(
    ctx.pool,
    `SELECT j.*, v.definition,
            (SELECT count(*)::int FROM journey_instances i WHERE i.journey_id=j.id AND i.status IN ('running','waiting','stuck')) AS running
       FROM journeys j JOIN journey_versions v ON v.journey_id=j.id AND v.version=j.current_version
      WHERE j.project_id = ANY($1::uuid[]) AND j.status='active' ORDER BY j.name`,
    [ids],
  );
  return {
    items: list.map((j) => ({
      id: j.id,
      projectId: j.project_id,
      name: j.name,
      recordType: j.record_type,
      version: j.current_version,
      stepCount: (j.definition.steps ?? []).length,
      running: j.running,
      updatedAt: iso(j.updated_at),
    })),
  };
}

export async function getJourney(ctx: Ctx, who: Who, id: string, version?: number) {
  const { journey, project } = await loadJourney(ctx.pool, who.userId, id);
  const def = await loadDefinition(ctx.pool, id, version ?? journey.current_version);
  return {
    id,
    projectId: journey.project_id,
    status: journey.status,
    version: version ?? journey.current_version,
    currentVersion: journey.current_version,
    canEdit: project.my_role === 'owner',
    definition: def,
    validation: await validationFor(ctx.pool, project, def),
  };
}

export async function createJourney(ctx: Ctx, who: Who, body: CreateJourneyBody) {
  const project = await loadVisibleProject(ctx.pool, who.userId, body.projectId);
  assertAuthor(project);
  let def: JourneyDefinition;
  if (body.templateId) {
    const t = getJourneyTemplate(body.templateId);
    if (!t) throw notFound('template not found');
    def = JourneyDefinitionSchema.parse(structuredClone(t.definition));
  } else def = JourneyDefinitionSchema.parse(body.definition);
  const id = randomUUID();
  await ctx.store.append([savedEvent(id, project, def, 1, who.userId)]);
  return { id, version: 1, validation: await validationFor(ctx.pool, project, def) };
}

const savedEvent = (id: string, project: Row, def: JourneyDefinition, version: number, by: string): AppendInput => ({
  streamId: streamId.journey(id),
  event: { type: 'JourneySaved', payload: { journeyId: id, orgId: project.org_id, projectId: project.id, version, definition: def, by } },
  actor: userActor(by),
  scope: projectScope(project.org_id, project.id),
});

export async function saveJourney(ctx: Ctx, who: Who, id: string, definition: JourneyDefinition, baseVersion: number) {
  return withAppendTx(ctx.pool, async (tx) => {
    const { journey, project } = await loadJourney(tx, who.userId, id);
    assertAuthor(project);
    await tx.query('SELECT 1 FROM journeys WHERE id=$1 FOR UPDATE', [id]);
    const cur = (await one(tx, 'SELECT current_version, status FROM journeys WHERE id=$1', [id])) as Row;
    if (cur.status !== 'active') throw conflict('journey_archived', 'the journey is archived');
    if (cur.current_version !== baseVersion)
      throw conflict('stale_version', 'the journey was saved by someone else: reload it first', { currentVersion: cur.current_version });
    if (definition.recordType !== journey.record_type) {
      const running = await one(tx, `SELECT 1 FROM journey_instances WHERE journey_id=$1 AND status IN ('running','waiting','stuck') LIMIT 1`, [id]);
      if (running) throw conflict('instances_running', 'the record type cannot change while instances run');
    }
    const version = cur.current_version + 1;
    await ctx.store.append([savedEvent(id, project, definition, version, who.userId)], { tx });
    return { id, version, validation: await validationFor(tx, project, definition) };
  });
}

export async function archiveJourney(ctx: Ctx, who: Who, id: string) {
  const { project } = await loadJourney(ctx.pool, who.userId, id);
  assertAuthor(project);
  await ctx.store.append([
    {
      streamId: streamId.journey(id),
      event: { type: 'JourneyArchived', payload: { journeyId: id } },
      actor: userActor(who.userId),
      scope: projectScope(project.org_id, project.id),
    },
  ]);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------- records

export function recordDto(r: Row, refs: Row[]) {
  return {
    id: r.id,
    orgId: r.org_id,
    projectId: r.project_id,
    type: r.record_type,
    externalId: r.external_id ?? null,
    displayName: r.display_name,
    status: r.status,
    currentInstanceId: r.current_instance_id ?? null,
    currentStepId: r.current_step_id ?? null,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
    references: refs.map((x) => ({ kind: x.kind, ref: x.ref, label: x.label ?? null, addedAt: iso(x.added_at) as string })),
  };
}

export async function getRecord(ctx: Ctx, who: Who, id: string) {
  const r = await one(ctx.pool, 'SELECT * FROM journey_records WHERE id=$1', [id]);
  if (!r) throw notFound('record not found');
  await loadVisibleProject(ctx.pool, who.userId, r.project_id);
  const refs = await rows(ctx.pool, 'SELECT * FROM journey_record_refs WHERE record_id=$1 ORDER BY added_at, ref', [id]);
  return recordDto(r, refs);
}

export async function addReference(ctx: Ctx, who: Who, recordId: string, ref: JourneyReferenceInput) {
  const r = await one(ctx.pool, 'SELECT * FROM journey_records WHERE id=$1', [recordId]);
  if (!r) throw notFound('record not found');
  const project = await loadVisibleProject(ctx.pool, who.userId, r.project_id);
  await ctx.store.append([
    {
      streamId: streamId.journeyRecord(recordId),
      event: { type: 'JourneyRecordReferenceAdded', payload: { recordId, kind: ref.kind, ref: ref.ref, ...(ref.label ? { label: ref.label } : {}) } },
      actor: userActor(who.userId),
      scope: projectScope(project.org_id, project.id),
    },
  ]);
  return getRecord(ctx, who, recordId);
}

// -------------------------------------------------------------------------------------------- instances

/** Starts a journey on a record (new, or an existing one without a running instance): the instance is at the first step. */
export async function startInstance(ctx: Ctx, who: Who, body: StartInstanceBody) {
  return withAppendTx(ctx.pool, async (tx) => {
    const { journey, project } = await loadJourney(tx, who.userId, body.journeyId);
    if (journey.status !== 'active') throw conflict('journey_archived', 'the journey is archived');
    const def = await loadDefinition(tx, journey.id, journey.current_version);
    return startInstanceIn(tx, ctx, {
      project,
      journey,
      def,
      record: 'recordId' in body.record ? { recordId: body.record.recordId } : { create: body.record },
      startedBy: who.userId,
      actor: userActor(who.userId),
    });
  });
}

/** Starts an instance inside the caller's append transaction (a user, or an inbound hook in the trigger creator's name). */
export async function startInstanceIn(
  tx: Tx,
  ctx: Ctx,
  a: {
    project: Row;
    journey: Row;
    def: JourneyDefinition;
    record: { recordId: string } | { create: { type: string; displayName: string; externalId?: string | undefined } };
    startedBy: string;
    actor: AppendInput['actor'];
    /** Events appended after the instance's own (the hook's `JourneyStartedByHook`). */
    after?: (ids: { instanceId: string; recordId: string; matched: boolean }) => AppendInput[];
  },
): Promise<{ id: string; recordId: string }> {
  const { journey, project, def } = a;
  const v = await validationFor(tx, project, def);
  if (v.errors.length) throw badRequest('journey_invalid', 'fix the journey before starting it', v.errors);
  const events: AppendInput[] = [];
  const scope = projectScope(project.org_id, project.id);
  let recordId: string;
  const matched = 'recordId' in a.record;
  if ('recordId' in a.record) {
    const rec = await one(tx, 'SELECT * FROM journey_records WHERE id=$1 FOR UPDATE', [a.record.recordId]);
    if (!rec || rec.project_id !== project.id) throw notFound('record not found');
    if (rec.record_type !== def.recordType) throw badRequest('record_type_mismatch', `this journey runs on a ${def.recordType}`);
    if (rec.status !== 'active') throw conflict('record_closed', 'the record is closed');
    if (rec.current_instance_id) throw conflict('record_busy', 'a journey is already running on this record');
    recordId = rec.id;
  } else {
    const c = a.record.create;
    if (c.type !== def.recordType) throw badRequest('record_type_mismatch', `this journey runs on a ${def.recordType}`);
    recordId = randomUUID();
    events.push({
      streamId: streamId.journeyRecord(recordId),
      event: {
        type: 'JourneyRecordCreated',
        payload: {
          recordId,
          orgId: project.org_id,
          projectId: project.id,
          recordType: c.type as never,
          displayName: c.displayName,
          ...(c.externalId ? { externalId: c.externalId } : {}),
        },
      },
      actor: a.actor,
      scope,
    });
  }
  const instanceId = randomUUID();
  const first = getJourneyStep(def, def.firstStepId);
  if (!first) throw badRequest('journey_invalid', 'the first step does not exist');
  const stream = streamId.journeyInstance(instanceId);
  events.push(
    {
      streamId: stream,
      event: {
        type: 'JourneyInstanceStarted',
        payload: {
          instanceId,
          journeyId: journey.id,
          version: journey.current_version,
          recordId,
          orgId: project.org_id,
          projectId: project.id,
          firstStepId: def.firstStepId,
          startedBy: a.startedBy,
        },
      },
      actor: a.actor,
      scope,
    },
    {
      streamId: stream,
      event: { type: 'JourneyStepEntered', payload: { instanceId, visit: 1, stepId: first.id, kind: first.kind } },
      actor: a.actor,
      scope,
    },
    ...(a.after ? a.after({ instanceId, recordId, matched }) : []),
  );
  await ctx.store.append(events, { tx });
  return { id: instanceId, recordId };
}

export interface InstanceFilters {
  projectId?: string | undefined;
  journeyId?: string | undefined;
  status?: string | undefined;
  stepId?: string | undefined;
}

export async function listInstances(ctx: Ctx, who: Who, f: InstanceFilters) {
  const ids = f.projectId
    ? [(await loadVisibleProject(ctx.pool, who.userId, f.projectId)).id as string]
    : await visibleProjectIds(ctx.pool, who.userId);
  const list = await rows(
    ctx.pool,
    `SELECT i.*, j.name AS journey_name, r.display_name, r.record_type, r.external_id, v.definition
       FROM journey_instances i JOIN journeys j ON j.id=i.journey_id JOIN journey_records r ON r.id=i.record_id
       JOIN journey_versions v ON v.journey_id=i.journey_id AND v.version=i.journey_version
      WHERE i.project_id = ANY($1::uuid[])
        AND ($2::uuid IS NULL OR i.journey_id=$2) AND ($3::text IS NULL OR i.status=$3) AND ($4::text IS NULL OR i.current_step_id=$4)
      ORDER BY i.updated_at DESC LIMIT 500`,
    [ids, f.journeyId ?? null, f.status ?? null, f.stepId ?? null],
  );
  return {
    items: list.map((i) => ({
      id: i.id,
      projectId: i.project_id,
      journeyId: i.journey_id,
      journeyName: i.journey_name,
      recordId: i.record_id,
      recordName: i.display_name,
      recordType: i.record_type,
      status: i.status,
      stepId: i.current_step_id,
      stepLabel: (i.definition.steps ?? []).find((s: Row) => s.id === i.current_step_id)?.label ?? i.current_step_id,
      startedAt: iso(i.started_at),
      updatedAt: iso(i.updated_at),
      endedAt: iso(i.ended_at),
    })),
  };
}

async function loadInstance(db: Queryable, userId: string, id: string): Promise<{ inst: Row; project: Row }> {
  const inst = await one(db, 'SELECT * FROM journey_instances WHERE id=$1', [id]);
  if (!inst) throw notFound('instance not found');
  return { inst, project: await loadVisibleProject(db, userId, inst.project_id) };
}

export async function getInstance(ctx: Ctx, who: Who, id: string) {
  const { inst } = await loadInstance(ctx.pool, who.userId, id);
  const def = await loadDefinition(ctx.pool, inst.journey_id, inst.journey_version);
  const journey = (await one(ctx.pool, 'SELECT name FROM journeys WHERE id=$1', [inst.journey_id])) as Row;
  const runs = await rows(
    ctx.pool,
    `SELECT r.*, c.ref AS card_ref, c.status AS card_status FROM journey_step_runs r LEFT JOIN cards c ON c.id=r.card_id
      WHERE r.instance_id=$1 ORDER BY r.visit`,
    [id],
  );
  const rec = await getRecord(ctx, who, inst.record_id);
  return {
    id,
    projectId: inst.project_id,
    journeyId: inst.journey_id,
    journeyName: journey.name,
    journeyVersion: inst.journey_version,
    status: inst.status,
    currentVisit: inst.current_visit,
    currentStepId: inst.current_step_id,
    startedAt: iso(inst.started_at),
    updatedAt: iso(inst.updated_at),
    endedAt: iso(inst.ended_at),
    definition: def,
    record: rec,
    history: runs.map((r) => ({
      visit: r.visit,
      stepId: r.step_id,
      stepLabel: def.steps.find((s) => s.id === r.step_id)?.label ?? r.step_id,
      handoffId: r.handoff_id ?? null,
      status: r.status,
      cardId: r.card_id ?? null,
      cardRef: r.card_ref ?? null,
      playbookThreadId: r.playbook_thread_id ?? null,
      enteredAt: iso(r.entered_at),
      startedAt: iso(r.started_at),
      endedAt: iso(r.ended_at),
    })),
  };
}

export async function continueStep(ctx: Ctx, who: Who, id: string, visit: number) {
  await loadInstance(ctx.pool, who.userId, id);
  const moved = await continuePlaceholder(ctx, id, visit);
  if (!moved) throw conflict('not_waiting', 'this step is not waiting any more');
  return { ok: true };
}

export async function cancelInstance(ctx: Ctx, who: Who, id: string) {
  await loadInstance(ctx.pool, who.userId, id);
  await cancelInstanceRuntime(ctx, id, who.userId);
  return { ok: true };
}

/** Starts the step's playbook through the playbook feature, unchanged, and keeps the session as a reference. */
export async function runStepPlaybook(ctx: Ctx, who: Who, id: string, visit: number, workstationId?: string) {
  const { inst } = await loadInstance(ctx.pool, who.userId, id);
  if (inst.status === 'completed' || inst.status === 'cancelled') throw conflict('instance_ended', 'the instance has ended');
  const run = await one(ctx.pool, 'SELECT * FROM journey_step_runs WHERE instance_id=$1 AND visit=$2', [id, visit]);
  if (!run) throw notFound('step not found');
  const def = await loadDefinition(ctx.pool, inst.journey_id, inst.journey_version);
  const step = getJourneyStep(def, run.step_id);
  if (!step || step.kind !== 'workflow' || !step.playbook) throw badRequest('no_playbook', 'this step has no playbook');
  const record = (await one(ctx.pool, 'SELECT display_name FROM journey_records WHERE id=$1', [inst.record_id])) as Row;
  const started = await runPlaybookSession(ctx, who, {
    key: step.playbook.key,
    title: `${step.label}: ${record.display_name}`.slice(0, 200),
    input: '',
    projectId: inst.project_id,
    ...(workstationId ? { workstationId } : {}),
  });
  await ctx.store.append([
    {
      streamId: streamId.journeyInstance(id),
      event: { type: 'JourneyStepPlaybookStarted', payload: { instanceId: id, visit, playbookKey: step.playbook.key, threadId: started.threadId } },
      actor: userActor(who.userId),
      scope: projectScope(inst.org_id, inst.project_id),
    },
  ]);
  return started;
}
