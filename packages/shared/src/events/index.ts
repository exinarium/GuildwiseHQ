import { z } from 'zod';
import { agentEvents } from './agent.ts';
import { cardEvents } from './card.ts';
import { catalogueEvents } from './catalogue.ts';
import { projectEvents } from './project.ts';
import { shiftEvents } from './shift.ts';
import { userEvents } from './user.ts';
import { workstationEvents } from './workstation.ts';

// Registry: later milestones add one spread per domain file (desk, ledger, testing, ...) on the line below.
export const DomainEventSchema = z.discriminatedUnion('type', [
  ...userEvents,
  ...workstationEvents,
  ...projectEvents,
  ...cardEvents,
  ...shiftEvents,
  ...agentEvents,
  ...catalogueEvents,
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type EventType = DomainEvent['type'];
export type EventOf<T extends EventType> = Extract<DomainEvent, { type: T }>;
export type EventPayload<T extends EventType> = EventOf<T>['payload'];

export * from './agent.ts';
export * from './card.ts';
export * from './catalogue.ts';
export { defineEvent, IsoDate, Usage, UserRole } from './define.ts';
export * from './envelope.ts';
export * from './project.ts';
export * from './shift.ts';
export * from './user.ts';
export * from './workstation.ts';
