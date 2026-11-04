import { z } from 'zod';
import { StorageKindSchema } from '../storage/index.ts';
import { defineEvent, Id } from './define.ts';

/** Storage connections (stream `storage-<connectionId>`, org scope). Metadata only: never a token, key or path. */
export const storageEvents = [
  defineEvent(
    'StorageConnectionCreated',
    z.object({
      connectionId: Id,
      orgId: Id,
      kind: StorageKindSchema,
      label: z.string().max(80),
      workstationId: Id,
      by: Id,
    }),
  ),
  defineEvent('StorageConnectionRenamed', z.object({ connectionId: Id, label: z.string().max(80), by: Id })),
  defineEvent('StorageConnectionRemoved', z.object({ connectionId: Id, by: Id })),
] as const;
