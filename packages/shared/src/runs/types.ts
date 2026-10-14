import { z } from 'zod';
import { RunPlanSchema, RunSettingsSchema } from './plan.ts';

/**
 * Run environments (docs/design/run-and-integration-tests.md): a branch of a project running on a workstation, supervised
 * by the runner. The runner reports state with `run.status`; the server keeps it in `run_environments` (operational
 * data) and sends only the start, stop and end as events.
 */

export const RUN_ENV_STATES = [
  'requested',
  'preparing',
  'starting',
  'healthy',
  'degraded',
  'stopping',
  'stopped',
  'failed',
] as const;
export const RunEnvStateSchema = z.enum(RUN_ENV_STATES);
export type RunEnvState = z.infer<typeof RunEnvStateSchema>;
/** States of an environment that still holds a worktree, ports or processes (counts against the cap). */
export const LIVE_RUN_STATES: readonly RunEnvState[] = [
  'requested',
  'preparing',
  'starting',
  'healthy',
  'degraded',
  'stopping',
];
export const isLiveRunState = (s: string): boolean => (LIVE_RUN_STATES as readonly string[]).includes(s);

export const RUN_SERVICE_STATES = [
  'pending',
  'starting',
  'healthy',
  'unhealthy',
  'exited',
  'stopped',
  'failed',
] as const;
export const RunServiceStateSchema = z.enum(RUN_SERVICE_STATES);
export type RunServiceState = z.infer<typeof RunServiceStateSchema>;

export const RunPortStatusSchema = z.object({
  name: z.string(),
  port: z.number().int(),
  /** The port the plan asked for; differs from `port` when it was taken and another was allocated. */
  wanted: z.number().int().optional(),
  url: z.string().optional(),
});
export type RunPortStatus = z.infer<typeof RunPortStatusSchema>;

export const RunServiceStatusSchema = z.object({
  name: z.string(),
  state: RunServiceStateSchema,
  ports: z.array(RunPortStatusSchema).default([]),
  urls: z.array(z.string()).default([]),
  health: z.enum(['unknown', 'passing', 'failing', 'none']).default('unknown'),
  restarts: z.number().int().nonnegative().default(0),
  exitCode: z.number().int().nullable().optional(),
  lastError: z.string().max(2000).optional(),
  pid: z.number().int().optional(),
});
export type RunServiceStatus = z.infer<typeof RunServiceStatusSchema>;

/** A repository of the environment: the branch asked for and the commit it ran at. */
export const RunSourceSchema = z.object({
  repoId: z.uuid(),
  branch: z.string().min(1).max(250),
  commit: z.string().max(64).nullable().optional(),
});
export type RunSource = z.infer<typeof RunSourceSchema>;

export const RUN_PURPOSES = ['manual', 'test'] as const;
export const RunPurposeSchema = z.enum(RUN_PURPOSES);
export type RunPurpose = z.infer<typeof RunPurposeSchema>;

export const RUN_END_REASONS = ['stopped', 'ttl', 'failed', 'verdict', 'runner_restarted'] as const;
export const RunEndReasonSchema = z.enum(RUN_END_REASONS);
export type RunEndReason = z.infer<typeof RunEndReasonSchema>;

/** Default range for allocated ports, and the workstation cap on environments. */
export const DEFAULT_RUN_PORT_RANGE = { from: 20000, to: 29999 } as const;
export const DEFAULT_MAX_RUN_ENVIRONMENTS = 2;
/** Ports the sandbox proxy bridges use: never given to a service. */
export const RESERVED_RUN_PORTS: readonly number[] = [3128, 1080];

// ------------------------------------------------------------------------------------------ runner protocol

/** `run.start`: prepare the environment's run worktrees. The services are started by DevOps through `aom run`. */
export const RunStartPayloadSchema = z.object({
  envId: z.uuid(),
  projectId: z.uuid(),
  projectKey: z.string(),
  projectName: z.string(),
  purpose: RunPurposeSchema,
  /** The DevOps request working this environment (`aom run` only answers its shift). */
  requestId: z.uuid().nullable(),
  sources: z
    .array(
      z.object({
        repoId: z.uuid(),
        name: z.string().min(1).max(200),
        remoteUrlNormalized: z.string().min(1).max(500),
        branch: z.string().min(1).max(250),
        /** The sub directory of the repository the project lives in (BUILD.md is looked for there first). */
        projectPath: z.string().optional(),
      }),
    )
    .min(1)
    .max(20),
  /** The services to start (empty: all of the plan). */
  services: z.array(z.string()).default([]),
  portRange: z.object({ from: z.number().int(), to: z.number().int() }),
  ttlAt: z.iso.datetime(),
  allowDocker: z.boolean().default(false),
});
export type RunStartPayload = z.infer<typeof RunStartPayloadSchema>;

export const RunStopPayloadSchema = z.object({
  envId: z.uuid(),
  reason: RunEndReasonSchema.default('stopped'),
});
export type RunStopPayload = z.infer<typeof RunStopPayloadSchema>;

export const RunExtendPayloadSchema = z.object({ envId: z.uuid(), ttlAt: z.iso.datetime() });
export type RunExtendPayload = z.infer<typeof RunExtendPayloadSchema>;

