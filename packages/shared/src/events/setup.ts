import { z } from 'zod';
import { SetupAreaSchema, SetupProposalSchema } from '../setup/proposal.ts';
import { defineEvent, Id } from './define.ts';

/**
 * Setup scans (docs/design/deploy-run-ux-design.md section 5). Audience `project`. A proposal is what the DevOps engineer
 * found in a read-only scan; it changes nothing until a person accepts it (which saves a run plan or a delivery draft).
 */
export const setupEvents = [
  /** DevOps submitted a (schema-checked) proposal with `aom setup propose`. */
  defineEvent(
    'SetupProposalSubmitted',
    z.object({
      proposalId: Id,
      projectId: Id,
      area: SetupAreaSchema,
      requestId: Id,
      workstationId: Id,
      proposal: SetupProposalSchema,
    }),
  ),
  /** The user used the proposal (`accepted`), or put it away (`dismissed`). Also `superseded` by a newer one. */
  defineEvent(
    'SetupProposalResolved',
    z.object({
      proposalId: Id,
      outcome: z.enum(['accepted', 'dismissed', 'superseded']),
      by: Id.nullable(),
    }),
  ),
];
