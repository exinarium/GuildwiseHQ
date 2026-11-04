import { describe, expect, it } from 'vitest';
import { DomainEventSchema } from '../src/events/index.ts';
import {
  CALL_BACKOFF_MINUTES,
  callBackoffMs,
  dateWaitFireAt,
  deadlineOf,
  getJourneyTemplate,
  JourneyDefinitionSchema,
  JourneyDurationSchema,
  mapHookPayload,
  nextMove,
  readPointer,
  renderBodyTemplate,
  resolveHandoff,
  timeoutDecision,
  validateJourney,
  type WaitView,
} from '../src/journeys/index.ts';

const U = '0190c1a2-0000-7000-8000-000000000001';
const base = (steps: unknown[], handoffs: unknown[], first = 'a') =>
  JourneyDefinitionSchema.parse({ name: 'J', recordType: 'client', firstStepId: first, steps, handoffs });
const wf = (id: string) => ({ kind: 'workflow', id, label: id, workflowKey: 'w' });

describe('step schemas', () => {
  it('an old unconfigured placeholder wait and gate still parse', () => {
    const d = base(
      [
        { kind: 'wait', id: 'a', label: 'A' },
        { kind: 'gate', id: 'b', label: 'B' },
      ],
      [],
    );
    expect(d.steps).toHaveLength(2);
  });
  it('rejects a duration under 5 minutes or over 365 days', () => {
    expect(JourneyDurationSchema.safeParse({ amount: 4, unit: 'minutes' }).success).toBe(false);
    expect(JourneyDurationSchema.safeParse({ amount: 366, unit: 'days' }).success).toBe(false);
    expect(JourneyDurationSchema.safeParse({ amount: 5, unit: 'days' }).success).toBe(true);
  });
  it('parses the new events and old cancel events without by', () => {
    const e = DomainEventSchema.safeParse({ type: 'JourneyInstanceCancelled', payload: { instanceId: U } });
    expect(e.success).toBe(true);
  });
});

describe('validation', () => {
  const codes = (d: ReturnType<typeof base>, o = {}) => validateJourney(d, o).errors.map((e) => e.code);
  it('an unconfigured wait or gate is a warning (it waits for Continue); an unconfigured call is an error', () => {
    const d = base(
      [
        { kind: 'wait', id: 'a', label: 'A' },
        { kind: 'gate', id: 'b', label: 'B' },
        { kind: 'webhook_call', id: 'c', label: 'C' },
      ],
      [],
    );
    const c = codes(d);
    expect(c).not.toContain('no_wait_config');
    expect(c).not.toContain('no_approver');
    expect(c).toContain('no_url');
    expect(c).toContain('no_workstation');
    expect(validateJourney(d).warnings.map((x) => x.code)).toEqual(
      expect.arrayContaining(['no_wait_config', 'no_approver']),
    );
  });
  it('a form wait needs a form and a timeout action; a duration wait refuses one', () => {
    const d = base(
      [
        {
          kind: 'wait',
          id: 'a',
          label: 'A',
          waitFor: { kind: 'form', formId: null },
          duration: { amount: 1, unit: 'days' },
        },
        {
          kind: 'wait',
          id: 'b',
          label: 'B',
          waitFor: { kind: 'duration' },
          duration: { amount: 1, unit: 'days' },
          onTimeout: { action: 'cancel' },
        },
      ],
      [],
    );
    const c = codes(d);
    expect(c).toContain('no_form');
    expect(c).toContain('no_timeout_action');
    expect(c).toContain('timeout_not_allowed');
  });
  it('goto must target another existing step', () => {
    const d = base(
      [
        {
          kind: 'wait',
          id: 'a',
          label: 'A',
          waitFor: { kind: 'webhook', triggerId: U },
          duration: { amount: 1, unit: 'days' },
          onTimeout: { action: 'goto', stepId: 'a' },
        },
      ],
      [],
    );
    expect(codes(d)).toContain('goto_target');
  });
  it('on values must fit the from step; missing reject handoff is a warning', () => {
    const d = base(
      [wf('a'), { kind: 'gate', id: 'g', label: 'G', approver: { kind: 'project_owner' }, question: 'ok?' }],
      [
        { id: 'h1', from: 'a', on: 'approved', to: 'g' },
        { id: 'h2', from: 'g', on: 'approved', to: 'end' },
      ],
    );
    const v = validateJourney(d);
    expect(v.errors.map((e) => e.code)).toContain('handoff_on_invalid');
    expect(v.warnings.map((e) => e.code)).toContain('no_reject_handoff');
  });
  it('a loop of calls only is an error, a loop with a wait is not', () => {
    const call = (id: string) => ({
      kind: 'webhook_call',
      id,
      label: id,
      url: 'https://x.test/h',
      workstationId: U,
    });
    const bad = base(
      [call('a'), call('b')],
      [
        { id: 'h1', from: 'a', to: 'b' },
        { id: 'h2', from: 'b', to: 'a' },
      ],
    );
    expect(codes(bad)).toContain('server_step_cycle');
    const ok = base(
      [
        call('a'),
        {
          kind: 'wait',
          id: 'b',
          label: 'b',
          waitFor: { kind: 'duration' },
          duration: { amount: 1, unit: 'days' },
        },
      ],
      [
        { id: 'h1', from: 'a', to: 'b' },
        { id: 'h2', from: 'b', to: 'a' },
      ],
    );
    expect(codes(ok)).not.toContain('server_step_cycle');
  });
  it('{wait.link} needs an earlier form wait that sends by webhook', () => {
    const call = {
      kind: 'webhook_call',
      id: 'c',
      label: 'c',
      url: 'https://x.test/h',
      workstationId: U,
      body: '{"l":"{wait.link}"}',
    };
    const wait = (via: string) => ({
      kind: 'wait',
      id: 'a',
      label: 'a',
      waitFor: { kind: 'form', formId: U, send: { via } },
      duration: { amount: 1, unit: 'days' },
      onTimeout: { action: 'cancel' },
    });
    const h = [{ id: 'h1', from: 'a', to: 'c' }];
    expect(codes(base([wait('desk'), call], h))).toContain('wait_link_unavailable');
    expect(codes(base([wait('webhook'), call], h))).not.toContain('wait_link_unavailable');
  });
  it('the rentals template shows no_form until the form is picked and has a reject handoff', () => {
    const t = getJourneyTemplate('rentals')!.definition;
    const v = validateJourney(t);
    expect(v.errors.map((e) => e.code)).toContain('no_form');
    expect(v.warnings.map((e) => e.code)).not.toContain('no_reject_handoff');
  });
});

