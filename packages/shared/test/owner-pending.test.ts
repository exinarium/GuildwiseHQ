import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DomainEventSchema } from '../src/events/index.ts';
import { streamId } from '../src/ids.ts';
import {
  OWNER_PENDING_KINDS,
  ownerPendingAction,
  ownerPendingReminderText,
  RegisterOwnerPendingSchema,
} from '../src/review/owner-pending.ts';

const due = new Date('2026-11-17T15:00:00.000Z');
const before = new Date(due.getTime() - 1);

describe('ownerPendingAction', () => {
  it('reminds when the timer is open, due and not reminded yet', () => {
    expect(ownerPendingAction({ status: 'open', dueAt: due, remindedAt: null }, due)).toBe('remind');
    expect(
      ownerPendingAction(
        { status: 'open', dueAt: due, remindedAt: null },
        new Date(due.getTime() + 86_400_000),
      ),
    ).toBe('remind');
  });

  it('does nothing before the due time', () => {
    expect(ownerPendingAction({ status: 'open', dueAt: due, remindedAt: null }, before)).toBeNull();
  });

  it('reminds only once', () => {
    expect(ownerPendingAction({ status: 'open', dueAt: due, remindedAt: due }, due)).toBeNull();
  });

  it('does nothing when the owner already acted', () => {
    expect(ownerPendingAction({ status: 'resolved', dueAt: due, remindedAt: null }, due)).toBeNull();
  });
});

describe('RegisterOwnerPendingSchema', () => {
  const base = {
    orgId: randomUUID(),
    subjectId: 'repo-1#42',
    ownerUserId: randomUUID(),
    title: 'PR #42: add login',
    startedAt: new Date(),
  };

  it('accepts the three owner-pending kinds', () => {
    for (const kind of OWNER_PENDING_KINDS)
      expect(RegisterOwnerPendingSchema.parse({ ...base, kind }).kind).toBe(kind);
  });

  it('refuses a size exception request (it lapses without a reminder)', () => {
    expect(RegisterOwnerPendingSchema.safeParse({ ...base, kind: 'size_exception' }).success).toBe(false);
    expect(OWNER_PENDING_KINDS as readonly string[]).not.toContain('size_exception');
  });

  it('refuses a link to another site', () => {
    expect(
      RegisterOwnerPendingSchema.safeParse({ ...base, kind: 'manual_trigger', url: 'https://example.com' })
        .success,
    ).toBe(false);
  });
});

describe('ownerPendingReminderText', () => {
  it('names the item, the wait and that the state is unchanged', () => {
    const t = ownerPendingReminderText({ title: 'PR #42: add login', kind: 'over_cap_spend' });
    expect(t.title).toBe('Still waiting for you: PR #42: add login');
    expect(t.body).toContain('2 working days');
    expect(t.body).toContain('stays not reviewed');
    expect(t.body).toContain('daily review limit');
  });
});

describe('owner-pending events', () => {
  it('parse in the event registry and use their own stream', () => {
    const timerId = randomUUID();
    expect(streamId.ownerPending(timerId)).toBe(`owner-pending-${timerId}`);
    const registered = DomainEventSchema.parse({
      type: 'OwnerPendingRegistered',
      payload: {
        timerId,
        kind: 'second_timeout',
        orgId: randomUUID(),
        subjectId: 'pr-1',
        ownerUserId: randomUUID(),
        title: 'PR #1',
        startedAt: '2026-11-13T15:00:00.000Z',
        dueAt: '2026-11-17T15:00:00.000Z',
        timezone: 'UTC',
      },
    });
    expect(registered.type).toBe('OwnerPendingRegistered');
    expect(
      DomainEventSchema.safeParse({
        type: 'OwnerPendingRegistered',
        payload: { ...(registered.payload as object), kind: 'size_exception' },
      }).success,
    ).toBe(false);
    expect(
      DomainEventSchema.parse({
        type: 'OwnerPendingReminded',
        payload: { timerId, firedFor: '2026-11-17T15:00:00.000Z', deskItemId: randomUUID(), recipients: [] },
      }).type,
    ).toBe('OwnerPendingReminded');
    expect(
      DomainEventSchema.parse({ type: 'OwnerPendingResolved', payload: { timerId, reason: 'owner_acted' } })
        .type,
    ).toBe('OwnerPendingResolved');
  });
});
