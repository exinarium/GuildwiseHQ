import { z } from 'zod';
import { FingerprintSchema, OpKindSchema } from '../delivery/connect.ts';
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
  /**
   * The workstation answered one of the guided-connect commands (host key scan, key, connect, revoke, prepare, check). `result`
   * is the runner's answer with nothing secret in it (public keys, fingerprints, step outcomes), kept so the page can show it.
   */
  defineEvent(
    'DeployOpFinished',
    z.object({
      opId: Id,
      projectId: Id,
      targetId: Id.nullable().default(null),
      workstationId: Id,
      kind: OpKindSchema,
      ok: z.boolean(),
      result: z.unknown().nullable().default(null),
      error: z.string().max(300).nullable().default(null),
      at: z.iso.datetime(),
    }),
  ),
  /**
   * This workstation now signs in to the target's server with its own dedicated key (the public key is on the server).
   * Public parts only: the private key never leaves the workstation.
   */
  defineEvent(
    'DeployTargetConnected',
    z.object({
      targetId: Id,
      projectId: Id,
      workstationId: Id,
      method: z.enum(['password', 'keyfile', 'panel', 'alias']),
      alias: z.string().max(64),
      fingerprint: FingerprintSchema,
      publicKey: z.string().max(600),
      address: z.string().max(253).nullable().default(null),
      user: z.string().max(32).nullable().default(null),
      port: z.number().int().nullable().default(null),
      hostKeyFingerprint: z.string().max(80).nullable().default(null),
      installed: z.enum(['added', 'already', 'pasted']),
      by: Id.nullable().default(null),
      at: z.iso.datetime(),
    }),
  ),
  /** A Guildwise-installed key was removed from the server (by the key's fingerprint), or the key was forgotten. */
  defineEvent(
    'DeployKeyRevoked',
    z.object({
      targetId: Id,
      projectId: Id,
      /** The workstation the key belonged to. */
      workstationId: Id,
      fingerprint: FingerprintSchema,
      /** The workstation that signed in to remove it. */
      byWorkstationId: Id,
      removed: z.number().int().min(0),
      by: Id.nullable().default(null),
      at: z.iso.datetime(),
    }),
  ),
  /** A server (or a folder on a computer) was prepared with the closed list of actions, after the person confirmed. */
  defineEvent(
    'DeployTargetPrepared',
    z.object({
      projectId: Id,
      targetId: Id.nullable().default(null),
      workstationId: Id,
      hosting: z.enum(['ssh', 'this_computer']),
      /** The actions and what each did, as the runner reported (no secrets). */
      steps: z.array(
        z.object({ kind: z.string().max(40), outcome: z.string().max(20), detail: z.string().max(400) }),
      ),
      ok: z.boolean(),
      dryRun: z.boolean().default(false),
      by: Id.nullable().default(null),
      at: z.iso.datetime(),
    }),
  ),
];
