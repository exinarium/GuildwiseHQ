import { z } from 'zod';
import { IntegrationSuiteSchema, IntegrationTestsSchema, SuiteStatusSchema } from '../runs/integration.ts';
import { RunPlanSchema, RunSettingsSchema } from '../runs/plan.ts';
import { RunEndReasonSchema, RunPurposeSchema, RunSourceSchema } from '../runs/types.ts';
import { defineEvent, Id } from './define.ts';

/**
 * Run events (docs/design/run-and-integration-tests.md section 5.2). Audience `project`. Process state, ports and health
 * are NOT events: they live in `run_environments`, updated from the runner's `run.status` messages.
 */
export const runEvents = [
  /** The Run & test settings of a project: run instructions (project and per repository) and the declared services. */
  defineEvent(
    'ProjectRunSettingsSet',
    z.object({
      projectId: Id,
      runInstructions: z.string().max(20000),
      repoInstructions: z.array(z.object({ repoId: Id, runInstructions: z.string().max(20000) })),
      settings: RunSettingsSchema,
      by: Id,
    }),
  ),
  /** The integration test setting of a project (mode, suites, how long a failed environment is kept, flaky retries). */
  defineEvent(
    'ProjectIntegrationTestsSet',
    z.object({ projectId: Id, settings: IntegrationTestsSchema, by: Id }),
  ),
  /** A tester proposed suites it found (`aom env suites propose`); they wait unconfirmed in the project settings. */
  defineEvent(
    'IntegrationSuitesProposed',
    z.object({ projectId: Id, cardId: Id, suites: z.array(IntegrationSuiteSchema).min(1).max(10) }),
  ),
  /** A suite ran in a tester's shift (`aom test suite`): feeds the card's table and the pass check. */
  defineEvent(
    'TestSuiteReported',
    z.object({
      cardId: Id,
      shiftId: Id,
      testerAgentId: Id,
      suite: z.string().min(1).max(60),
      kind: z.enum(['integration', 'e2e']).nullable(),
      envMode: z.enum(['local', 'remote']).nullable(),
      envId: Id.nullable(),
      deployTargetId: Id.nullable(),
      commit: z.string().max(64).nullable(),
      status: SuiteStatusSchema,
      passed: z.number().int().min(0),
      failed: z.number().int().min(0),
      skipped: z.number().int().min(0),
      durationMs: z.number().int().min(0),
      attempts: z.number().int().min(1).default(1),
      failures: z.array(z.string().max(300)).max(10).default([]),
      attachmentId: Id.nullable().default(null),
      note: z.string().max(2000).nullable().default(null),
    }),
  ),
  /** The runner saved the steps and services that worked (`aom run ready`). One active plan per project and workstation. */
  defineEvent(
    'RunPlanSaved',
    z.object({
      planId: Id,
      projectId: Id,
      /** Null: the project-wide plan (saved by the owner or from a confirmed scan); used where a workstation has none of its own. */
      workstationId: Id.nullable(),
      version: z.number().int().positive(),
      plan: RunPlanSchema,
      fingerprint: z.string(),
      requestId: Id.nullable(),
      envId: Id.optional(),
      /** The two halves of the fingerprint: BUILD.md (hashed by the runner) and the settings (hashed by the server). */
      buildHash: z.string().max(100).optional(),
      settingsHash: z.string().max(100).optional(),
      /** Who wrote the plan; absent = `devops` (every plan before the guided editor). */
      source: z.enum(['devops', 'owner', 'scan']).optional(),
      /** The person who saved an owner or scan plan. */
      savedBy: Id.optional(),
      /** The scan proposal an owner confirmed. */
      proposalId: Id.optional(),
    }),
  ),
  /** A start from a saved plan failed. An owner or scan plan stays active and is flagged (DevOps repairs it per workstation). */
  defineEvent('RunPlanFailureNoted', z.object({ planId: Id, projectId: Id, reason: z.string().max(4000) })),
  /** The owner dropped a workstation's own plan ("Use the project version here"). */
  defineEvent('RunPlanDiscarded', z.object({ planId: Id, projectId: Id, by: Id })),
  /** The plan no longer matches BUILD.md or the Run & test settings: the next start goes through the DevOps engineer. */
  defineEvent(
    'RunPlanMarkedStale',
    z.object({
      planId: Id,
      projectId: Id,
      workstationId: Id.nullable(),
      reason: z.enum(['settings', 'build_doc']),
    }),
  ),
  /** Someone started a branch (or the server a test environment). */
  defineEvent(
    'RunEnvironmentRequested',
    z.object({
      envId: Id,
      projectId: Id,
      workstationId: Id,
      purpose: RunPurposeSchema,
      cardId: Id.optional(),
      sources: z.array(RunSourceSchema),
      services: z.array(z.string()),
      requestedBy: Id.nullable(),
      requestId: Id.nullable(),
      expiresAt: z.iso.datetime().nullable(),
    }),
  ),
  /** Restart (same commit) or Update & restart of an environment. */
  defineEvent(
    'RunEnvironmentRestarted',
    z.object({ envId: Id, by: Id.nullable(), update: z.boolean(), revived: z.boolean().default(false) }),
  ),
  defineEvent('RunEnvironmentStopRequested', z.object({ envId: Id, by: Id.nullable() })),
  defineEvent(
    'RunEnvironmentEnded',
    z.object({ envId: Id, reason: RunEndReasonSchema, detail: z.string().max(4000).optional() }),
  ),
] as const;
