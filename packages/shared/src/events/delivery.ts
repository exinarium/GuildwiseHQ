import { z } from 'zod';
import { defineEvent, Id } from './define.ts';
import { DeployActor, DeployOrigin, GateEvidenceSchema } from './delivery-types.ts';

/**
 * Delivery events (docs/design/ceo-front-door.md section 9, step 2). Audience `project`. A recipe's authorization is two
 * facts: `DeliveryRecipeApproved` (who approved which content hash) and `DeployGateSatisfied` (which gate, which evidence,
 * released by whom). Neither carries a secret value, a script's content or anything a deploy printed beyond a short tail.
 */
export const DeliveryMode = z.enum(['instructions', 'recipe']);

export const GateVerdictPayload = z.object({
  gate: z.unknown(),
  evidence: z.array(GateEvidenceSchema).max(50),
});

export const deliveryEvents = [
  /** `projects.delivery_mode`: `instructions` (the prose DevOps request of a phase follow-up) or `recipe`. */
  defineEvent(
    'DeliveryModeSet',
    z.object({ projectId: Id, orgId: Id, mode: DeliveryMode, by: Id.nullable().default(null) }),
  ),
  /** The workstation inspected `delivery/` of the project vault: its content hash, the parsed recipe and the lint. */
  defineEvent(
    'DeliveryRecipeObserved',
    z.object({
      recipeId: Id,
      orgId: Id,
      projectId: Id,
      vaultId: z.string().max(64),
      path: z.string().max(200),
      vaultCommit: z.string().max(64).nullable().default(null),
      hash: z.string().length(64),
      present: z.boolean().default(true),
      recipe: z.unknown().nullable().default(null),
      lint: z.array(z.unknown()).max(100).default([]),
      fileCount: z.number().int().nonnegative().default(0),
      /** The bundle listing (path, mode, content hash): the diff against the approved version is made from it. */
      files: z
        .array(
          z.object({
            path: z.string().max(300),
            mode: z.enum(['755', '644']),
            sha256: z.string().length(64),
          }),
        )
        .max(500)
        .default([]),
      workstationId: Id.optional(),
      /** The guided setup in `delivery/setup.json` (when valid) and the environments whose script differs from what it compiles to. */
      setup: z.unknown().optional(),
      handEdited: z.array(z.string().max(40)).max(12).optional(),
    }),
  ),
  /** What was observed differs from what the Owner approved: runs are refused until it is approved again. */
  defineEvent(
    'DeliveryRecipeDrifted',
    z.object({
      recipeId: Id,
      orgId: Id,
      projectId: Id,
      hash: z.string().length(64),
      approvedHash: z.string().length(64),
    }),
  ),
  /**
   * An operator cleared the delivery setup of a project ("reset for new environments"): the observed recipe, the guided setup
   * and the approval are forgotten by the read model; this event and the earlier ones keep the history. `hash` is the content
   * that was observed, ignored when it is observed again (the vault files stay as they were; a different save starts fresh).
   */
  defineEvent(
    'DeliveryRecipeReset',
    z.object({
      recipeId: Id,
      orgId: Id,
      projectId: Id,
      hash: z.string().length(64).nullable(),
      reason: z.string().max(200),
    }),
  ),
  defineEvent(
    'DeliveryRecipeApproved',
    z.object({
      recipeId: Id,
      orgId: Id,
      projectId: Id,
      version: z.number().int().positive(),
      hash: z.string().length(64),
      vaultCommit: z.string().max(64).nullable().default(null),
      by: Id,
    }),
  ),
  defineEvent(
    'DeliveryRecipeRejected',
    z.object({
      recipeId: Id,
      orgId: Id,
      projectId: Id,
      hash: z.string().length(64),
      by: Id,
      reason: z.string().max(500).optional(),
    }),
  ),
  defineEvent(
    'GatePresetSet',
    z.object({
      orgId: Id,
      name: z.string().min(1).max(60),
      gate: z.unknown(),
      by: Id,
    }),
  ),
  defineEvent('GatePresetRemoved', z.object({ orgId: Id, name: z.string().min(1).max(60), by: Id })),
  /** "The standard rule for this project (or repository)": which preset applies to `production` (or every) environment. */
  defineEvent(
    'GateBindingSet',
    z.object({
      bindingId: Id,
      orgId: Id,
      projectId: Id.nullable().default(null),
      repoId: Id.nullable().default(null),
      envMatch: z.enum(['production', '*']),
      preset: z.string().min(1).max(60).nullable(),
      by: Id,
    }),
  ),
  /** A request for one run of one environment on one target (also a refused one: the attempt is audited). */
  defineEvent(
    'DeployRunRequested',
    z.object({
      runId: Id,
      orgId: Id,
      projectId: Id,
      recipeId: Id,
      env: z.string().max(40),
      targetId: Id.nullable().default(null),
      targetName: z.string().max(80),
      workstationId: Id.nullable().default(null),
      hash: z.string().length(64),
      vaultCommit: z.string().max(64).nullable().default(null),
      commit: z.string().max(64).nullable().default(null),
      trigger: z.string().max(20),
      requestedBy: DeployActor,
      origin: DeployOrigin.default({ untrusted: false }),
      trial: z.boolean().default(false),
      dryRun: z.boolean().default(false),
      releasedBy: z.enum(['owner', 'ceo', 'auto']),
      phaseFollowupId: Id.optional(),
    }),
  ),
  /** The gate's requirements held and someone (or a rule) released the run: the durable `deploy.exec` follows. */
  defineEvent(
    'DeployGateSatisfied',
    z.object({
      runId: Id,
      orgId: Id,
      projectId: Id,
      env: z.string().max(40),
      gate: z.unknown(),
      evidence: z.array(GateEvidenceSchema).max(50),
      releasedBy: DeployActor,
      recipeHash: z.string().length(64),
    }),
  ),
  /** The gate holds but the recipe does not let this requester release: the run waits in the release queue. */
  defineEvent(
    'DeployRunQueued',
    z.object({
      runId: Id,
      orgId: Id,
      projectId: Id,
      env: z.string().max(40),
      waitingFor: z.enum(['owner', 'ceo']),
    }),
  ),
  defineEvent(
    'DeployRunStarted',
    z.object({
      runId: Id,
      orgId: Id,
      projectId: Id,
      workstationId: Id,
      commandId: z.string().max(64).optional(),
    }),
  ),
  defineEvent(
    'DeployRunFinished',
    z.object({
      runId: Id,
      orgId: Id,
      projectId: Id,
      env: z.string().max(40),
      outcome: z.enum(['succeeded', 'failed', 'refused']),
      health: z
        .object({ ok: z.boolean(), detail: z.string().max(300).optional() })
        .nullable()
        .default(null),
      smoke: z
        .object({ ok: z.boolean(), detail: z.string().max(300).optional() })
        .nullable()
        .default(null),
      url: z.string().max(500).optional(),
      deployedCommit: z.string().max(64).nullable().default(null),
      summary: z.string().max(500).default(''),
      logTail: z.string().max(6000).default(''),
      exitCode: z.number().int().nullable().default(null),
    }),
  ),
  /** Refused before anything ran: unapproved or changed recipe, an unsatisfied gate, a hash mismatch... */
  defineEvent(
    'DeployRunRefused',
    z.object({
      runId: Id,
      orgId: Id,
      projectId: Id,
      env: z.string().max(40),
      reason: z.string().max(60),
      detail: z.string().max(500).default(''),
      missing: z.array(z.string().max(200)).max(30).default([]),
      /** What was asked for, so a refusal is a complete audit row on its own (it never takes the environment's open slot). */
      request: z
        .object({
          recipeId: Id.nullable().default(null),
          targetId: Id.nullable().default(null),
          targetName: z.string().max(80).default(''),
          hash: z.string().max(64).default(''),
          commit: z.string().max(64).nullable().default(null),
          trigger: z.string().max(20).default('on_request'),
          requestedBy: DeployActor,
          origin: DeployOrigin.default({ untrusted: false }),
          trial: z.boolean().default(false),
          releasedBy: z.enum(['owner', 'ceo', 'auto']).default('owner'),
          phaseFollowupId: Id.optional(),
        })
        .optional(),
    }),
  ),
  /** The Owner (or an Admin) cancelled a release that was still waiting. */
  defineEvent(
    'DeployRunCancelled',
    z.object({ runId: Id, orgId: Id, projectId: Id, by: Id.nullable().default(null) }),
  ),
  /** A value was sealed for the recipe's secret NAME on a workstation. Names only. */
  defineEvent(
    'DeploySecretSet',
    z.object({ projectId: Id, orgId: Id.optional(), workstationId: Id, name: z.string().max(64), by: Id }),
  ),
];