describe('handoffs with an outcome', () => {
  const d = base(
    [wf('a'), { kind: 'gate', id: 'g', label: 'G' }, wf('n'), wf('x')],
    [
      { id: 'h1', from: 'g', on: 'rejected', to: 'x' },
      { id: 'h2', from: 'g', on: 'done', to: 'n' },
    ],
  );
  const ctx = { card: null, record: { type: 'client', status: 'active' }, visits: 1 } as const;
  it('rejected follows the reject handoff, approved the done handoff', () => {
    expect(resolveHandoff(d, 'g', { ...ctx, result: 'cancelled', outcome: 'rejected' })?.to).toBe('x');
    expect(resolveHandoff(d, 'g', { ...ctx, result: 'done', outcome: 'approved' })?.to).toBe('n');
  });
  it('legacy cancelled handoff is read as reject; no match is stuck', () => {
    const l = base(
      [{ kind: 'gate', id: 'g', label: 'G' }, wf('x')],
      [{ id: 'h', from: 'g', on: 'cancelled', to: 'x' }],
      'g',
    );
    expect(resolveHandoff(l, 'g', { ...ctx, result: 'cancelled', outcome: 'rejected' })?.to).toBe('x');
    expect(nextMove(l, 'g', { ...ctx, result: 'done', outcome: 'approved' }).kind).toBe('stuck');
  });
});

