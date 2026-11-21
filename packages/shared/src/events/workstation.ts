import { z } from 'zod';
import { PasskeyAlgSchema, WorkstationReleaseSchema } from '../security/index.ts';
import { defineEvent, Id } from './define.ts';

export const workstationEvents = [
  defineEvent(
    'WorkstationPaired',
    z.object({
      workstationId: Id,
      userId: Id,
      name: z.string().min(1),
      platform: z.string().nullable(),
      hostname: z.string().nullable(),
      runnerVersion: z.string().nullable(),
      tokenHash: z.string().min(1),
      /** The simulated workstation of this simulation organization (hosted by the server); absent for real ones. */
      simulationOrgId: Id.optional(),
      /** 1.10.0: the runner release the server verified at pairing (R21, R27); absent on older events and simulations. */
      release: WorkstationReleaseSchema.optional(),
    }),
  ),
  /** The owner set how many shifts this workstation runs at once: a number, `unlimited`, or null (the runner's own value). */
  defineEvent(
    'WorkstationShiftLimitSet',
    z.object({
      workstationId: Id,
      limit: z.union([z.number().int().min(1).max(10_000), z.literal('unlimited')]).nullable(),
      changedBy: Id,
    }),
  ),
  /** The owner allows (or stops allowing) projects they are not a member of to use their named accounts on this workstation. */
  defineEvent(
    'WorkstationAccountSharingSet',
    z.object({ workstationId: Id, allow: z.boolean(), changedBy: Id }),
  ),
  defineEvent('WorkstationRenamed', z.object({ workstationId: Id, name: z.string().min(1) })),
  /** `signed_required`: unlinked by the signed-runner sweep (R21) because it has no valid signed-release proof. */
  defineEvent(
    'WorkstationUnlinked',
    z.object({ workstationId: Id, by: z.enum(['owner', 'admin', 'signed_required']) }),
  ),
  /** An Owner or Admin retired a workstation and handed its agents over (the audit of the retirement, one per organization). */
  defineEvent(
    'WorkstationRetired',
    z.object({
      workstationId: Id,
      orgId: Id,
      by: Id,
      handover: z.enum(['move', 'needs_rehome', 'none']),
      targetWorkstationId: Id.nullable(),
      movedAgentIds: z.array(Id),
      needsRehomeAgentIds: z.array(Id),
      /** True when this retirement also unpaired the machine. */
      unlinked: z.boolean(),
    }),
  ),
  defineEvent('WorkstationConnected', z.object({ workstationId: Id, runnerVersion: z.string().optional() })),
  /** A runner re-probe changed a runtime's availability or sandbox state (drives live refresh; no projection). */
  defineEvent(
    'WorkstationRuntimesChanged',
    z.object({
      workstationId: Id,
      runtimes: z.array(
        z.object({
          id: z.string(),
          available: z.boolean(),
          sandbox: z.string().optional(),
          auth: z.string().optional(),
          usage: z.string().optional(),
          limitedUntil: z.string().optional(),
          /** Claude Code accounts (main and additional); absent from older runners. */
          accounts: z
            .array(
              z.object({
                key: z.string(),
                login: z.string(),
                usage: z.string(),
                limitedUntil: z.string().optional(),
              }),
            )
            .optional(),
        }),
      ),
    }),
  ),
  defineEvent('WorkstationDisconnected', z.object({ workstationId: Id })),
  defineEvent('WorkstationTokenRotated', z.object({ workstationId: Id, tokenHash: z.string().min(1) })),
  // Integrations audit (docs/design/integrations-page.md D7): who did what, never a token, field value, URL or code.
  defineEvent(
    'WorkstationIntegrationConnected',
    z.object({
      workstationId: Id,
      kind: z.string().max(40),
      instance: z.string().max(200),
      method: z.string().max(40).optional(),
      account: z.string().max(200).optional(),
      by: Id,
    }),
  ),
  defineEvent(
    'WorkstationIntegrationRemoved',
    z.object({ workstationId: Id, kind: z.string().max(40), instance: z.string().max(200), by: Id }),
  ),
  defineEvent(
    'WorkstationIntegrationSignInStarted',
    z.object({
      workstationId: Id,
      kind: z.string().max(40),
      instance: z.string().max(200),
      method: z.string().max(40),
      by: Id,
    }),
  ),
  /**
   * Which organizations this workstation works for (R9, F4). Rows come only from these events, never from membership:
   * pairing serves the orgs the user owns (`owner_org`), accept opt-in (`accept`), the "Works for" switch (`works_for`), a
   * hire onto one's own workstation (`hire`), and the data migration for existing pairs (`existing`).
   */
  defineEvent(
    'WorkstationOrgServingSet',
    z.object({
      workstationId: Id,
      orgId: Id,
      serving: z.boolean(),
      by: Id.nullable(),
      reason: z.enum(['owner_org', 'accept', 'works_for', 'hire', 'existing']),
    }),
  ),
  /**
   * A passkey registered for approvals on this workstation (R22). The server verified the WebAuthn registration; the
   * runner trusts it only after a local `guildwise-runner passkey trust`. `publicKey` is SPKI, base64.
   */
  defineEvent(
    'WorkstationPasskeyAdded',
    z.object({
      workstationId: Id,
      passkeyId: Id,
      credentialId: z.string().min(1).max(1024),
      publicKey: z.string().min(1).max(4096),
      alg: PasskeyAlgSchema,
      name: z.string().min(1).max(80),
      by: Id,
    }),
  ),
  defineEvent('WorkstationPasskeyRemoved', z.object({ workstationId: Id, passkeyId: Id, by: Id })),
] as const;
