import { z } from 'zod';

/**
 * Security hardening contracts (1.10.0): the shared names, enums and API shapes that the server, the web app, the runner
 * and the hosted extension agree on. Behaviour lives in the server (`auth/*`) and the runner (`policy/*`).
 */

// ---------------------------------------------------------------- sessions (R4, R5)

/** How a session was started (`auth_sessions.method`, `SessionStarted.method`). */
export const SESSION_METHODS = [
  'password',
  'password_totp',
  'password_recovery',
  'invitation',
  'email_verification',
  'demo',
] as const;
export const SessionMethodSchema = z.enum(SESSION_METHODS);
export type SessionMethod = z.infer<typeof SessionMethodSchema>;

/**
 * Only a sign-in that proved the password (and the second factor, when the account has one) makes the session fresh for
 * step-up (`auth_sessions.second_factor_at`). Invitation, email verification and demo sessions never do [rv 9].
 */
export const sessionMethodProvesFactor = (m: SessionMethod): boolean => m.startsWith('password');

// ---------------------------------------------------------------- sign-in protection (R2)

/** `login_failures.reason`. `locked` and `blocked` are refusals; `cleared` ends an account lock (reset, CLI). */
export const LOGIN_FAILURE_REASONS = [
  'password',
  'second_factor',
  'step_up',
  'reset_second_factor',
  'blocked',
  'locked',
  'cleared',
] as const;
export const LoginFailureReasonSchema = z.enum(LOGIN_FAILURE_REASONS);
export type LoginFailureReason = z.infer<typeof LoginFailureReasonSchema>;

/** 429 body detail of a lock: `too_many_attempts {retryAfterSec}`. */
export const TOO_MANY_ATTEMPTS = 'too_many_attempts';

// ---------------------------------------------------------------- address policy (R1)

/** Where an address is screened (`screenAddress`). */
export const SCREEN_PURPOSES = ['signup', 'signup_resend', 'invite', 'login', 'password_reset'] as const;
export const ScreenPurposeSchema = z.enum(SCREEN_PURPOSES);
export type ScreenPurpose = z.infer<typeof ScreenPurposeSchema>;

/** `platform_blocklist.kind`: `domain` matches subdomains too; `allow_domain` skips the extensions' screening. */
export const BLOCK_KINDS = ['domain', 'email', 'ip', 'allow_domain'] as const;
export const BlockKindSchema = z.enum(BLOCK_KINDS);
export type BlockKind = z.infer<typeof BlockKindSchema>;

/** Error codes of a screened address: an invite gives 400, a blocked IP 403 (login stays the uniform 401). */
export const EMAIL_NOT_ACCEPTED = 'email_not_accepted';
export const REQUEST_REFUSED = 'request_refused';

