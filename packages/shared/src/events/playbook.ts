import { z } from 'zod';
import { defineEvent, Id } from './define.ts';

/**
 * Playbook grants (stream `agent-<agentId>`, org scope; docs/ARCHITECTURE.md section 38.10): an agent may start a playbook
 * itself (`aom playbook run`) only when someone who manages it granted that playbook. Off by default.
 */
export const playbookEvents = [
  defineEvent(
    'AgentPlaybookGranted',
    z.object({
      agentId: Id,
      orgId: Id,
      playbookKey: z.string().min(1).max(130),
      grantedBy: Id,
      granted: z.boolean(),
    }),
  ),
  /**
   * Owner decision Q69: an agent started a playbook from a chat and it would run on a workstation that is not the chat person's
   * (the agent's). The person is asked, on their desk, to pick one of their own workstations or decline; nothing starts before.
   */
  defineEvent(
    'PlaybookRunRequested',
    z.object({
      requestId: Id,
      orgId: Id,
      agentId: Id,
      /** The person in the chat, who answers. */
      chatUserId: Id,
      playbookKey: z.string().min(1).max(130),
      input: z.string().max(4000).default(''),
      /** The chat the agent started it from, told the outcome. */
      chatThreadId: Id.optional(),
      deskItemId: Id,
      /** The person's own workstations offered. */
      workstationIds: z.array(Id).max(50),
    }),
  ),
  defineEvent(
    'PlaybookRunDecided',
    z.object({
      requestId: Id,
      orgId: Id,
      decision: z.enum(['accepted', 'declined']),
      /** The chosen workstation (accepted). */
      workstationId: Id.optional(),
      decidedBy: Id,
    }),
  ),
  defineEvent('PlaybookRunStarted', z.object({ requestId: Id, orgId: Id, sessionThreadId: Id })),
] as const;
