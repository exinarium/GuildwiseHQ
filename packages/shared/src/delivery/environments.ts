import { z } from 'zod';
import { IsoTime } from '../api/common.ts';
import { EnvNameSchema } from './gate.ts';
import { ConnectionStateSchema } from './probe.ts';

/**
 * API of the Environments page (docs/design/environments-ux.md section 13, "API contract (as built)"). Everything here is
 * derived from rows that exist (deploy targets, deploy runs, the stored setup); nothing carries a secret or a script.
 */

export const EnvRoleSchema = z.enum(['test', 'live', 'other']);
export type EnvRole = z.infer<typeof EnvRoleSchema>;

// ------------------------------------------------------------------------------------------------------- places

/** `GET /api/projects/:id/places` */
export const PlaceDtoSchema = z.object({
  /** The deploy target's id (a place and a target are the same row). */
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(['computer', 'server']),
  workstationId: z.uuid().nullable(),
  workstationName: z.string().nullable(),
  workstationOnline: z.boolean().nullable(),
  /** The ssh alias (servers). */
  host: z.string().nullable(),
  appUrl: z.string().nullable(),
  production: z.boolean(),
  role: z.enum(['active', 'standby', 'retired']),
  /** Can the deploying computer sign in? Null: never checked, or a computer. */
  reachability: z
    .object({
      state: ConnectionStateSchema,
      at: IsoTime,
      detail: z.string().nullable(),
      method: z.enum(['existing_alias', 'deploy_key']).optional(),
    })
    .nullable(),
  /** When the newest look at this place finished. */
  lastProbeAt: IsoTime.nullable(),
  /** Environments of the SAVED setup (what runs) that use this place. */
  usedBy: z.array(z.object({ env: z.string(), label: z.string() })),
  /** Environments that only the unfinished draft uses. */
  usedByDraft: z.array(z.string()),
  /** Phase follow-ups that are not finished and name this place. */
  usedByFollowups: z.number().int(),
  /** Looks like another place of the project: same server alias on the same computer, or the same computer. */
  duplicateOf: z
    .object({ id: z.uuid(), name: z.string(), reason: z.enum(['same_server', 'same_computer']) })
    .nullable(),
  /** Number of dedicated Guildwise keys this place has (public parts are in the setup state). */
  keyCount: z.number().int(),
  canRemove: z.boolean(),
  /** Why not, in a sentence naming the environments that use it; null when it can be removed. */
  removeBlockedReason: z.string().nullable(),
});
export type PlaceDto = z.infer<typeof PlaceDtoSchema>;
export const PlacesResponseSchema = z.object({ places: z.array(PlaceDtoSchema), canEdit: z.boolean() });
export type PlacesResponse = z.infer<typeof PlacesResponseSchema>;

/** `POST /api/projects/:id/places/:placeId/remove` (project owner). 409 `place_in_use` names the environments. */
export const RemovePlaceRequestSchema = z.object({
  /** Also remove Guildwise's own key from the server and delete this computer's key material for it. */
  removeKey: z.boolean().default(false),
  /** With `removeKey`: delete this computer's key even if the server cannot be asked to drop it (the person confirmed). */
  forgetKeyAnyway: z.boolean().default(false),
});
export type RemovePlaceRequest = z.infer<typeof RemovePlaceRequestSchema>;
export const RemovePlaceResultSchema = z.object({
  removed: z.literal(true),
  /**
   * `none`: no key to clean up (or not asked). `started`: a command is on its way to the computer (poll
   * `GET /api/projects/:id/delivery/ops/:commandId`); the place is already gone whatever the answer. `skipped`: it could not
   * be started, `reason` says why in plain words.
   */
  keyCleanup: z.object({
    state: z.enum(['none', 'started', 'skipped']),
    commandId: z.string().nullable(),
    reason: z.string().nullable(),
  }),
});
export type RemovePlaceResult = z.infer<typeof RemovePlaceResultSchema>;

/** `POST /api/projects/:id/places/merge` (project owner): the two places are the same server; keep `toId`. */
export const MergePlacesRequestSchema = z.object({ fromId: z.uuid(), toId: z.uuid() });
export type MergePlacesRequest = z.infer<typeof MergePlacesRequestSchema>;
export const MergePlacesResultSchema = z.object({
  /** Environments of the draft that now point at `toId` (the draft is saved). */
  repointed: z.array(z.string()),
  /** Unfinished phase follow-ups that were re-pointed. */
  followupsRepointed: z.number().int(),
  /** The merged-away place is removed only when no SAVED environment uses it any more. */
  removed: z.boolean(),
  /** Saved environments that still use `fromId`: publish and approve the draft, then remove the place. */
  stillUsedBySaved: z.array(z.string()),
});
export type MergePlacesResult = z.infer<typeof MergePlacesResultSchema>;