/** One entry of the owner's block list (`GET /api/platform/blocklist`). */
export const PlatformBlockEntrySchema = z.object({
  id: z.string(),
  kind: BlockKindSchema,
  value: z.string(),
  note: z.string(),
  createdBy: z.object({ id: z.string(), displayName: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
});
export type PlatformBlockEntry = z.infer<typeof PlatformBlockEntrySchema>;
export const PlatformBlocklistResponseSchema = z.object({ entries: z.array(PlatformBlockEntrySchema) });
export type PlatformBlocklistResponse = z.infer<typeof PlatformBlocklistResponseSchema>;
/** `POST /api/platform/blocklist`: the server normalizes `value` (400 `invalid_block_value`); a repeat is 409 `block_exists`. */
export const AddPlatformBlockRequestSchema = z.object({
  kind: BlockKindSchema,
  value: z.string().trim().min(1).max(320),
  note: z.string().trim().max(500).optional(),
});
export type AddPlatformBlockRequest = z.infer<typeof AddPlatformBlockRequestSchema>;

// ---------------------------------------------------------------- members and invitations (R6, R8, R10)

/** 409 of an admin password or two-factor reset whose target has access in another organization (R6, audit F1). */
export const MEMBER_HAS_OTHER_ACCESS = 'member_has_other_access';
/** 429 of an invitation over the per-organization hourly or the per-actor daily limit, and of a fourth resend in an hour (R10). */
export const INVITE_LIMIT = 'invite_limit';
/** 409 of an invitation while the organization has the maximum number of pending invitations (R10). */
export const PENDING_INVITATIONS_CAP = 'pending_invitations_cap';

// ---------------------------------------------------------------- step-up, "Confirm it's you" (R5)

/** 403 code of a guarded route whose session is not fresh; `details.method` says what the dialog asks for. */
export const STEP_UP_REQUIRED = 'step_up_required';
export const StepUpMethodSchema = z.enum(['totp', 'password']);
export type StepUpMethod = z.infer<typeof StepUpMethodSchema>;
export const StepUpRequiredDetailsSchema = z.object({ method: StepUpMethodSchema });
export type StepUpRequiredDetails = z.infer<typeof StepUpRequiredDetailsSchema>;

/**
 * `POST /api/auth/step-up`: a 6-digit code (or a recovery code) for accounts with two-factor login, the password for
 * accounts without (D1). Exactly one of the two.
 */
export const StepUpRequestSchema = z.union([
  z.object({ code: z.string().trim().min(6).max(32) }).strict(),
  z.object({ password: z.string().min(1).max(200) }).strict(),
]);
export type StepUpRequest = z.infer<typeof StepUpRequestSchema>;
export const StepUpResponseSchema = z.object({ ok: z.literal(true), freshUntil: z.iso.datetime() });
export type StepUpResponse = z.infer<typeof StepUpResponseSchema>;

/** The defaults and production ceilings of the two windows (`AOM_STEP_UP_WINDOW_SEC`, `AOM_SUPER_ADMIN_IDLE_SEC`). */
export const STEP_UP_WINDOW_DEFAULT_SEC = 600;
export const SUPER_ADMIN_IDLE_DEFAULT_SEC = 1800;
/** Wrong step-up answers that end the session. */
export const STEP_UP_MAX_FAILURES = 5;

// ---------------------------------------------------------------- security settings (R27, R28)

export const SECURITY_SETTING_KEYS = ['requireSignedRunners', 'enforceTwoFactor'] as const;
export const SecuritySettingKeySchema = z.enum(SECURITY_SETTING_KEYS);
export type SecuritySettingKey = z.infer<typeof SecuritySettingKeySchema>;

/** Where the effective value comes from: the extension lock, the platform setting, the env default, else off. */
export const SecuritySettingSourceSchema = z.enum(['locked', 'platform', 'env', 'default']);
export type SecuritySettingSource = z.infer<typeof SecuritySettingSourceSchema>;

/**
 * The hosted build's lock (`ServerExtension.lockedSecuritySettings`): only `true` is accepted, so a lock can only make
 * an install stricter.
 */
export type LockedSecuritySettings = { [K in SecuritySettingKey]?: true };

export const SecuritySettingStateSchema = z.object({
  value: z.boolean(),
  locked: z.boolean(),
  source: SecuritySettingSourceSchema,
});
export type SecuritySettingState = z.infer<typeof SecuritySettingStateSchema>;

/** `GET /api/platform/security-settings`. */
export const SecuritySettingsResponseSchema = z.object({
  requireSignedRunners: SecuritySettingStateSchema,
  enforceTwoFactor: SecuritySettingStateSchema,
  /** Active workstations without a valid signed-release proof (turning signed runners on unlinks them). */
  unsignedWorkstations: z.number().int().nonnegative(),
  /** Active accounts without two-factor login (turning enforcement on sends them through enrolment). */
  usersWithout2fa: z.number().int().nonnegative(),
});
export type SecuritySettingsResponse = z.infer<typeof SecuritySettingsResponseSchema>;

/** `PATCH /api/platform/security-settings` (super admin, step-up). */
export const PatchSecuritySettingsRequestSchema = z
  .object({
    requireSignedRunners: z.boolean().optional(),
    enforceTwoFactor: z.boolean().optional(),
    /** Required to turn signed runners on while `unsignedWorkstations > 0`: those workstations are unlinked. */
    confirmUnlink: z.boolean().optional(),
  })
  .strict();
export type PatchSecuritySettingsRequest = z.infer<typeof PatchSecuritySettingsRequestSchema>;

/** 409 of a PATCH on a locked key; 409 of turning signed runners on without `confirmUnlink`. */
export const SETTING_LOCKED = 'setting_locked';
export const CONFIRM_UNLINK_REQUIRED = 'confirm_unlink_required';

// ---------------------------------------------------------------- signed runner releases (R18-U, R21, R27)

/**
 * `release/manifest.json` (written by `scripts/package-runner.sh`, signed with minisign by the key holder). The signature
 * covers the file's bytes, so the proof below carries the raw text, never a re-serialized object.
 */
export const RunnerReleaseManifestSchema = z.object({
  version: z.string().min(1).max(40),
  file: z.string().min(1).max(200),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Oldest runner that may update to this release. */
  minRunner: z.string().min(1).max(40),
  /** `MIN_TRUSTED_RUNNER` of this release: nothing below it is ever installed, pinned or rolled back to. */
  floor: z.string().min(1).max(40),
  allowDowngrade: z.literal(false),
  /** The pinned Node build the installer copies for the root-owned admin tools, per platform-arch [rv7-12]. */
  nodeRuntime: z
    .record(z.string().max(40), z.object({ url: z.url(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
    .default({}),
  /** The pinned rootless Docker binaries (docker, rootless extras, compose) per Linux platform (deps-without-sudo §3). */
  dockerRootless: z
    .record(
      z.string().max(40),
      z.record(z.string().max(20), z.object({ url: z.url(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
    )
    .optional(),
});
export type RunnerReleaseManifest = z.infer<typeof RunnerReleaseManifestSchema>;

/** Largest manifest and signature accepted on the wire. */
export const RELEASE_MANIFEST_MAX_BYTES = 16_384;
export const RELEASE_MINISIG_MAX_BYTES = 2_048;

/**
 * The signed-release proof a runner sends at pairing (`POST /api/runner/pair` `release`) and in every `hello`
 * (`hello.release`): the installer-kept `manifest.json` (raw text) and `manifest.json.minisig`. The server verifies it with
 * its trusted key and stores `workstations.release_signed` / `release_key_id`. It cannot attest the code a machine runs
 * (Q10); the runner's own update check is the protection.
 */
export const SignedReleaseProofSchema = z.object({
  manifest: z.string().min(2).max(RELEASE_MANIFEST_MAX_BYTES),
  minisig: z.string().min(10).max(RELEASE_MINISIG_MAX_BYTES),
});
export type SignedReleaseProof = z.infer<typeof SignedReleaseProofSchema>;

/** `WorkstationPaired.release`: what the server verified at pairing (`keyId` null: unsigned, accepted with the setting off). */
export const WorkstationReleaseSchema = z.object({
  version: z.string().min(1).max(40),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  keyId: z
    .string()
    .regex(/^[0-9A-F]{16}$/)
    .nullable(),
});
export type WorkstationRelease = z.infer<typeof WorkstationReleaseSchema>;

/** Refusals while "Only signed runners" is on: 403 at pairing, WebSocket close 4403 for `hello`, 410 on legacy paths. */
export const SIGNED_RUNNER_REQUIRED = 'signed_runner_required';
export const SIGNED_RUNNER_CLOSE_CODE = 4403;
export const REINSTALL_REQUIRED = 'reinstall_required';

// ---------------------------------------------------------------- release signing per deploy target (R30)

/** `deploy_targets.signing` / `DeployTargetSigningSet.signing`. */
export const DeployTargetSigningSchema = z.object({
  required: z.boolean(),
  /** minisign key id, 16 upper-case hex characters (e.g. `515674AC008F1CF3`). */
  keyId: z.string().regex(/^[0-9A-F]{16}$/),
  /** The minisign public key line (base64 of 42 bytes, starting `RW`). Never a secret key. */
  publicKey: z.string().regex(/^RW[A-Za-z0-9+/]{54}$/),
  /** The file the deploy produces that must carry the signature, relative to the repository. */
  artefact: z.string().min(1).max(200).default('release/manifest.json'),
});
export type DeployTargetSigning = z.infer<typeof DeployTargetSigningSchema>;
export const RELEASE_SIGNATURE_SOURCES = ['workstation', 'upload'] as const;
export const ReleaseSignatureSourceSchema = z.enum(RELEASE_SIGNATURE_SOURCES);
export type ReleaseSignatureSource = z.infer<typeof ReleaseSignatureSourceSchema>;
/** 409 of a deploy to a target with `signing.required` before a signature for that release's artefact exists. */
export const RUNNER_SIGNATURE_REQUIRED = 'runner_signature_required';

// ---------------------------------------------------------------- passkey approvals (R22)

/** COSE algorithm ids the runner verifies with `node:crypto`: ES256, EdDSA, RS256. */
export const PASSKEY_ALGS = [-7, -8, -257] as const;
export const PasskeyAlgSchema = z.union([z.literal(-7), z.literal(-8), z.literal(-257)]);
/**
 * The only held kinds a passkey may approve (the runner hard-codes the same list in `policy/passkey-kinds.ts`):
 * a deploy whose whole-command pin equals an approved pin except the commit, and a recipe write.
 */
export const PASSKEY_APPROVABLE_KINDS = ['deploy.commit_redeploy', 'recipe.write'] as const;
/** How long a passkey challenge published by the runner stays valid. */
export const PASSKEY_CHALLENGE_TTL_SEC = 300;

// ---------------------------------------------------------------- the official release key (generated)

export { OFFICIAL_RUNNER_RELEASE_KEY_ID, OFFICIAL_RUNNER_RELEASE_PUBKEY } from './release-key.ts';
export const RELEASE_KEY_PLACEHOLDER = 'PLACEHOLDER';
/** True while the official key is still the placeholder: `official` builds and signed-release checks must refuse. */
export const isPlaceholderReleaseKey = (key: string): boolean => key.trim() === RELEASE_KEY_PLACEHOLDER;

/**
 * Parses a minisign public key line (`RW` + base64 of 42 bytes: `Ed`, the 8-byte key id, the 32-byte Ed25519 key).
 * Returns the key id as minisign prints it (16 upper-case hex characters, little-endian) and the raw key bytes, or null
 * for anything else (a secret key, the placeholder, a typo).
 */
export function parseMinisignPublicKey(line: string): { keyId: string; publicKey: Uint8Array } | null {
  const v = line.trim();
  if (!/^RW[A-Za-z0-9+/]{54}$/.test(v)) return null;
  const bin = atob(v);
  if (bin.length !== 42 || bin.charCodeAt(0) !== 0x45 || bin.charCodeAt(1) !== 0x64) return null;
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const id = Array.from(bytes.slice(2, 10))
    .reverse()
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return { keyId: id, publicKey: bytes.slice(10) };
}
