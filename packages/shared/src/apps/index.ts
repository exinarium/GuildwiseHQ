import { z } from 'zod';

/**
 * Automated app integrations (a GitHub App first; GitLab, Bitbucket and Azure DevOps bot apps later). An organization
 * Owner registers one installation of one app; the private key stays sealed on the chosen workstations and every token is
 * minted there. These shapes are facts only: none of them can carry a key or a token.
 */

export const APP_PROVIDER_IDS = ['github-app'] as const;
export const AppProviderIdSchema = z.enum(APP_PROVIDER_IDS);
export type AppProviderId = z.infer<typeof AppProviderIdSchema>;

/** The capability a runner announces in `hello` when it can hold app keys and mint app tokens. */
export const APP_INTEGRATIONS_CAPABILITY = 'app-integrations:1';

/** The canonical runner instance of an app integration: one installation of one app. */
export const appInstance = (appId: string, installationId: string): string => `${appId}:${installationId}`;

const ID_RE = /^\d{1,15}$/;

export function parseAppInstance(instance: string): { appId: string; installationId: string } | null {
  const parts = instance.split(':');
  if (parts.length !== 2) return null;
  const [appId, installationId] = parts as [string, string];
  if (!ID_RE.test(appId) || !ID_RE.test(installationId)) return null;
  return { appId, installationId };
}

export const AppPermissionLevelSchema = z.enum(['read', 'write']);
export type AppPermissionLevel = z.infer<typeof AppPermissionLevelSchema>;
export const AppPermissionsSchema = z.record(z.string().regex(/^[a-z_]{1,40}$/), AppPermissionLevelSchema);
export type AppPermissions = z.infer<typeof AppPermissionsSchema>;

/** Least privilege default. `workflows` only when a project opts in. */
export const DEFAULT_APP_PERMISSIONS: Readonly<Record<string, AppPermissionLevel>> = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  metadata: 'read',
};

/** The permission names of `wanted` that `granted` does not give at the needed level. */
export function missingAppPermissions(
  granted: Record<string, string>,
  wanted: Readonly<Record<string, AppPermissionLevel>> = DEFAULT_APP_PERMISSIONS,
): string[] {
  return Object.entries(wanted)
    .filter(([name, level]) => {
      const g = granted[name];
      if (!g) return true;
      return level === 'write' && g !== 'write' && g !== 'admin';
    })
    .map(([name]) => name);
}

/** The non-secret facts a runner returns after a verify. Strict: an unknown key (a token) is a parse failure. */
export const AppIdentitySchema = z
  .object({
    provider: AppProviderIdSchema,
    host: z.string().max(200),
    appId: z.string().max(40),
    appSlug: z.string().max(100),
    appName: z.string().max(200),
    installationId: z.string().max(40),
    account: z.string().max(200),
    accountType: z.string().max(40).optional(),
    repositorySelection: z.enum(['all', 'selected']).optional(),
    botLogin: z.string().max(140),
    botUserId: z.string().max(40),
    commitName: z.string().max(140),
    commitEmail: z.string().max(254),
    permissions: AppPermissionsSchema,
    missingPermissions: z.array(z.string().max(40)).max(20),
  })
  .strict();
export type AppIdentity = z.infer<typeof AppIdentitySchema>;

export const APP_ERROR_CODES = [
  'key_invalid',
  'jwt_rejected',
  'clock_skew',
  'app_not_found',
  'installation_not_found',
  'installation_suspended',
  'choose_installation',
  'permission_missing',
  'token_rejected',
  'repository_not_accessible',
  'rate_limited',
  'unreachable',
  'app_mismatch',
  'runner_too_old',
  'unexpected',
] as const;
export const AppErrorCodeSchema = z.enum(APP_ERROR_CODES);
export type AppErrorCode = z.infer<typeof AppErrorCodeSchema>;

/** One sentence per code. Never a value. */
export const APP_ERROR_TEXT: Record<AppErrorCode, string> = {
  key_invalid: 'The private key could not be read: use the .pem file the app settings page generated (RSA, 2048 bits or more).',
  jwt_rejected: 'GitHub refused the app key or App ID: check both, or generate a new private key.',
  clock_skew: "This workstation's clock is off: fix the system time and try again.",
  app_not_found: 'No app was found for this App ID.',
  installation_not_found: 'The app is not installed there any more.',
  installation_suspended: 'The installation of this app is suspended.',
  choose_installation: 'The app is installed on several accounts: pick one.',
  permission_missing: 'The installation does not grant a permission that was asked for.',
  token_rejected: 'GitHub refused the access token of this app twice in a row.',
  repository_not_accessible: 'The installation has no access to a repository that was asked for.',
  rate_limited: 'GitHub rate-limited this app: it is tried again later.',
  unreachable: 'GitHub could not be reached.',
  app_mismatch: 'This key belongs to another app than the one saved here.',
  runner_too_old: 'The runner on this workstation is too old for automated apps: update it.',
  unexpected: 'GitHub answered in a way the runner did not expect.',
};

export const AppInstallationSchema = z
  .object({
    id: z.string().max(40),
    account: z.string().max(200),
    accountType: z.string().max(40).optional(),
    suspended: z.boolean(),
  })
  .strict();
export type AppInstallation = z.infer<typeof AppInstallationSchema>;

/** `command.result` of app.connect / app.test. Strict. */
export const AppCommandResultSchema = z
  .object({
    ok: z.boolean(),
    instance: z.string().max(200).optional(),
    identity: AppIdentitySchema.optional(),
    code: AppErrorCodeSchema.optional(),
    message: z.string().max(300).optional(),
    installations: z.array(AppInstallationSchema).max(100).optional(),
  })
  .strict();
export type AppCommandResult = z.infer<typeof AppCommandResultSchema>;
