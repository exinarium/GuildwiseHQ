import { z } from 'zod';
import {
  CONNECTION_STATES,
  ProbeErrorSchema,
  ProbeReportSchema,
  ProbeScopeSchema,
} from '../delivery/probe.ts';
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
  /**
   * The guided deploy wizard's work in progress (latest wins), so it resumes on another device. `customScripts` holds the
   * text of hand-written scripts of environments in custom mode. Never a secret value.
   */
  defineEvent(
    'DeliverySetupDraftSaved',
    z.object({
      projectId: Id,
      setup: z.unknown(),
      customScripts: z.record(z.string(), z.string().max(200_000)).optional(),
      /** The deploy scan proposal this draft came from. */
      proposalId: Id.optional(),
      by: Id,
    }),
  ),
  /** Audit: who had which generated files written to the project vault (the Owner still approves the hash that results). */
  defineEvent(
    'DeliverySetupPublished',
    z.object({
      projectId: Id,
      setupHash: z.string().length(64),
      commandId: Id,
      generator: z.string().max(40),
      by: Id,
    }),
  ),
  /** The workstation answered the `recipe.write` of a publish: written (`ok`) or refused with a reason. */
  defineEvent(
    'DeliverySetupPublishResult',
    z.object({
      projectId: Id,
      commandId: Id,
      ok: z.boolean(),
      error: z.string().max(500).nullable().default(null),
      vaultCommit: z.string().max(64).nullable().default(null),
    }),
  ),
  /** The workstation's read-only probe of Docker or a server (names and shapes only). */
  defineEvent(
    'DeployTargetProbed',
    z.object({
      probeId: Id,
      projectId: Id,
      targetId: Id.nullable(),
      workstationId: Id,
      scope: ProbeScopeSchema,
      host: z.string().max(64).nullable().default(null),
      report: ProbeReportSchema.nullable().default(null),
      error: ProbeErrorSchema.nullable().default(null),
      detail: z.string().max(300).nullable().default(null),
      at: z.iso.datetime(),
    }),
  ),
  /** Can this workstation sign in to the target's server? (From a probe of its ssh hosts or of the target.) */
  defineEvent(
    'DeployTargetConnectionChecked',
    z.object({
      targetId: Id,
      projectId: Id,
      workstationId: Id,
      state: z.enum(CONNECTION_STATES),
      method: z.enum(['existing_alias', 'deploy_key']).default('existing_alias'),
      host: z.string().max(64),
      detail: z.string().max(300).nullable().default(null),
      at: z.iso.datetime(),
    }),
  ),
];
