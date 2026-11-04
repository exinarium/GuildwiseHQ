import { z } from 'zod';
import { RightsReportSchema } from '../devops/environment.ts';
import { DevOpsAccessSchema } from '../events/devops.ts';
import { ConnectableForgeSchema, GitConnectionSchema, RepoRefSchema } from '../forge/index.ts';
import { McpAuthStateSchema } from '../mcp/index.ts';
import {
  JiraStatusSchema,
  OrgFolderStateSchema,
  RepoSyncStatusSchema,
  RunnerUpdateCheckResultSchema,
  RunnerUpdateStateSchema,
  RuntimeInfoSchema,
  ShiftLimitSettingSchema,
  ShiftLimitSourceSchema,
  ToolchainInfoSchema,
} from '../protocol/runner.ts';
import { IsoTime } from './common.ts';

/** Where a repository's working branch stands against origin on one workstation (the runner's last check). */
export const RepoSyncDtoSchema = RepoSyncStatusSchema.omit({ repoId: true });
export type RepoSyncDto = z.infer<typeof RepoSyncDtoSchema>;

/** Repository hygiene of a workstation: its cadence and the last run (docs/design/phases.md addendum). */
export const WorkstationHygieneSchema = z.object({
  intervalHours: z.number().int().nonnegative(),
  lastRunAt: IsoTime.nullable(),
  nextRunAt: IsoTime.nullable(),
  lastRequestId: z.uuid().nullable(),
  lastStatus: z.string().nullable(),
  openFindings: z.number().int().nonnegative(),
});
export type WorkstationHygiene = z.infer<typeof WorkstationHygieneSchema>;

