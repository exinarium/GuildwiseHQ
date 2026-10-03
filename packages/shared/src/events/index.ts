import { z } from 'zod';
import { agentEvents } from './agent.ts';
import { cardEvents } from './card.ts';
import { catalogueEvents } from './catalogue.ts';
import { chatEvents } from './chat.ts';
import { deskEvents } from './desk.ts';
import { devopsEvents } from './devops.ts';
import { ledgerEvents } from './ledger.ts';
import { projectEvents } from './project.ts';
import { sharingEvents } from './sharing.ts';
import { shiftEvents } from './shift.ts';
import { testingEvents } from './testing.ts';
import { userEvents } from './user.ts';
import { vaultEvents } from './vault.ts';
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
  ...deskEvents,
  ...ledgerEvents,
  ...chatEvents,
  ...vaultEvents,
  ...devopsEvents,
  ...sharingEvents,
  ...testingEvents,
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type EventType = DomainEvent['type'];
export type EventOf<T extends EventType> = Extract<DomainEvent, { type: T }>;
export type EventPayload<T extends EventType> = EventOf<T>['payload'];

export * from './agent.ts';
export * from './card.ts';
export * from './catalogue.ts';
export * from './chat.ts';
export { defineEvent, IsoDate, Usage, UserRole } from './define.ts';
export * from './desk.ts';
export * from './devops.ts';
export * from './envelope.ts';
export * from './ledger.ts';
export * from './project.ts';
export * from './sharing.ts';
export * from './shift.ts';
export * from './testing.ts';
export * from './user.ts';
export * from './vault.ts';
export * from './workstation.ts';