describe('timers', () => {
  const t0 = new Date('2026-11-04T08:00:00Z');
  const view = (over: Partial<WaitView>): WaitView => ({
    kind: 'form',
    status: 'open',
    startedAt: t0,
    deadlineAt: new Date(t0.getTime() + 5 * 86_400_000),
    nextFireAt: null,
    remindersSent: 0,
    ...over,
  });
  it('deadlineOf adds the duration', () => {
    expect(deadlineOf(t0, { amount: 2, unit: 'hours' }).toISOString()).toBe('2026-11-04T10:00:00.000Z');
  });
  it('duration and date waits elapse', () => {
    expect(timeoutDecision(view({ kind: 'duration' }), t0).kind).toBe('elapsed');
    expect(timeoutDecision(view({ kind: 'date' }), t0).kind).toBe('elapsed');
  });
  it('remind counts up, then afterLast runs', () => {
    const o = { action: 'remind', maxReminders: 2, afterLast: 'cancel' } as const;
    const now = new Date(t0.getTime() + 6 * 86_400_000);
    const r1 = timeoutDecision(view({ onTimeout: o }), now);
    expect(r1).toMatchObject({ kind: 'remind', n: 1, of: 2 });
    // five day cadence from now, never a burst after downtime
    expect((r1 as { nextFireAt: Date }).nextFireAt.getTime()).toBe(now.getTime() + 5 * 86_400_000);
    expect(timeoutDecision(view({ onTimeout: o, remindersSent: 2 }), now).kind).toBe('cancel');
    expect(
      timeoutDecision(view({ onTimeout: { ...o, afterLast: 'escalate' }, remindersSent: 2 }), now).kind,
    ).toBe('escalate');
  });
  it('goto, escalate and cancel', () => {
    expect(timeoutDecision(view({ onTimeout: { action: 'goto', stepId: 'z' } }), t0)).toEqual({
      kind: 'goto',
      stepId: 'z',
    });
    expect(timeoutDecision(view({ onTimeout: { action: 'escalate' } }), t0).kind).toBe('escalate');
    expect(timeoutDecision(view({ onTimeout: { action: 'cancel' } }), t0).kind).toBe('cancel');
  });
  it('a missing action escalates rather than ending silently', () => {
    expect(timeoutDecision(view({}), t0).kind).toBe('escalate');
  });
  it('date waits: day uses the time of day in the zone, across DST, and invalid values give null', () => {
    expect(dateWaitFireAt('2026-07-01', undefined, '09:00', 'Europe/Amsterdam')?.toISOString()).toBe(
      '2026-07-01T07:00:00.000Z',
    );
    expect(dateWaitFireAt('2026-12-01', undefined, '09:00', 'Europe/Amsterdam')?.toISOString()).toBe(
      '2026-12-01T08:00:00.000Z',
    );
    expect(dateWaitFireAt('2026-03-29', undefined, '09:00', 'Europe/Amsterdam')?.toISOString()).toBe(
      '2026-03-29T07:00:00.000Z',
    );
    expect(dateWaitFireAt('2026-12-01', { amount: -1, unit: 'days' }, '09:00', 'UTC')?.toISOString()).toBe(
      '2026-11-30T09:00:00.000Z',
    );
    expect(dateWaitFireAt('2026-12-01T10:30:00Z', undefined, '09:00')?.toISOString()).toBe(
      '2026-12-01T10:30:00.000Z',
    );
    expect(dateWaitFireAt('2026-02-31', undefined, '09:00')).toBeNull();
    expect(dateWaitFireAt('soon', undefined, '09:00')).toBeNull();
    expect(dateWaitFireAt(undefined, undefined, '09:00')).toBeNull();
  });
  it('call backoff is 1/5/30/120 minutes then final', () => {
    expect(CALL_BACKOFF_MINUTES).toEqual([1, 5, 30, 120]);
    expect(callBackoffMs(1)).toBe(60_000);
    expect(callBackoffMs(4)).toBe(7_200_000);
    expect(callBackoffMs(5)).toBeNull();
  });
});

describe('body templates and hook mapping', () => {
  it('escapes for JSON and URL forms and refuses unknown tokens', () => {
    expect(
      renderBodyTemplate('{"n":"{record.name}"}', { 'record.name': 'A "B"\n' }, 'application/json'),
    ).toBe('{"n":"A \\"B\\"\\n"}');
    expect(
      renderBodyTemplate('n={record.name}', { 'record.name': 'A&B' }, 'application/x-www-form-urlencoded'),
    ).toBe('n=A%26B');
    expect(() => renderBodyTemplate('{nope}', {}, 'text/plain')).toThrow();
  });
  it('reads JSON pointers', () => {
    const o = { a: { 'b/c': [1, { d: 'x' }] } };
    expect(readPointer(o, '/a/b~1c/1/d')).toBe('x');
    expect(readPointer(o, '/a/zz')).toBeUndefined();
    expect(readPointer(o, '/a/b~1c/01')).toBeUndefined();
  });
  it('maps only the external id and display name', () => {
    const m = { externalId: '/id', displayName: '/who/name' };
    expect(mapHookPayload(m, { id: 77, who: { name: ' Ann ' }, secret: 'S' })).toEqual({
      externalId: '77',
      displayName: 'Ann',
    });
    expect(mapHookPayload(m, { who: {} })).toEqual({ error: 'missing_match' });
    expect(mapHookPayload(m, { id: { x: 1 } })).toEqual({ error: 'not_scalar' });
    expect(mapHookPayload(m, { id: 'x'.repeat(121) })).toEqual({ error: 'value_too_long' });
    expect(mapHookPayload({ externalId: '/id' }, { id: 'k' })).toEqual({ externalId: 'k' });
  });
});
