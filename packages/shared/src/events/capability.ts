import { z } from 'zod';
import { CapabilityMetaSchema } from '../capabilities/parse.ts';
import { defineEvent, Id } from './define.ts';

/**
 * The organization vault's capabilities as a runner indexed them (stream `capabilities-<orgId>`, org scope). Metadata
 * only: the server never stores vault content. Appended only when the indexed set changed.
 */
export const capabilityEvents = [
  defineEvent(
    'CapabilityIndexReported',
    z.object({
      orgId: Id,
      vaultId: Id,
      workstationId: Id,
      items: z.array(CapabilityMetaSchema.extend({ source: z.literal('org-vault') })).max(500),
      /** Files that did not parse (path and message), so the owner can fix them. */
      issues: z
        .array(z.object({ path: z.string().max(300), message: z.string().max(500) }))
        .max(100)
        .default([]),
    }),
  ),
] as const;