export const WorkstationDtoSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: z.string(),
  platform: z.string().nullable(),
  hostname: z.string().nullable(),
  runnerVersion: z.string().nullable(),
  /** What the runner last said about updating itself (null: an older runner that does not report). */
  runnerUpdate: z
    .object({
      state: RunnerUpdateStateSchema,
      latestVersion: z.string().nullable(),
      lastCheckedAt: IsoTime.nullable(),
      detail: z.string().nullable(),
      reportedAt: IsoTime,
    })
    .nullable()
    .optional(),
  /**
   * "Check for updates": whether the runner answers it (`supported` null: capabilities not reported yet), the state of the
   * latest request (`checking`: asked, no answer yet; `timed_out`: no answer in 5 minutes; `idle`: nothing asked or answered)
   * and the runner's last answer. A new request is accepted from `nextAllowedAt` (one a minute).
   */
  updateCheck: z
    .object({
      supported: z.boolean().nullable(),
      state: z.enum(['idle', 'checking', 'timed_out']),
      requestedAt: IsoTime.nullable(),
      nextAllowedAt: IsoTime.nullable(),
      result: RunnerUpdateCheckResultSchema.extend({ at: IsoTime }).nullable(),
    })
    .optional(),
  /** Safe mode: the runner version the platform team pinned this workstation to (its own pin, else the all-workstations one). */
  runnerPin: z
    .object({ version: z.string(), reason: z.string().nullable(), scope: z.enum(['workstation', 'all']) })
    .nullable()
    .optional(),
  /** Work in a project or on this workstation is paused by the platform team (the count of open pauses that apply). */
  platformPauses: z.number().int().optional(),
  status: z.enum(['active', 'unlinked']),
  connected: z.boolean(),
  lastSeenAt: IsoTime.nullable(),
  runtimes: z.array(RuntimeInfoSchema),
  /** Project repos this workstation holds a clone of. */
  repos: z.array(
    z.object({
      projectRepoId: z.uuid(),
      localPath: z.string(),
      reportedAt: IsoTime,
      /** The working branch against origin (absent: not checked yet). */
      sync: RepoSyncDtoSchema.nullable().optional(),
    }),
  ),
  pairedAt: IsoTime,
  /** M3: what this workstation's DevOps engineer may do without asking, and who it is. */
  devopsAccess: DevOpsAccessSchema.optional(),
  devopsAgentId: z.uuid().nullable().optional(),
  hygiene: WorkstationHygieneSchema.optional(),
  /** Run a branch (#58): whether the runner can do it and how many environments it holds at most. */
  runs: z.object({ capable: z.boolean(), maxEnvironments: z.number().int() }).optional(),
  /**
   * What the runner found when it last checked the rights ticked on the DevOps engineer (null: never checked, or
   * nothing ticked). `stale`: the ticks changed since.
   */
  rights: RightsReportSchema.extend({ stale: z.boolean().default(false) })
    .nullable()
    .optional(),
  /**
   * The state of the latest "Verify now": `checking` (asked, no answer yet), `failed` (the runner answered with an
   * error, `message` says which), `timed_out` (no answer within a minute), `unsupported` (this runner is too old to
   * check rights: it never announced its key), `idle` (nothing outstanding; `rights` holds the latest result).
   */
  rightsCheck: z
    .object({
      state: z.enum(['idle', 'checking', 'failed', 'timed_out', 'unsupported']),
      message: z.string().nullable(),
      requestedAt: IsoTime.nullable(),
    })
    .optional(),
  /** The sudo password: whether one is stored on the runner and the key it is encrypted with (never the password). */
  sudo: z
    .object({
      keyId: z.string().nullable(),
      passwordSet: z.boolean(),
      setAt: IsoTime.nullable(),
      works: z.boolean().nullable(),
    })
    .optional(),
  /** Which git providers this workstation is connected to (facts reported by the runner; never a credential). */
  git: z.object({ connections: z.array(GitConnectionSchema), checkedAt: IsoTime.nullable() }).optional(),
  /** Jira on this workstation (facts only): connected, not connected or refused. */
  jira: z.object({ status: JiraStatusSchema.nullable(), checkedAt: IsoTime.nullable() }).optional(),
  /** The plugin MCP servers this workstation reports, with their sign-in state (facts only; absent: not reported). */
  mcpServers: z
    .array(
      z.object({
        name: z.string(),
        plugin: z.string(),
        server: z.string(),
        authState: McpAuthStateSchema.optional(),
      }),
    )
    .optional(),
  /**
   * The organisation source folders the runner reports (set with the app or `aom-runner org-folder`), by organisation,
   * with the folders it offers in the picker. Only sent to the workstation's owner (absent in the admin list).
   */
  orgFolders: z
    .object({
      folders: z.array(OrgFolderStateSchema),
      /** Organisations whose last "set" the runner refused, with the reason (cleared by the next success). */
      errors: z.record(z.string(), z.string()),
      candidates: z.array(z.string()),
      checkedAt: IsoTime.nullable(),
    })
    .optional(),
  /** Agent toolchains the runner reports (detected, configured, registered by the DevOps engineer). Owner only. */
  toolchains: z.object({ items: z.array(ToolchainInfoSchema), checkedAt: IsoTime.nullable() }).optional(),
  /**
   * Shifts running now and how many this workstation takes at once (backlog #76). `limit` is what is in force (null while
   * it is offline and nothing is set, and while it is unlimited), `setting` what the owner chose (null: the runner's own
   * value), `unlimited` that nothing but the machine limits it, `platformCap` the platform's ceiling (null: none) and
   * `runnerLimit` the runner's own configured value. `supported` says whether the runner applies the setting (false: update it).
   */
  shifts: z
    .object({
      running: z.number().int().nonnegative(),
      limit: z.number().int().positive().nullable(),
      setting: ShiftLimitSettingSchema.default(null),
      unlimited: z.boolean().default(false),
      platformCap: z.number().int().positive().nullable().default(null),
      runnerLimit: z.number().int().positive().nullable().default(null),
      supported: z.boolean().nullable().default(null),
      /** Where `limit` comes from on the server (null: offline with nothing set). */
      source: ShiftLimitSourceSchema.nullable().default(null),
      /**
       * What the runner reports it enforces (`limit` null: no limit). Null while it is offline, before its first report
       * and for a runner without `shift-limit:2`.
       */
      enforced: z
        .object({ limit: z.number().int().nonnegative().nullable(), source: ShiftLimitSourceSchema })
        .nullable()
        .default(null),
      /**
       * `in_sync`: the runner enforces what the server holds; `applying`: a change has not been reported back yet;
       * `mismatch`: the runner enforces something else; `unknown`: offline or the runner does not report it.
       */
      sync: z.enum(['in_sync', 'applying', 'mismatch', 'unknown']).default('unknown'),
      /** Chat and CEO turns running now: they take no slot (`SHIFT_KINDS_OUTSIDE_LIMIT`). */
      otherRunning: z.number().int().nonnegative().default(0),
      /** The shifts holding a slot now (identifiers only). */
      holders: z
        .array(
          z.object({
            shiftId: z.uuid(),
            kind: z.string(),
            cardRef: z.string().nullable(),
            agentName: z.string().nullable(),
          }),
        )
        .default([]),
    })
    .optional(),
});
export type WorkstationDto = z.infer<typeof WorkstationDtoSchema>;
/**
 * `GET /api/workstations/:id/unlink-impact`: the places (deploy targets) that run on this computer, with the environments that
 * use each, so the Unpair dialog can say what will need another computer. Unpairing still goes ahead once confirmed.
 */