/** `PUT /api/projects/:id/delivery/setup/environments/:env/place`: point an environment of the draft at a place. */
export const SetEnvironmentPlaceRequestSchema = z.object({ placeId: z.uuid() });
export type SetEnvironmentPlaceRequest = z.infer<typeof SetEnvironmentPlaceRequestSchema>;

// -------------------------------------------------------------------------------------------- environment status

export const ENV_CARD_STATES = [
  'draft',
  'needs_try',
  'waiting_approval',
  'healthy',
  'unhealthy',
  'updating',
  'needs_answer',
  'blocked',
  'cannot_reach',
  'failed',
  'changed',
  'custom',
  'not_set_up',
] as const;
export const EnvCardStateSchema = z.enum(ENV_CARD_STATES);
export type EnvCardState = z.infer<typeof EnvCardStateSchema>;

export const EnvironmentStatusDtoSchema = z.object({
  env: z.string(),
  label: z.string(),
  role: EnvRoleSchema,
  hosting: z.enum(['this_computer', 'ssh']),
  /** What runs: a Compose stack or an app that runs directly on the machine. */
  runtime: z.enum(['docker', 'direct']).default('docker'),
  placeId: z.uuid().nullable(),
  placeName: z.string(),
  appUrl: z.string().nullable(),
  /** Who may press release, and when it updates by itself, in words the page can print. */
  releasedBy: z.enum(['owner', 'ceo', 'auto']),
  updates: z.string(),
  /** The rules of its gate, one sentence each (`describeGate`). */
  rules: z.array(z.string()),
  /** The newest successful real (not trial, not dry-run) release. */
  current: z
    .object({
      runId: z.uuid(),
      commit: z.string().nullable(),
      version: z.string().nullable(),
      since: IsoTime,
      releasedBy: z.string().nullable(),
      kind: z.enum(['release', 'rollback']),
    })
    .nullable(),
  health: z.object({
    state: z.enum(['healthy', 'unhealthy', 'unknown']),
    at: IsoTime.nullable(),
    detail: z.string().nullable(),
  }),
  lastRun: z
    .object({
      runId: z.uuid(),
      status: z.string(),
      at: IsoTime,
      summary: z.string().nullable(),
      rolledBack: z.boolean(),
    })
    .nullable(),
  waitingRelease: z
    .object({ runId: z.uuid(), commit: z.string().nullable(), waitingFor: z.enum(['owner', 'ceo']) })
    .nullable(),
  /** Why a release cannot go yet ("the test site is healthy for 3 more minutes"); empty when nothing blocks it. */
  blockedBy: z.array(z.string()),
  /** Saved > Tried > Approved, for the three-dot strip. */
  savedState: z.enum(['none', 'draft', 'saved']),
  triedState: z.enum(['none', 'needs_try', 'tried']),
  approvalState: z.enum(['none', 'unapproved', 'approved', 'changed']),
  /** Open questions of a DevOps proposal that concern this environment. */
  openQuestions: z.number().int(),
  state: EnvCardStateSchema,
  /** One plain sentence for the card (never a lint code). */
  stateText: z.string(),
});
export type EnvironmentStatusDto = z.infer<typeof EnvironmentStatusDtoSchema>;

/** `GET /api/projects/:id/environments/status` (any project member, read-only). */
export const EnvironmentsStatusResponseSchema = z.object({
  environments: z.array(EnvironmentStatusDtoSchema),
  /** Unfinished questions of the open proposal (for the page banner). */
  openQuestions: z.number().int(),
  /** `recipe` once guided deploys are on; `instructions` after "Stop using guided deploys". */
  deliveryMode: z.enum(['instructions', 'recipe']),
  generatedAt: IsoTime,
});
export type EnvironmentsStatusResponse = z.infer<typeof EnvironmentsStatusResponseSchema>;

/** `GET /api/org/live` (any member of the organization; only projects the viewer can see). */
export const LiveRowDtoSchema = z.object({
  projectId: z.uuid(),
  projectKey: z.string(),
  projectName: z.string(),
  env: z.string(),
  label: z.string(),
  role: EnvRoleSchema,
  placeName: z.string(),
  appUrl: z.string().nullable(),
  commit: z.string().nullable(),
  version: z.string().nullable(),
  since: IsoTime.nullable(),
  health: z.enum(['healthy', 'unhealthy', 'unknown']),
  waitingReleases: z.number().int(),
});
export type LiveRowDto = z.infer<typeof LiveRowDtoSchema>;
export const OrgLiveResponseSchema = z.object({ rows: z.array(LiveRowDtoSchema), generatedAt: IsoTime });
export type OrgLiveResponse = z.infer<typeof OrgLiveResponseSchema>;

// -------------------------------------------------------------------------------------------------------- rollback

