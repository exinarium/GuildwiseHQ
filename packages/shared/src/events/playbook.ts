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
] as const;
