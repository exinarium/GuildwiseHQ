import { z } from 'zod';
import {
  type AppErrorCode,
  AppErrorCodeSchema,
  AppHostSchema,
  type AppProviderId,
  AppProviderIdSchema,
} from '../apps/index.ts';
import { type ForgeKind, ForgeKindSchema } from '../forge/index.ts';
import type { CommitAs } from './commit-identity.ts';

/**
 * "Post as" app selection: a project ticks which organization app integration (a GitHub App first) its shifts act as.
 * Resolution per repository: the selected app covering the repository, else the project's Commit as setting, else the
 * repository/workstation git config. Settings, events and payloads carry only the reference and the public bot
 * identity: never a key or a token.
 */

/** Which forge each app provider posts to. */
export const APP_PROVIDER_FORGE: Record<AppProviderId, ForgeKind> = { 'github-app': 'github' };

/** The owner's words for each provider. */
export const APP_PROVIDER_LABEL: Record<AppProviderId, string> = { 'github-app': 'GitHub App' };

/** The capability a runner announces when it understands `postAs` and `app.access_check`. */
export const POST_AS_CAPABILITY = 'post-as:1';

/** The capability a runner announces when it posts to and reads GitHub issues as the `trackerApp` it is sent. */
export const TRACKER_POST_AS_CAPABILITY = 'tracker-post-as:1';

/** The most apps one project may tick. */
export const MAX_POST_AS_APPS = 8;

/** Only the reference is stored in settings and events. */
export const PostAsAppRefSchema = z.object({ integrationId: z.uuid(), provider: AppProviderIdSchema });
export type PostAsAppRef = z.infer<typeof PostAsAppRefSchema>;

export const SetPostAsRequestSchema = z.object({
  apps: z.array(z.object({ integrationId: z.uuid() })).max(MAX_POST_AS_APPS),
});
export type SetPostAsRequest = z.infer<typeof SetPostAsRequestSchema>;

/** The public identity of the bot (not a secret). `instance` and `host` are what the runner's token broker is keyed by. */
export const PostAsAppIdentitySchema = PostAsAppRefSchema.extend({
  label: z.string().max(80),
  botName: z.string().max(140),
  botEmail: z.string().max(254),
  instance: z.string().max(200),
  host: z.string().max(200),
});
export type PostAsAppIdentity = z.infer<typeof PostAsAppIdentitySchema>;

/** The GitHub App a project posts to and reads GitHub issues as. Only its public identity, never a key or token. */
export const TrackerAppSchema = PostAsAppIdentitySchema;
export type TrackerApp = PostAsAppIdentity;

export const POST_AS_FALLBACK_REASONS = ['no_app_for_forge', 'not_covered', 'app_removed'] as const;
export const PostAsFallbackReasonSchema = z.enum(POST_AS_FALLBACK_REASONS);
export type PostAsFallbackReason = z.infer<typeof PostAsFallbackReasonSchema>;

export const POST_AS_SOURCES = ['app', 'project', 'repo'] as const;

/** Resolved per repository by the server. The runner obeys `source`; 'repo' = the runner reads git config as today. */
export const PostAsRepoSchema = z.object({
  repoId: z.uuid(),
  remoteUrlNormalized: z.string().min(1).max(500),
  source: z.enum(POST_AS_SOURCES),
  /** Present iff source === 'app'. */
  app: PostAsAppIdentitySchema.optional(),
  fallbackReason: PostAsFallbackReasonSchema.optional(),
});
export type PostAsRepo = z.infer<typeof PostAsRepoSchema>;

/** Sent next to `commitAs` on every payload; absent when the project has no app selected. */
export const PostAsPlanSchema = z.object({ repos: z.array(PostAsRepoSchema).max(200) });
export type PostAsPlan = z.infer<typeof PostAsPlanSchema>;

/** Prefix of a shift rejection / command error when a selected app cannot be used. */
export const APP_IDENTITY_FAILED_CODE = 'app_identity_failed';

export type PostAsAccessState = 'covered' | 'not_covered' | 'error';

/** One selected app as the resolver sees it: `identity` null or `removed` = the integration is gone. */
export interface SelectedAppState {
  ref: PostAsAppRef;
  identity: PostAsAppIdentity | null;
  removed: boolean;
}