/** One earlier successful release of an environment that a rollback may go back to. */
export const EarlierReleaseDtoSchema = z.object({
  runId: z.uuid(),
  commit: z.string(),
  version: z.string().nullable(),
  at: IsoTime,
  releasedBy: z.string().nullable(),
  targetName: z.string(),
  kind: z.enum(['release', 'rollback']),
  /** The version that runs now (cannot be rolled back to). */
  current: z.boolean(),
  /** The database backup taken before it, when the run says where (plain text, for the explanation). */
  backupNote: z.string().nullable(),
});
export type EarlierReleaseDto = z.infer<typeof EarlierReleaseDtoSchema>;
/** `GET /api/projects/:id/environments/:env/releases?limit=5` (Owner and Admin). */
export const EarlierReleasesResponseSchema = z.object({
  releases: z.array(EarlierReleaseDtoSchema),
  canRollback: z.boolean(),
});
export type EarlierReleasesResponse = z.infer<typeof EarlierReleasesResponseSchema>;

/**
 * `POST /api/projects/:id/releases/rollback` (org Owner or Admin). `runId` must be an earlier SUCCESSFUL release of that
 * environment. Answers like `POST .../deploy` (`DeployResult`). The run has `trigger: "rollback"`: the gate's test-site and
 * window rules do not apply (the audit says so), a freeze still blocks, and it is released at once: the Owner or Admin who asks
 * IS the one who releases (the same rule as the Release button), so the confirm sheet is the approval and nothing waits in the
 * release queue (design section 13.1).
 */
export const RollbackRequestSchema = z.object({
  env: EnvNameSchema,
  runId: z.uuid(),
  /** Server names; absent: the place of that run. */
  targets: z.array(z.string().max(80)).max(20).optional(),
});
export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;

// ----------------------------------------------------------------------------------------------- removal / draft

/** `POST /api/projects/:id/delivery/setup/remove-environment` (project owner): takes it out of the DRAFT. Nothing is deleted before a publish and approval. */
export const RemoveEnvironmentRequestSchema = z.object({ env: EnvNameSchema });
export type RemoveEnvironmentRequest = z.infer<typeof RemoveEnvironmentRequestSchema>;
export const RemoveEnvironmentResultSchema = z.object({
  /** What removing it means, in sentences ("The live site was waiting for the test site: that rule is dropped"). */
  impact: z.array(z.string()),
  /** The environment was the last one: use "Stop using guided deploys" instead (422 `last_environment`). */
  lastEnvironment: z.boolean(),
});
export type RemoveEnvironmentResult = z.infer<typeof RemoveEnvironmentResultSchema>;

/** `POST /api/projects/:id/delivery/setup/stop-guided` (project owner): back to instructions mode; targets are kept. */
export const StopGuidedRequestSchema = z.object({ confirm: z.literal(true) });
export type StopGuidedRequest = z.infer<typeof StopGuidedRequestSchema>;

// ------------------------------------------------------------------------------------------ proposals and answers

/** `POST /api/setup-proposals/:id/answers` */
export const ProposalAnswerSchema = z.object({
  /** The question's `path` (JSON pointer). */
  path: z.string().max(300),
  value: z.string().max(500),
});
export type ProposalAnswer = z.infer<typeof ProposalAnswerSchema>;
export const AnswerProposalRequestSchema = z.object({
  answers: z.array(ProposalAnswerSchema).min(1).max(30),
  /**
   * Paths of answers that turn on `sudo` or `adoptFolder`, which the person confirmed in a separate step. An answer that turns
   * one of them on is NOT stored until its path is listed here; the result lists what still needs the confirmation.
   */
  confirmed: z.array(z.string().max(300)).max(10).optional(),
});
export type AnswerProposalRequest = z.infer<typeof AnswerProposalRequestSchema>;
/** An answer that was not stored yet because it turns on administrator rights or the move of a folder. */
export const NeedsConfirmationSchema = z.object({
  path: z.string(),
  kind: z.enum(['sudo', 'adopt_folder']),
  /** What the person is asked to confirm, in plain words. */
  text: z.string(),
});
export type NeedsConfirmation = z.infer<typeof NeedsConfirmationSchema>;
export const SENSITIVE_ANSWER_PATH = /(?:^|\/)(sudo|adoptFolder)$/;

/** The answer of `POST .../use-proposal`: the whole `SetupStateDto` plus what the merge did. */
export const ProposalMergeInfoSchema = z.object({
  /** Environments the proposal added. */
  added: z.array(z.string()),
  /** Environments the proposal replaced (same name). */
  replaced: z.array(z.string()),
  /** Existing environments the proposal does not mention: kept exactly as they were. */
  notCovered: z.array(z.string()),
});
export type ProposalMergeInfo = z.infer<typeof ProposalMergeInfoSchema>;
