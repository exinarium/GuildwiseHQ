import { z } from 'zod';
import { SealedEnvelopeSchema } from '../integrations/schema.ts';

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
  key_invalid:
    'The private key could not be read: use the .pem file the app settings page generated (RSA, 2048 bits or more).',
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

// ------------------------------------------------------------------------------------------- runner commands

/** Numeric App ID or a client ID (`Iv1.…`, `Iv23…`). */
export const AppRefSchema = z.string().regex(/^(\d{1,12}|Iv[0-9A-Za-z.]{4,40})$/);
export const AppInstallationIdSchema = z.string().regex(/^\d{1,15}$/);
export const AppHostSchema = z
  .string()
  .max(200)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/i);

const AppRefPairSchema = z.object({
  orgId: z.string().min(1).max(80),
  integrationId: z.string().min(1).max(80),
});

/**
 * `app.connect`: the envelope seals `{ privateKey }` for kind `github-app`, op `connect`, instance = the instance as
 * entered (`appRef` or `appRef:installationId`) and ref = the share's `ref`.
 */
export const AppConnectPayloadSchema = z.object({
  requestId: z.string().min(1).max(64),
  orgId: z.string().min(1).max(80),
  integrationId: z.string().min(1).max(80).optional(),
  provider: AppProviderIdSchema,
  host: AppHostSchema,
  appRef: AppRefSchema,
  installationId: AppInstallationIdSchema.optional(),
  /** Replacing the key of a registered integration: a key for another app or installation is `app_mismatch`. */
  expect: z.string().max(200).optional(),
  ref: z.string().min(1).max(64),
  /** Opaque sealed envelope (`SealedEnvelopeSchema`); checked by the runner. */
  envelope: SealedEnvelopeSchema,
});
export type AppConnectPayload = z.infer<typeof AppConnectPayloadSchema>;

export const AppTestPayloadSchema = z.object({
  requestId: z.string().min(1).max(64),
  instance: z.string().max(200),
});
export const AppAdoptPayloadSchema = AppRefPairSchema.extend({
  requestId: z.string().min(1).max(64),
  instance: z.string().max(200),
});
export const AppRemovePayloadSchema = AppRefPairSchema.extend({ instance: z.string().max(200) });
/** After every `welcome`: the apps the server still has for these organizations; other refs of theirs are dropped. */
export const AppSyncPayloadSchema = z.object({
  orgIds: z.array(z.string().min(1).max(80)).max(200),
  apps: z.array(AppRefPairSchema.extend({ instance: z.string().max(200) })).max(1000),
});

// ------------------------------------------------------------------------------------------------- org API

export const ORG_APP_REQUEST_STATES = ['pending', 'needs_choice', 'done', 'failed', 'expired'] as const;
export type OrgAppRequestState = (typeof ORG_APP_REQUEST_STATES)[number];

export interface OrgAppWorkstationDto {
  id: string;
  name: string;
  ownerName: string;
  state: 'connected' | 'error' | 'pending' | 'missing';
  refreshedAt?: string;
  errorCode?: string;
  message?: string;
  checkedAt?: string;
}

export interface OrgAppDto {
  id: string;
  provider: AppProviderId;
  label: string;
  host: string;
  appId: string;
  appSlug: string;
  appName: string;
  installationId: string;
  account: string;
  botLogin: string;
  commitName: string;
  commitEmail: string;
  permissions: AppPermissions;
  missingPermissions: string[];
  createdAt: string;
  state: 'connected' | 'error' | 'pending';
  /** Owner only. */
  workstations?: OrgAppWorkstationDto[];
}

export interface OrgAppTargetDto {
  id: string;
  name: string;
  ownerName: string;
  keyId: string;
  publicKey: string;
  online: boolean;
  supported: boolean;
}

export interface OrgAppsResponse {
  apps: OrgAppDto[];
  canManage: boolean;
  targets?: OrgAppTargetDto[];
  serverTime: string;
}

export const OrgAppShareSchema = z
  .object({
    workstationId: z.uuid(),
    ref: z.string().min(8).max(64),
    keyId: z.string().min(1).max(200),
    envelope: SealedEnvelopeSchema,
  })
  .strict();
export type OrgAppShare = z.infer<typeof OrgAppShareSchema>;

export const AddOrgAppRequestSchema = z
  .object({
    requestId: z.uuid(),
    provider: AppProviderIdSchema,
    label: z.string().trim().min(1).max(80),
    host: AppHostSchema.default('github.com'),
    appRef: AppRefSchema,
    installationId: AppInstallationIdSchema.optional(),
    shares: z.array(OrgAppShareSchema).min(1).max(50),
  })
  .strict();
export type AddOrgAppRequest = z.infer<typeof AddOrgAppRequestSchema>;

export const ShareOrgAppRequestSchema = z
  .object({ requestId: z.uuid(), shares: z.array(OrgAppShareSchema).min(1).max(50) })
  .strict();
export const RenameOrgAppRequestSchema = z.object({ label: z.string().trim().min(1).max(80) }).strict();

export interface OrgAppRequestDto {
  id: string;
  state: OrgAppRequestState;
  integrationId?: string;
  identity?: AppIdentity;
  installations?: AppInstallation[];
  results: Array<{ workstationId: string; ok?: boolean; code?: string; message?: string }>;
}

/** A raw request body that holds a PEM in the clear is refused before it is parsed or logged. */
export const containsPlaintextKey = (raw: string): boolean => /PRIVATE KEY-----/.test(raw);
