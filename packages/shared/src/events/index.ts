import { z } from 'zod';
import { agentEvents } from './agent.ts';
import { agentUxEvents } from './agent-ux.ts';
import { approvalEvents } from './approval.ts';
import { backlogEvents } from './backlog.ts';
import { blogEvents } from './blog.ts';
import { boardEvents } from './board.ts';
import { capabilityEvents } from './capability.ts';
import { cardEvents } from './card.ts';
import { catalogueEvents } from './catalogue.ts';
import { ceoEvents } from './ceo.ts';
import { ceoTopicEvents } from './ceo-topics.ts';
import { chatEvents } from './chat.ts';
import { codeV6Events } from './code-v6.ts';
import { costEvents } from './cost.ts';
import { deliveryEvents } from './delivery.ts';
import { deskEvents } from './desk.ts';
import { devopsEvents } from './devops.ts';
import { discoveryEvents } from './discovery.ts';
import { documentEvents } from './document.ts';
import { environmentEvents } from './environment.ts';
import { feedEvents } from './feed.ts';
import { governanceEvents } from './governance.ts';
import { graphEvents } from './graph.ts';
import { hrEvents } from './hr.ts';
import { hygieneEvents } from './hygiene.ts';
import { intakeEvents } from './intake.ts';
import { intakeBatchEvents } from './intake-batch.ts';
import { interestEvents } from './interest.ts';
import { ledgerEvents } from './ledger.ts';
import { mailEvents } from './mail.ts';
import { orgEvents } from './org.ts';
import { outboundEvents } from './outbound.ts';
import { packEvents } from './pack.ts';
import { phaseEvents } from './phase.ts';
import { platformEvents } from './platform.ts';
import { playbookEvents } from './playbook.ts';
import { projectEvents } from './project.ts';
import { projectWorkflowEvents, workflowFoldEvents } from './project-workflows.ts';
import { providerKeyEvents } from './provider-keys.ts';
import { qaEvents } from './qa.ts';
import { questionFlowEvents } from './question-flow.ts';
import { releaseEvents } from './release.ts';
import { relayEvents } from './relay.ts';
import { repoEvents } from './repo.ts';
import { reporterEvents } from './reporter.ts';
import { researchEvents } from './research.ts';
import { runEvents } from './run.ts';
import { scheduleEvents } from './schedule.ts';
import { sessionEvents } from './session.ts';
import { setupEvents } from './setup.ts';
import { sharingEvents } from './sharing.ts';
import { shiftEvents } from './shift.ts';
import { testingEvents } from './testing.ts';
import { userEvents } from './user.ts';
import { vaultEvents } from './vault.ts';
import { videoEvents } from './video.ts';
import { workstationEvents } from './workstation.ts';

// Registry: later milestones add one spread per domain file (desk, ledger, testing, ...) on the line below.
export const DomainEventSchema = z.discriminatedUnion('type', [
  ...userEvents,
  ...orgEvents,
  ...workstationEvents,
  ...projectEvents,
  ...projectWorkflowEvents,
  ...workflowFoldEvents,
  ...cardEvents,
  ...shiftEvents,
  ...agentEvents,
  ...catalogueEvents,
  ...ceoEvents,
  ...ceoTopicEvents,
  ...deskEvents,
  ...ledgerEvents,
  ...chatEvents,
  ...vaultEvents,
  ...graphEvents,
  ...deliveryEvents,
  ...devopsEvents,
  ...environmentEvents,
  ...sharingEvents,
  ...testingEvents,
  ...scheduleEvents,
  ...feedEvents,
  ...researchEvents,
  ...intakeEvents,
  ...intakeBatchEvents,
  ...backlogEvents,
  ...mailEvents,
  ...hrEvents,
  ...outboundEvents,
  ...repoEvents,
  ...phaseEvents,
  ...reporterEvents,
  ...hygieneEvents,
  ...setupEvents,
  ...interestEvents,
  ...costEvents,
  ...providerKeyEvents,
  ...blogEvents,
  ...videoEvents,
  ...runEvents,
  ...qaEvents,
  ...approvalEvents,
  ...releaseEvents,
  ...questionFlowEvents,
  ...platformEvents,
  ...codeV6Events,
  ...sessionEvents,
  ...discoveryEvents,
  ...boardEvents,
  ...documentEvents,
  ...capabilityEvents,
  ...packEvents,
  ...playbookEvents,
  ...governanceEvents,
  ...agentUxEvents,
  ...relayEvents,
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type EventType = DomainEvent['type'];
export type EventOf<T extends EventType> = Extract<DomainEvent, { type: T }>;
export type EventPayload<T extends EventType> = EventOf<T>['payload'];

export * from './agent.ts';
export * from './agent-ux.ts';
export * from './approval.ts';
export * from './backlog.ts';
export * from './blog.ts';
export * from './board.ts';
export * from './capability.ts';
export * from './card.ts';
export * from './catalogue.ts';
export * from './ceo.ts';
export * from './chat.ts';
export * from './code-v6.ts';
export * from './cost.ts';
export { defineEvent, IsoDate, Usage, UserRole } from './define.ts';
export * from './desk.ts';
export * from './devops.ts';
export * from './discovery.ts';
export * from './document.ts';
export * from './envelope.ts';
export * from './environment.ts';
export * from './feed.ts';
export * from './governance.ts';
export * from './hr.ts';
export * from './hygiene.ts';
export * from './intake.ts';
export * from './intake-batch.ts';
export * from './interest.ts';
export * from './ledger.ts';
export * from './mail.ts';
export * from './org.ts';
export * from './outbound.ts';
export * from './phase.ts';
export * from './playbook.ts';
export * from './project.ts';
export * from './project-workflows.ts';
export * from './qa.ts';
export * from './question-flow.ts';
export * from './relay.ts';
export * from './repo.ts';
export * from './reporter.ts';
export * from './research.ts';
export * from './run.ts';
export * from './schedule.ts';
export * from './session.ts';
export * from './sharing.ts';
export * from './shift.ts';
export * from './testing.ts';
export * from './user.ts';
export * from './vault.ts';
export * from './video.ts';
export * from './workstation.ts';
