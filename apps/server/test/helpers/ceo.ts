import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { ceoProvisionEvents } from '../../src/ceo/provision.ts';
import { enqueueWake } from '../../src/ceo/wakes.ts';
import { q } from './db.ts';
import type { FakeRunner } from './fake-runner.ts';
import { seed } from './seed.ts';
import { until, type World } from './world.ts';

/** The workstation is online (the fake runner sends no heartbeats) with the mock runtime and the `ceo:1` capability. */
export async function keepOnline(w: World) {
  await q(`UPDATE workstations SET connected=true, last_seen_at=$2 WHERE id=$1`, [
    w.workstationId,
    w.t.clock.now(),
  ]);
  await q(
    // `ceo:1` is added; other capabilities the runner announced (full power) stay
    `INSERT INTO workstation_capabilities (workstation_id, capabilities, max_run_environments, updated_at) VALUES ($1,'{ceo:1}',2,now())
     ON CONFLICT (workstation_id) DO UPDATE SET capabilities = CASE WHEN 'ceo:1' = ANY(workstation_capabilities.capabilities)
       THEN workstation_capabilities.capabilities ELSE array_append(workstation_capabilities.capabilities, 'ceo:1') END`,
    [w.workstationId],
  );
}

/**
 * The organization's built-in CEO, moved onto the world's workstation, renamed and pointed at the mock runtime. Worlds are
 * seeded straight through the event store, so the CEO that production creates with the organization is provisioned here
 * (by the same function) when it is missing. There is no appoint any more.
 */
export async function appoint(w: World, name = 'Ada Prime') {
  const org = (
    await q(`SELECT id FROM organizations WHERE owner_user_id=$1 ORDER BY created_at LIMIT 1`, [w.owner.id])
  )[0]?.id as string;
  const find = async () =>
    (await q(`SELECT id FROM agents WHERE org_id=$1 AND role_key='ceo' AND status <> 'retired'`, [org]))[0];
  if (!(await find())) {
    const events = await ceoProvisionEvents(w.t.app.ctx.pool, w.t.app.ctx, org, w.owner.id);
    await w.t.app.ctx.store.append(events);
  }
  const a = await find();
  if (!a) throw new Error('the CEO role is not available');
  await q(`UPDATE agents SET runtime='mock', model='mock', workstation_id=$2, name=$3 WHERE id=$1`, [
    a.id,
    w.workstationId,
    name,
  ]);
  await keepOnline(w);
  return a.id as string;
}

/** The CEO is built in and has no training period: nothing to graduate (kept so older tests read the same). */
export const graduate = async (_w: World) => undefined;

/** A blocking question on a card, routed to the manager's desk (an agent asked it). */
export async function blockingQuestion(
  w: World,
  over: { title?: string; options?: string[]; subkind?: string } = {},
) {
  const card = await w.card({ title: over.title ?? 'Which database?' });
  const id = randomUUID();
  await seed(w, [
    {
      streamId: streamId.desk(id),
      event: {
        type: 'QuestionRaised',
        payload: {
          deskItemId: id,
          cardId: card.id,
          projectId: w.projectId,
          askedBy: { kind: 'system' },
          question: over.title ?? 'Which database?',
          options: (over.options ?? ['Postgres', 'SQLite']).map((label, i) => ({ id: `o${i + 1}`, label })),
          blocking: true,
          routedTo: 'manager',
          pinned: true,
          affectedCardIds: [card.id],
          ...(over.subkind ? { subkind: over.subkind } : {}),
        },
      },
      actor: { kind: 'system', id: null },
      scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' },
    },
  ]);
  return { card, id };
}

/** A ledger entry the CEO can cite as evidence. */
export async function ledgerEntry(w: World, title = 'Use Postgres') {
  const entryId = randomUUID();
  await seed(w, [
    {
      streamId: streamId.ledger(entryId),
      event: {
        type: 'LedgerEntryAdded',
        payload: { entryId, scope: 'decision', projectId: w.projectId, title, body: title, tags: [] },
      },
      actor: { kind: 'system', id: null },
      scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' },
    },
  ]);
  return entryId;
}

/** Runs the dispatch pass and returns the CEO `shift.start` the runner gets; accepts and starts it. */
export async function startCeoShift(w: World, r: FakeRunner, from = 0) {
  await keepOnline(w);
  await r.barrier();
  await w.t.app.ctx.services.dispatcher.run();
  const start = (await r.waitFor('shift.start', (f) => f.kind === 'ceo', 8000, from)) as any;
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  await until(
    async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='running'`, [start.shiftId]))[0],
    3000,
    'ceo shift running',
  );
  return start;
}

/** `aom ceo ...` from inside the shift: the rpc request and its answer. */
export async function ceo(r: FakeRunner, shiftId: string, params: Record<string, unknown>) {
  const rpcId = randomUUID();
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId, method: 'ceo', params });
  return (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 8000, from)) as any;
}

export const act = (
  r: FakeRunner,
  shiftId: string,
  action: string,
  params: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  ceo(r, shiftId, {
    op: 'act',
    action,
    params,
    reason: 'because the situation calls for it',
    confidence: 0.9,
    evidence: [],
    ...extra,
  });

export async function wakeNow(
  w: World,
  reason = 'desk_item',
  urgency: 'urgent' | 'normal' = 'urgent',
  subjectId = randomUUID(),
) {
  await enqueueWake(
    w.t.app.ctx.pool,
    w.owner.id,
    { reason, urgency, subjectKind: 'test', subjectId, subjectLabel: 'test' },
    w.t.clock.now(),
  );
}
