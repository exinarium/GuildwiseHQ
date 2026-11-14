import { z } from 'zod';
import { AppIdentitySchema } from '../apps/index.ts';
import { defineEvent, Id } from './define.ts';

/**
 * Automated app integrations (stream `app-integration-<id>`, org scope). Metadata only: never a private key, token,
 * envelope or JWT. GWP-215 projects its "post as" fallback from `OrgAppIntegrationRemoved`.
 */
export const appIntegrationEvents = [
  defineEvent(
    'OrgAppIntegrationAdded',
    AppIdentitySchema.extend({ integrationId: Id, orgId: Id, label: z.string().max(80), by: Id }),
  ),
  defineEvent(
    'OrgAppIntegrationUpdated',
    z.object({
      integrationId: Id,
      label: z.string().max(80).optional(),
      identity: AppIdentitySchema.optional(),
      by: Id,
    }),
  ),
  defineEvent(
    'OrgAppIntegrationShared',
    z.object({ integrationId: Id, workstationId: Id, via: z.enum(['browser', 'adopted']), by: Id }),
  ),
  defineEvent('OrgAppIntegrationUnshared', z.object({ integrationId: Id, workstationId: Id, by: Id })),
  defineEvent('OrgAppIntegrationRemoved', z.object({ integrationId: Id, by: Id })),
] as const;