/**
 * THE resolver: the panel and every dispatch payload use it, so the owner sees what the shift does.
 * Unknown or errored coverage resolves to the app (fail closed): the fallback is used only when a check recorded
 * `not_covered`, the app was removed, or no selected app serves the repository's forge.
 */
export function resolvePostAsRepo(i: {
  repo: { repoId: string; remoteUrlNormalized: string; forge: ForgeKind };
  selected: ReadonlyArray<SelectedAppState>;
  access: (integrationId: string, repoId: string) => PostAsAccessState | null;
  commitAs: CommitAs | null;
}): PostAsRepo {
  const base = { repoId: i.repo.repoId, remoteUrlNormalized: i.repo.remoteUrlNormalized };
  const fallback = (reason?: PostAsFallbackReason): PostAsRepo => ({
    ...base,
    source: i.commitAs ? 'project' : 'repo',
    ...(reason ? { fallbackReason: reason } : {}),
  });
  const app = i.selected.find((s) => APP_PROVIDER_FORGE[s.ref.provider] === i.repo.forge);
  if (!app) return fallback(i.selected.length ? 'no_app_for_forge' : undefined);
  if (app.removed || !app.identity) return fallback('app_removed');
  if (i.access(app.ref.integrationId, i.repo.repoId) === 'not_covered') return fallback('not_covered');
  return { ...base, source: 'app', app: app.identity };
}

/** The resolved entry for one repository of a plan, by its normalized remote URL. */
export function postAsFor(
  plan: PostAsPlan | null | undefined,
  remoteUrlNormalized: string | null | undefined,
): PostAsRepo | null {
  if (!plan || !remoteUrlNormalized) return null;
  return plan.repos.find((r) => r.remoteUrlNormalized === remoteUrlNormalized) ?? null;
}

// ------------------------------------------------------------------------------------------- app.access_check

export const AppAccessCheckPayloadSchema = z.object({
  projectId: z.uuid(),
  integrationId: z.uuid(),
  instance: z.string().max(200),
  host: AppHostSchema,
  repos: z.array(z.object({ repoId: z.uuid(), remoteUrlNormalized: z.string().min(1).max(500) })).max(200),
});
export type AppAccessCheckPayload = z.infer<typeof AppAccessCheckPayloadSchema>;

export const AppAccessCheckResultSchema = z
  .object({
    repos: z
      .array(
        z
          .object({
            repoId: z.uuid(),
            state: z.enum(['covered', 'not_covered', 'error']),
            code: AppErrorCodeSchema.optional(),
            detail: z.string().max(400).optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type AppAccessCheckResult = z.infer<typeof AppAccessCheckResultSchema>;
export type { AppErrorCode };

// ------------------------------------------------------------------------------------------- settings response

export const POST_AS_APP_STATES = ['connected', 'not_connected', 'error', 'removed'] as const;

export const PostAsAppOptionSchema = PostAsAppIdentitySchema.extend({
  state: z.enum(POST_AS_APP_STATES),
  detail: z.string().max(400).optional(),
});
export type PostAsAppOption = z.infer<typeof PostAsAppOptionSchema>;

export const PostAsSettingsSchema = z.object({
  selected: z.array(PostAsAppOptionSchema),
  /** Active org apps a manager can tick. */
  available: z.array(PostAsAppOptionSchema),
  canSelect: z.boolean(),
  lastChange: z.object({ by: z.string().max(200), at: z.iso.datetime({ offset: true }) }).nullable(),
});
export type PostAsSettings = z.infer<typeof PostAsSettingsSchema>;

export const PostAsRepoRowSchema = z.object({
  repoId: z.uuid(),
  repoName: z.string(),
  forge: ForgeKindSchema,
  resolved: PostAsRepoSchema,
  access: z
    .object({
      state: z.enum(['covered', 'not_covered', 'error']),
      detail: z.string().max(400).optional(),
      checkedAt: z.iso.datetime({ offset: true }),
    })
    .nullable(),
});
export type PostAsRepoRow = z.infer<typeof PostAsRepoRowSchema>;

/** The message when a second app of one provider is ticked. */
export const oneAppPerProviderMessage = (provider: AppProviderId, otherLabel: string): string =>
  `A project can post as one ${APP_PROVIDER_LABEL[provider]} only; untick ${otherLabel} first`;
