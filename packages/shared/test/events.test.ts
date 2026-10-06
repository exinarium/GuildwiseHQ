import { describe, expect, it } from 'vitest';
import { canAnswerCardDeskItem, canManageCard, DomainEventSchema, type EventType } from '../src/index.ts';
import { U } from './fixtures.ts';

describe('DomainEventSchema', () => {
  it('parses a CardCreated payload and applies defaults', () => {
    const r = DomainEventSchema.parse({
      type: 'CardCreated',
      payload: {
        cardId: U.a,
        projectId: U.b,
        number: 1,
        ref: 'WEB-1',
        title: 'T',
        cardType: 'feature',
        workflowVersionId: U.c,
        stage: 'spec',
        status: 'draft',
        fields: {},
        ownerUserId: U.d,
        origin: 'manual',
      },
    });
    expect(r.type === 'CardCreated' && r.payload).toMatchObject({
      scheduled: false,
      priority: 5,
      dependencies: [],
      docsNeeded: false,
    });
  });
  it('rejects unknown types and bad payloads', () => {
    expect(DomainEventSchema.safeParse({ type: 'Nope', payload: {} }).success).toBe(false);
    expect(DomainEventSchema.safeParse({ type: 'CardSpecified', payload: { cardId: 'x' } }).success).toBe(
      false,
    );
  });
  it('covers the M1 catalogue', () => {
    const types = DomainEventSchema.options.map((o) => o.shape.type.value) as EventType[];
    for (const t of [
      'UserBootstrapped',
      'UserInvited',
      'InvitationAccepted',
      'WorkstationPaired',
      'ProjectCreated',
      'ProjectRepoAdded',
      'CardCreated',
      'CardSpecified',
      'CardClaimed',
      'ClaimReleased',
      'HandoffWritten',
      'ReviewRequested',
      'ChangesRequested',
      'ReviewApproved',
      'StageCompleted',
      'ThreadMessagePosted',
      'ShiftStarted',
      'ShiftEnded',
      'AgentHired',
      'AgentRetired',
      'WorkflowVersionRegistered',
      'RoleVersionRegistered',
    ] as EventType[])
      expect(types).toContain(t);
    expect(new Set(types).size).toBe(types.length);
  });
});

describe('authz', () => {
  it('card rights and decision policy', () => {
    const base = { userId: U.a, cardOwnerUserId: U.c };
    expect(canManageCard({ ...base, projectRole: 'owner' })).toBe(true);
    expect(canManageCard({ ...base, projectRole: 'manager' })).toBe(false);
    expect(canManageCard({ ...base, projectRole: 'manager', cardOwnerUserId: U.a })).toBe(true);
    expect(canManageCard({ ...base, projectRole: null })).toBe(false);
    expect(canAnswerCardDeskItem({ ...base, projectRole: 'manager', policy: 'owner_only' })).toBe(false);
    expect(canAnswerCardDeskItem({ ...base, projectRole: 'manager', policy: 'any_manager' })).toBe(true);
    expect(canAnswerCardDeskItem({ ...base, projectRole: null, policy: 'any_manager' })).toBe(false);
  });
});