/** The answer to `run.start` (the command result): the worktrees are being prepared, or why not. */
export const RunStartResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(2000).optional(),
});

/** What the runner knows of the environment, sent on every change (`run.status` message). */
export const RunStatusSchema = z.object({
  envId: z.uuid(),
  state: RunEnvStateSchema,
  services: z.array(RunServiceStatusSchema).default([]),
  /** The commit each repository runs at (known once the run worktrees exist). */
  sources: z.array(z.object({ repoId: z.uuid(), commit: z.string().max(64).nullable() })).optional(),
  /** What it is doing right now ("npm ci", "waiting for api"). */
  activity: z.string().max(300).optional(),
  error: z.string().max(4000).optional(),
  /** For `stopped` and `failed`: why. */
  endReason: RunEndReasonSchema.optional(),
});
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunLogLinesSchema = z.object({
  envId: z.uuid(),
  service: z.string(),
  lines: z.array(z.string().max(4000)).max(2000),
  /** The first batch after a browser started following: the buffered tail, not new output. */
  history: z.boolean().optional(),
});
export type RunLogLines = z.infer<typeof RunLogLinesSchema>;

/** A plan saved by `aom run ready`: the setup steps and services that worked. */
export const RunPlanSavedMsgSchema = z.object({
  envId: z.uuid(),
  plan: RunPlanSchema,
  /** Hash of the BUILD.md files the plan was made from (part of the plan's fingerprint). */
  buildHash: z.string().max(100).optional(),
});

// ------------------------------------------------------------------------------------------------------ API

export const RunSourceDtoSchema = z.object({
  repoId: z.uuid(),
  repoName: z.string(),
  branch: z.string(),
  commit: z.string().nullable(),
});
export type RunSourceDto = z.infer<typeof RunSourceDtoSchema>;

export const RunEnvironmentDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  projectKey: z.string(),
  projectName: z.string(),
  workstationId: z.uuid(),
  workstationName: z.string(),
  purpose: RunPurposeSchema,
  cardId: z.uuid().nullable(),
  cardRef: z.string().nullable(),
  sources: z.array(RunSourceDtoSchema),
  /** The services asked for (empty: all). */
  services: z.array(z.string()),
  state: RunEnvStateSchema,
  servicesStatus: z.array(RunServiceStatusSchema),
  activity: z.string().nullable(),
  planVersion: z.number().int().nullable(),
  requestedBy: z.object({ id: z.uuid().nullable(), name: z.string().nullable() }),
  devopsRequestId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  healthyAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  stoppedAt: z.iso.datetime().nullable(),
  stopReason: z.string().nullable(),
  lastError: z.string().nullable(),
  canStop: z.boolean(),
  canExtend: z.boolean(),
});
export type RunEnvironmentDto = z.infer<typeof RunEnvironmentDtoSchema>;
export const RunEnvironmentsResponseSchema = z.object({ environments: z.array(RunEnvironmentDtoSchema) });
export const RunEnvironmentResponseSchema = z.object({ environment: RunEnvironmentDtoSchema });

export const RunsQuerySchema = z.object({
  projectId: z.uuid().optional(),
  cardId: z.uuid().optional(),
  workstationId: z.uuid().optional(),
  /** Only environments that still run (default true). */
  live: z.enum(['true', 'false']).optional(),
});

/** `POST /api/runs`: start a branch. Per repository a branch; absent: the card's branch / the working branch. */
export const StartRunRequestSchema = z.object({
  projectId: z.uuid(),
  workstationId: z.uuid().optional(),
  cardId: z.uuid().optional(),
  sources: z
    .array(z.object({ repoId: z.uuid(), branch: z.string().min(1).max(250) }))
    .max(20)
    .optional(),
  services: z.array(z.string()).max(20).optional(),
  note: z.string().max(2000).optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export const ExtendRunRequestSchema = z.object({ hours: z.number().int().min(1).max(72).optional() });
export type ExtendRunRequest = z.infer<typeof ExtendRunRequestSchema>;

/** `PUT /api/projects/:id/run-settings`. */
export const SetRunSettingsRequestSchema = z.object({
  runInstructions: z.string().max(20000),
  repoInstructions: z.array(z.object({ repoId: z.uuid(), runInstructions: z.string().max(20000) })).max(50),
  settings: RunSettingsSchema,
});
export type SetRunSettingsRequest = z.infer<typeof SetRunSettingsRequestSchema>;

export const RunPlanDtoSchema = z.object({
  id: z.uuid(),
  workstationId: z.uuid(),
  workstationName: z.string(),
  version: z.number().int(),
  status: z.enum(['active', 'stale', 'superseded']),
  plan: RunPlanSchema,
  savedAt: z.iso.datetime(),
});
export type RunPlanDto = z.infer<typeof RunPlanDtoSchema>;

export const RunSettingsResponseSchema = z.object({
  runInstructions: z.string(),
  repos: z.array(z.object({ repoId: z.uuid(), name: z.string(), runInstructions: z.string() })),
  settings: RunSettingsSchema,
  /** The saved plans, one per workstation (read-only here: DevOps writes them). */
  plans: z.array(RunPlanDtoSchema),
});
export type RunSettingsResponse = z.infer<typeof RunSettingsResponseSchema>;
