import { z } from 'zod';

/** Where a hired agent (or its role) came from. */
export const PackProvenanceSchema = z.object({
  packId: z.uuid(),
  packName: z.string().max(40),
  /** The persona key inside the pack (`analyst`, without the pack prefix). */
  capability: z.string().max(130),
  /** The tag or branch the pack was added at, when it reads like a version. */
  ref: z.string().max(200).nullable().default(null),
  sha: z.string().max(64),
  /** Hash of the persona's files when the role was made: a different hash later means the pack changed it. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  visibility: z.enum(['org', 'private']).default('org'),
  /** A private pack's owner: a role made from it is the owner's alone (listed and hired by nobody else). */
  ownerUserId: z.uuid().optional(),
  /** `agent`: the role of its own of a pack agent hired without a seat (holds no pack text). Absent: made from a persona's text. */
  roleKind: z.literal('agent').optional(),
});
export type PackProvenance = z.infer<typeof PackProvenanceSchema>;