export const UnlinkImpactResponseSchema = z.object({
  places: z.array(
    z.object({
      placeId: z.uuid(),
      placeName: z.string(),
      kind: z.enum(['computer', 'server']),
      production: z.boolean(),
      projectId: z.uuid(),
      projectName: z.string(),
      environments: z.array(z.object({ env: z.string(), label: z.string() })),
    }),
  ),
});
export type UnlinkImpactResponse = z.infer<typeof UnlinkImpactResponseSchema>;
export const WorkstationsResponseSchema = z.object({ workstations: z.array(WorkstationDtoSchema) });

/** `GET /api/workstations/:id/sudo-key`: the public key to encrypt the sudo password with (RSA-OAEP, SHA-256). */
export const SudoKeyResponseSchema = z.object({
  keyId: z.string(),
  publicKey: z.string(),
  /** The runner opens sealed sign-ins bound to the server address (`h2`). Absent from an older server or runner. */
  sealAad: z.boolean().optional(),
});
export type SudoKeyResponse = z.infer<typeof SudoKeyResponseSchema>;
/** `PUT /api/workstations/:id/sudo-password`: the password encrypted in the browser; the server cannot read it. */
export const SetSudoPasswordRequestSchema = z.object({
  ciphertext: z.string().min(1).max(2000),
  keyId: z.string().min(1).max(64),
});
export type SetSudoPasswordRequest = z.infer<typeof SetSudoPasswordRequestSchema>;

/** `PUT /api/workstations/:id/org-folder`: set (`path`) or clear (`path: null`) the organisation source folder. */
export const SetOrgFolderRequestSchema = z.object({
  orgId: z.uuid(),
  path: z.string().trim().min(1).max(1000).nullable(),
});
export type SetOrgFolderRequest = z.infer<typeof SetOrgFolderRequestSchema>;

/** `POST /api/workstations/:id/toolchains/remove`: the owner removes a toolchain the DevOps engineer registered. */
export const RemoveToolchainRequestSchema = z.object({ name: z.string().trim().min(1).max(80) });
export type RemoveToolchainRequest = z.infer<typeof RemoveToolchainRequestSchema>;

/** `PUT /api/workstations/:id/shift-limit`: how many shifts this workstation runs at once (null: the runner's own value). */
export const SetShiftLimitRequestSchema = z.object({ limit: ShiftLimitSettingSchema });
export type SetShiftLimitRequest = z.infer<typeof SetShiftLimitRequestSchema>;

export const PatchWorkstationRequestSchema = z.object({ name: z.string().min(1).max(80) });

/** `POST /api/workstations/pairing-codes` -> `XXXX-XXXX` (Crockford base32), shown once, 10 min TTL. */
export const PairingCodeResponseSchema = z.object({ code: z.string(), expiresAt: IsoTime });
export type PairingCodeResponse = z.infer<typeof PairingCodeResponseSchema>;
export const PAIRING_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** `POST /api/runner/pair` (unauthenticated). */
export const RunnerPairRequestSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1).max(80),
  platform: z.string(),
  hostname: z.string(),
  runnerVersion: z.string(),
});
export type RunnerPairRequest = z.infer<typeof RunnerPairRequestSchema>;
export const RunnerPairResponseSchema = z.object({
  workstationId: z.uuid(),
  /** `aomr_` + 32 random bytes base64url. */
  runnerToken: z.string().startsWith('aomr_'),
});
export type RunnerPairResponse = z.infer<typeof RunnerPairResponseSchema>;

