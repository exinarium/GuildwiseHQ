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
    }),
  ),
  defineEvent('WorkstationRenamed', z.object({ workstationId: Id, name: z.string().min(1) })),
  defineEvent('WorkstationUnlinked', z.object({ workstationId: Id, by: z.enum(['owner', 'admin']) })),
  defineEvent('WorkstationConnected', z.object({ workstationId: Id, runnerVersion: z.string().optional() })),
  defineEvent('WorkstationDisconnected', z.object({ workstationId: Id })),
] as const;
