import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { journeyTick } from '../src/journeys/tick.ts';
import { q } from './helpers/db.ts';
import { PNG, usePublicFormsWorld } from './helpers/public-forms.ts';
import { ok } from './helpers/world.ts';

/**
 * GWP-67 AC3 (wait-for-form round trip with local-folder storage), AC7 (a timer set before a restart fires once) and the
 * gate reminder that shows on the desk. Uses the public forms harness: a stub runner serves the firm's folder.
 */
const pf = usePublicFormsWorld();
const ctx = () => pf.w.t.app.ctx;
const MIN = 60_000;
const tick = async (n = 3) => {
  for (let i = 0; i < n; i++) await journeyTick(ctx(), { projectId: pf.w.projectId });
};
const create = async (steps: unknown[], handoffs: unknown[], first: string) =>
  (
    await ok<any>(
      pf.api('POST', '/api/journeys', {
        projectId: pf.w.projectId,
        definition: { name: 'J', recordType: 'client', firstStepId: first, steps, handoffs },
      }),
      201,
    )
  ).id as string;
const start = async (journeyId: string) =>
  (await ok<any>(pf.api('POST', '/api/journey-instances', { journeyId, record: { type: 'client', displayName: 'Ann' } }), 201))
    .id as string;
const waitRow = async (id: string, visit = 1) =>
  (await q('SELECT * FROM journey_waits WHERE instance_id=$1 AND visit=$2', [id, visit]))[0] as any;
const inst = async (id: string) => (await q('SELECT * FROM journey_instances WHERE id=$1', [id]))[0] as any;
const manual = (id: string) => ({ kind: 'wait', id, label: id });

describe('wait-for-form (AC3)', () => {
  it('sends a per-client link, and the journey resumes when the submission is written to storage', async () => {
    const { formId, publicId } = await pf.published(pf.definition('Rental application'));
    const j = await create(
      [
        {
          kind: 'wait',
          id: 'docs',
          label: 'Documents',
          waitFor: { kind: 'form', formId, purpose: 'answers', send: { via: 'desk' } },
          duration: { amount: 2, unit: 'days' },
          onTimeout: { action: 'escalate' },
        },
        manual('screening'),
      ],
      [{ id: 'h1', from: 'docs', on: 'done', to: 'screening' }],
      'docs',
    );
    const id = await start(j);
    await tick();

    // the wait shows its deadline and a link; the desk has a task to pass it on
    const row = await waitRow(id);
    expect(row).toMatchObject({ kind: 'form', status: 'open' });
    expect(row.deadline_at).not.toBeNull();
    const view = await ok<any>(pf.api('GET', `/api/journey-instances/${id}/waits`));
    const url = view.waits[0].linkUrl as string;
    expect(url).toContain('#c=');
    const task = (await q(`SELECT subkind FROM desk_items WHERE id=$1`, [row.desk_item_id]))[0] as any;
    expect(task.subkind).toBe('journey_wait_link');

    // not resumed before the submission
    await tick();
    expect((await inst(id)).current_step_id).toBe('docs');

    const token = /#c=(.+)$/.exec(url)?.[1] as string;
    const s = await pf.submit(publicId, { full_name: 'Ann Client' }, [{ field: 'id_copy', name: 'id.png', bytes: PNG }], token);
    expect(s.complete?.status).toBe(200);
    expect(pf.stub.files().length).toBeGreaterThan(0);

    await tick();
    expect(await waitRow(id)).toMatchObject({ status: 'resolved', resolution: 'form_submitted' });
    expect((await inst(id)).current_step_id).toBe('screening');
    const refs = await q(`SELECT ref FROM journey_record_refs WHERE record_id=$1 AND kind='form_submission'`, [(await inst(id)).record_id]);
    expect(refs.map((r: any) => r.ref)).toContain(s.sid);
  });
});

