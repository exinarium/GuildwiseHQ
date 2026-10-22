import { z } from 'zod';
import { CapabilityKindSchema, CapabilityMetaSchema } from '../capabilities/parse.ts';

/** `GET /api/capabilities`: the effective registry of the organization (built-ins overridden by the organization vault, by kind and key). */
export const ListCapabilitiesQuerySchema = z.object({ kind: CapabilityKindSchema.optional() });
export const CapabilitiesResponseSchema = z.object({
  items: z.array(
    CapabilityMetaSchema.extend({
      /** The built-in this entry replaces, when it overrides one. */
      overrides: z.boolean(),
    }),
  ),
  /** Vault files that did not parse, so the owner can fix them. */
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
  /** When a workstation last reported the organization vault's index; null: never. */
  indexedAt: z.iso.datetime().nullable(),
});
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;