/** `POST /api/workstations/:id/git/repos`: ask the workstation for the user's repositories on a connected provider. */
export const ForgeRepoListRequestSchema = z.object({
  provider: ConnectableForgeSchema,
  search: z.string().max(100).optional(),
});
export type ForgeRepoListRequest = z.infer<typeof ForgeRepoListRequestSchema>;

/** The picker's answer (poll `GET /api/workstations/:id/git/repos/:requestId` until `state` is not `pending`). */
export const ForgeRepoListSchema = z.object({
  requestId: z.uuid(),
  provider: ConnectableForgeSchema,
  state: z.enum(['pending', 'done', 'failed']),
  repos: z.array(RepoRefSchema),
  error: z.string().nullable(),
});
export type ForgeRepoList = z.infer<typeof ForgeRepoListSchema>;

/** `POST /api/workstations/:id/update-check`: the check was queued (the answer shows in `updateCheck` of the workstation). */
export const UpdateCheckResponseSchema = z.object({ ok: z.literal(true), requestedAt: IsoTime });
export type UpdateCheckResponse = z.infer<typeof UpdateCheckResponseSchema>;

// ------------------------------------------------------------------------------------ retire a workstation

/** What happens to the agents of a retired workstation: move them all to another one, or let them be re-homed later. */
export const RETIRE_HANDOVERS = ['move', 'needs_rehome'] as const;
export const RetireWorkstationRequestSchema = z
  .object({
    /** Required when the workstation has agents to hand over. */
    handover: z.enum(RETIRE_HANDOVERS).optional(),
    /** Required for `move`. */
    targetWorkstationId: z.uuid().optional(),
    /** Passed to the sandbox gate of the move. */
    acknowledgeUnsandboxed: z.boolean().optional(),
  })
  .refine((r) => r.handover !== 'move' || !!r.targetWorkstationId, { path: ['targetWorkstationId'] });
export type RetireWorkstationRequest = z.infer<typeof RetireWorkstationRequestSchema>;

const RetireAgentRefSchema = z.object({ id: z.uuid(), name: z.string(), roleKey: z.string() });
export type RetireAgentRef = z.infer<typeof RetireAgentRefSchema>;

/** `GET /api/workstations/:id/retire-preview`: what retiring would do (nothing is written). */
export const RetirePreviewSchema = z.object({
  workstation: z.object({
    id: z.uuid(),
    name: z.string(),
    /** `unlinked` = unpaired or retired. */
    status: z.enum(['active', 'unlinked']),
    mine: z.boolean(),
  }),
  /** The agents to hand over (not the DevOps engineers). */
  agents: z.array(RetireAgentRefSchema.extend({ status: z.string(), otherOrg: z.boolean() })),
  /** Retired together with the workstation. */
  devops: z.array(RetireAgentRefSchema),
  /** Agents in a running shift: retiring is refused while there are any. */
  working: z.array(RetireAgentRefSchema.extend({ cardRef: z.string().nullable() })),
  /** Open cards whose stage restarts from the base branch. */
  homedCards: z.array(z.object({ ref: z.string(), title: z.string() })),
  /** Still paired and the caller's own machine: retiring also unpairs it. */
  canUnpair: z.boolean(),
});
export type RetirePreview = z.infer<typeof RetirePreviewSchema>;

export const RetireWorkstationResponseSchema = z.object({
  workstationId: z.uuid(),
  unlinked: z.boolean(),
  handover: z.enum(['move', 'needs_rehome', 'none']),
  moved: z.array(RetireAgentRefSchema),
  needsRehome: z.array(RetireAgentRefSchema),
  retiredDevops: z.array(RetireAgentRefSchema),
  rehomedCardIds: z.array(z.uuid()),
});
export type RetireWorkstationResponse = z.infer<typeof RetireWorkstationResponseSchema>;
