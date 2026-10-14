import { z } from 'zod';
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
  /** The runner saved the steps and services that worked (`aom run ready`). One active plan per project and workstation. */
  defineEvent(
    'RunPlanSaved',
    z.object({
      planId: Id,
      projectId: Id,
      workstationId: Id,
      version: z.number().int().positive(),
      plan: RunPlanSchema,
      fingerprint: z.string(),
      requestId: Id.nullable(),
      envId: Id.optional(),
      /** The two halves of the fingerprint: BUILD.md (hashed by the runner) and the settings (hashed by the server). */
      buildHash: z.string().max(100).optional(),
      settingsHash: z.string().max(100).optional(),
    }),
  ),
  /** The plan no longer matches BUILD.md or the Run & test settings: the next start goes through the DevOps engineer. */
  defineEvent(
    'RunPlanMarkedStale',
    z.object({
      planId: Id,
      projectId: Id,
      workstationId: Id,
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