describe('a timer set before a restart fires once (AC7): the timer is a row, the pass keeps no state', () => {
  it('fires once at the first pass after the downtime and not again: one timeout, one reminder', async () => {
    const j = await create(
      [
        {
          kind: 'wait',
          id: 'a',
          label: 'a',
          waitFor: { kind: 'webhook', triggerId: randomUUID() },
          duration: { amount: 10, unit: 'minutes' },
          onTimeout: { action: 'remind', maxReminders: 3, afterLast: 'cancel' },
        },
      ],
      [],
      'a',
    );
    const id = await start(j);
    await tick();
    const before = await waitRow(id);
    expect(before.next_fire_at).not.toBeNull();

    // the server goes down: nothing but the row remembers the timer (the pass keeps no state of its own)
    expect(before.status).toBe('open');
    expect(before.reminders_sent).toBe(0);

    // it comes back after the deadline; the first pass fires, a second one finds nothing due
    pf.w.t.clock.advance(11 * MIN);
    await tick(2);
    const row = await waitRow(id);
    expect(row.reminders_sent).toBe(1);
    expect(row.events.filter((e: any) => e.type === 'timed_out')).toHaveLength(1);
    expect(row.events.filter((e: any) => e.type === 'reminded')).toHaveLength(1);
  });
});

describe('gate reminders are visible on the desk', () => {
  it('a reminder raises a fresh question for the approver and the decision still works', async () => {
    const j = await create(
      [
        {
          kind: 'gate',
          id: 'g',
          label: 'Approval',
          approver: { kind: 'project_owner' },
          question: 'Approve the lease?',
          deadline: { duration: { amount: 10, unit: 'minutes' }, onTimeout: { action: 'remind', maxReminders: 2, afterLast: 'escalate' } },
        },
        manual('yes'),
      ],
      [{ id: 'h1', from: 'g', on: 'approved', to: 'yes' }],
      'g',
    );
    const id = await start(j);
    await tick();
    const first = (await waitRow(id)).desk_item_id as string;
    pf.w.t.clock.advance(11 * MIN);
    await tick(2);
    const row = await waitRow(id);
    expect(row.reminders_sent).toBe(1);
    expect(row.desk_item_id).not.toBe(first);
    const fresh = (await q('SELECT subkind, status FROM desk_items WHERE id=$1', [row.desk_item_id]))[0] as any;
    expect(fresh).toMatchObject({ subkind: 'journey_gate', status: 'open' });
    expect((await q('SELECT status FROM desk_items WHERE id=$1', [first]))[0]!.status).not.toBe('open');

    await ok(pf.api('POST', `/api/journey-gates/${row.id}/decide`, { decision: 'approved' }));
    expect((await inst(id)).current_step_id).toBe('yes');
    expect((await q('SELECT status FROM desk_items WHERE id=$1', [row.desk_item_id]))[0]!.status).not.toBe('open');
  });
});


describe('a gate that escalated can still be decided', () => {
  it('approves after the deadline escalated, follows the approved handoff and leaves no desk item of the wait open', async () => {
    const j = await create(
      [
        {
          kind: 'gate',
          id: 'g',
          label: 'Approval',
          approver: { kind: 'project_owner' },
          question: 'Approve the lease?',
          deadline: { duration: { amount: 10, unit: 'minutes' }, onTimeout: { action: 'escalate' } },
        },
        manual('yes'),
      ],
      [{ id: 'h1', from: 'g', on: 'approved', to: 'yes' }],
      'g',
    );
    const id = await start(j);
    await tick();
    pf.w.t.clock.advance(11 * MIN);
    await tick(2);
    const row = await waitRow(id);
    expect(row.status).toBe('escalated');

    await ok(pf.api('POST', `/api/journey-gates/${row.id}/decide`, { decision: 'approved' }));
    expect((await inst(id)).current_step_id).toBe('yes');
    const open = await q(`SELECT id FROM desk_items WHERE status='open' AND data->>'waitId'=$1`, [row.id]);
    expect(open).toHaveLength(0);
  });
});
