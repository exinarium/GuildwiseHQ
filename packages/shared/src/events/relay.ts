import { z } from 'zod';
import { RelayKindSchema } from '../relay/index.ts';
import { defineEvent, Id } from './define.ts';

/**
 * Inbound webhook relay integrations (stream `relay-<integrationId>`, org scope). Only the sha256 of the path token
 * is ever in an event; the token itself is shown once and never stored.
 */
export const relayEvents = [
  defineEvent(
    'RelayIntegrationCreated',
    z.object({
      integrationId: Id,
      orgId: Id,
      kind: RelayKindSchema,
      label: z.string().max(80),
      tokenHash: z.string().length(64),
      by: Id,
    }),
  ),
  defineEvent(
    'RelayIntegrationRotated',
    z.object({ integrationId: Id, tokenHash: z.string().length(64), by: Id }),
  ),
  defineEvent('RelayIntegrationRevoked', z.object({ integrationId: Id, by: Id })),
] as const;
