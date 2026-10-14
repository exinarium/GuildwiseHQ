import { z } from 'zod';
import { defineEvent, Id } from './define.ts';

export const workstationEvents = [
  defineEvent(
    'WorkstationPaired',
    z.object({
      workstationId: Id,
      userId: Id,
      name: z.string().min(1),
      platform: z.string().nullable(),
      hostname: z.string().nullable(),
      runnerVersion: z.string().nullable(),
      tokenHash: z.string().min(1),
      /** The simulated workstation of this simulation organization (hosted by the server); absent for real ones. */
      simulationOrgId: Id.optional(),
    }),
  ),
  defineEvent('WorkstationRenamed', z.object({ workstationId: Id, name: z.string().min(1) })),
  defineEvent('WorkstationUnlinked', z.object({ workstationId: Id, by: z.enum(['owner', 'admin']) })),
  defineEvent('WorkstationConnected', z.object({ workstationId: Id, runnerVersion: z.string().optional() })),
  /** A runner re-probe changed a runtime's availability or sandbox state (drives live refresh; no projection). */
  defineEvent(
    'WorkstationRuntimesChanged',
    z.object({
      workstationId: Id,
      runtimes: z.array(
        z.object({
          id: z.string(),
          available: z.boolean(),
          sandbox: z.string().optional(),
          auth: z.string().optional(),
        }),
      ),
    }),
  ),
  defineEvent('WorkstationDisconnected', z.object({ workstationId: Id })),
  defineEvent('WorkstationTokenRotated', z.object({ workstationId: Id, tokenHash: z.string().min(1) })),
  // Integrations audit (docs/design/integrations-page.md D7): who did what, never a token, field value, URL or code.
  defineEvent(
    'WorkstationIntegrationConnected',
    z.object({
      workstationId: Id,
      kind: z.string().max(40),
      instance: z.string().max(200),
      method: z.string().max(40).optional(),
      account: z.string().max(200).optional(),
      by: Id,
    }),
  ),
  defineEvent(
    'WorkstationIntegrationRemoved',
    z.object({ workstationId: Id, kind: z.string().max(40), instance: z.string().max(200), by: Id }),
  ),
  defineEvent(
    'WorkstationIntegrationSignInStarted',
    z.object({
      workstationId: Id,
      kind: z.string().max(40),
      instance: z.string().max(200),
      method: z.string().max(40),
      by: Id,
    }),
  ),
] as const;
