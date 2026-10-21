import { z } from 'zod';
import { FingerprintSchema, OpKindSchema } from '../delivery/connect.ts';
import { MoveFactsSchema, MoveSpecSchema, MoveStateSchema, MoveStepSchema } from '../delivery/move.ts';
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
  /**
   * The user answered questions of an open proposal. The event carries the whole updated proposal (the answers stored on the
   * questions and applied to the proposed run plan or setup), so a replay needs nothing else.
   */
  defineEvent(
    'SetupProposalAnswered',
    z.object({ proposalId: Id, proposal: SetupProposalSchema, by: Id }),
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
  /**
   * Moving to a new server (design v3) started: from the target an environment deploys to now, to a new server's target. The
   * spec is taken from the approved guided setup on the server.
   */
  defineEvent(
    'DeployTargetMoveStarted',
    z.object({
      moveId: Id,
      projectId: Id,
      envName: z.string().max(60),
      fromTargetId: Id,
      toTargetId: Id,
      workstationId: Id,
      spec: MoveSpecSchema,
      domain: z.string().max(253).nullable().default(null),
      by: Id,
      at: z.iso.datetime(),
    }),
  ),
  /** The computer answered one step of a move (what it did, in plain words; no secret values). */
  defineEvent(
    'DeployTargetMoveStepDone',
    z.object({
      moveId: Id,
      projectId: Id,
      step: MoveStepSchema,
      ok: z.boolean(),
      detail: z.string().max(400).nullable().default(null),
      checks: z
        .array(z.object({ id: z.string().max(40), ok: z.boolean(), text: z.string().max(300) }))
        .default([]),
      facts: MoveFactsSchema.default({}),
      /** The state the move is in now; stated in the event so a replay needs no logic. */
      state: MoveStateSchema,
      oldAppStopped: z.boolean(),
      error: z.string().max(500).nullable().default(null),
      at: z.iso.datetime(),
    }),
  ),
  /** The person agreed to the downtime, or pressed Try again: the move runs on from `step`. */
  defineEvent(
    'DeployTargetMoveResumed',
    z.object({ moveId: Id, projectId: Id, step: MoveStepSchema, by: Id, at: z.iso.datetime() }),
  ),
  /** The Owner made the new server live: it takes over the name (so the approved deploy files point at it) and the old one becomes the standby. */
  defineEvent(
    'DeployTargetMoveCompleted',
    z.object({
      moveId: Id,
      projectId: Id,
      fromTargetId: Id,
      toTargetId: Id,
      /** The names after the swap, decided once (a replay does not compute them). */
      fromNewName: z.string().min(1).max(120),
      toNewName: z.string().min(1).max(120),
      /** The new server takes the old one's "production" mark and web address (the deploys read them from the target). */
      production: z.boolean(),
      appUrl: z.string().max(500).nullable().default(null),
      dns: z.enum(['verified', 'unverified']),
      by: Id,
      at: z.iso.datetime(),
    }),
  ),
  /** The move was given up. The old app was started again when this move had stopped it. */
  defineEvent(
    'DeployTargetMoveCancelled',
    z.object({ moveId: Id, projectId: Id, by: Id, at: z.iso.datetime() }),
  ),
  /** The Owner retired a standby server: Guildwise's keys were removed from it. Nothing else was touched there. */
  defineEvent(
    'DeployTargetRetired',
    z.object({
      targetId: Id,
      projectId: Id,
      removedKeys: z.number().int().min(0),
      by: Id,
      at: z.iso.datetime(),
    }),
  ),
];
