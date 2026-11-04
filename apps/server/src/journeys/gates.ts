import { randomUUID } from 'node:crypto';
import type { JourneyDefinition, JourneyGateStep } from '@aom/shared';
import { advanceIn, ev, lockInstance, loadDefinition } from '../commands/journey-runtime.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, HttpError, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { deadlineOf } from '@aom/shared';
import { mayDecideGate, resolveJourneyApprover } from './approvers.ts';
import { deskQuestion, resolveDeskEvent } from './desk.ts';
import { closeWaitDeskItems } from './wait-effects.ts';

const GATE_OPTIONS = [
  { id: 'approve', label: 'Approve', description: 'Let the journey go on.' },
  { id: 'reject', label: 'Reject', description: 'Stop here: the journey follows its reject handoff. A note is required.' },
];

/** Executor for a configured `gate` step: a desk question for the approver, an optional deadline. */
export async function enterGateStep(ctx: Ctx, tx: Tx, inst: Row, def: JourneyDefinition, run: Row): Promise<AppendInput[]> {
  const step = def.steps.find((s) => s.id === run.step_id) as JourneyGateStep;
  const approver = step.approver;
  if (!approver) return [];
  const now = ctx.clock.now();
  const r = await resolveJourneyApprover(tx, inst, approver);
  const record = (await one(tx, 'SELECT display_name FROM journey_records WHERE id=$1', [inst.record_id])) as Row;
  const waitId = randomUUID();
  const deskItemId = randomUUID();
  const deadline = step.deadline ? deadlineOf(now, step.deadline.duration) : null;
  return [
    ev(inst, {
      type: 'JourneyWaitStarted',
      payload: {
        waitId,
        instanceId: inst.id,
        visit: run.visit,
        stepId: run.step_id,
        kind: 'gate',
        startedAt: now.toISOString(),
        ...(deadline ? { deadlineAt: deadline.toISOString(), nextFireAt: deadline.toISOString() } : {}),
        config: { approver, question: step.question, deadline: step.deadline },
      },
    }),
    deskQuestion(inst, {
      deskItemId,
      subkind: 'journeyGate',
      doing: `The journey for ${record.display_name} waits at "${step.label}".`,
      question: step.question ?? `Approve "${step.label}" for ${record.display_name}?`,
      options: GATE_OPTIONS,
      addresseeUserId: r.userIds[0] as string,
      data: { waitId, instanceId: inst.id, recordId: inst.record_id, stepId: run.step_id, ...(r.role ? { role: r.role } : {}) },
    }),
    ev(inst, {
      type: 'JourneyGateOpened',
      payload: {
        waitId,
        deskItemId,
        ...(r.role ? { approverRole: r.role } : { approverUserId: r.userIds[0] as string }),
        fellBack: r.fellBack,
      },
    }),
  ];
}

/** Approve or reject. Reject needs a note. Only the approver decides; the first decision wins. */
export async function decideGate(
  ctx: Ctx,
  who: { userId: string },
  waitId: string,
  decision: 'approved' | 'rejected',
  note?: string,
): Promise<void> {
  const text = note?.trim();
  if (decision === 'rejected' && !text) throw badRequest('note_required', 'Say why you reject.');
  await withAppendTx(ctx.pool, async (tx) => {
    const w = await one(tx, `SELECT * FROM journey_waits WHERE id=$1 AND kind='gate' FOR UPDATE`, [waitId]);
    if (!w) throw notFound('gate not found');
    const inst0 = await one(tx, 'SELECT * FROM journey_instances WHERE id=$1', [w.instance_id]);
    if (!inst0) throw notFound('gate not found');
    if (!(await mayDecideGate(tx, who.userId, inst0, w))) throw new HttpError(403, 'not_approver', 'only the approver can decide');
    if (w.status !== 'open' && w.status !== 'escalated') throw conflict('gate_decided', 'This gate was already decided.');
    const inst = await lockInstance(tx, w.instance_id, w.visit, 'waiting');
    if (!inst) throw conflict('gate_decided', 'This gate is no longer waiting.');
    const def = await loadDefinition(tx, inst.journey_id, inst.journey_version);
    const run = await one(tx, 'SELECT * FROM journey_step_runs WHERE instance_id=$1 AND visit=$2', [inst.id, w.visit]);
    if (!run || run.status !== 'waiting') throw conflict('gate_decided', 'This gate is no longer waiting.');
    const out: AppendInput[] = [
      ev(inst, {
        type: 'JourneyGateDecided',
        payload: { waitId, decision, by: who.userId, ...(text ? { note: text } : {}) },
      }),
      ev(inst, {
        type: 'JourneyWaitResolved',
        payload: { waitId, reason: decision === 'approved' ? 'approved' : 'rejected', by: who.userId },
      }),
    ];
    const asked = w.desk_item_id ? await one(tx, 'SELECT status FROM desk_items WHERE id=$1', [w.desk_item_id]) : null;
    if (w.desk_item_id && asked?.status === 'open')
      out.push(
        resolveDeskEvent(
          inst,
          w.desk_item_id,
          decision,
          text ?? (decision === 'approved' ? 'Approved' : 'Rejected'),
          who.userId,
        ),
      );
    await ctx.store.append(out, { tx });
    await closeWaitDeskItems(ctx, tx, inst, waitId, 'dismissed', 'The gate was decided.', w.desk_item_id);
    await advanceIn(
      ctx,
      tx,
      inst,
      def,
      run,
      decision === 'approved' ? 'done' : 'cancelled',
      null,
      decision === 'approved' ? 'approved' : 'rejected',
    );
  });
}
