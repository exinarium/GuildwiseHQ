import { z } from 'zod';
import {
  LOCAL_STEP_KINDS,
  localCliOk,
  localCommandOk,
  PASSKEY_APPROVABLE_KINDS,
  PasskeyAlgSchema,
  urlHasPassword,
} from '../security/index.ts';

/**
 * Runner protocol pieces of the 1.10.0 hardening (R18-S, R22, R30). Fixed here so the runner (W8) and the server (W12,
 * W13, W14) build against the same shapes. The runner is the authority: the server relays, it never approves.
 */

const B64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const KeyId = z.string().regex(/^[0-9A-F]{16}$/);
/** A copy-paste command; anything outside the shared grammar is dropped to undefined [S3]. */
const LocalCommandField = z.string().max(900).refine(localCommandOk).optional().catch(undefined);

// ---------------------------------------------------------------- held items (runner -> server)

/**
 * A command or request the runner holds until a local `guildwise-runner approve <id>` (or, for the passkey kinds only,
 * a passkey assertion). `kind` is the runner's name for it (`deploy.exec`, `deploy.commit_redeploy`, `recipe.write`,
 * `vault.configure`, `env.secret`, `provider.reseal`, `devops.task`, `devops.request`, `sudo`, `release.sign`, ...).
 */
export const HeldItemSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.string().min(1).max(60),
  /** The server command this item holds, when it came from one. */
  commandId: z.string().max(80).optional(),
  /** What the runner shows: a one-line summary of the command as it received it (never a secret value). */
  summary: z.string().max(500),
  /** sha256 hex of the canonical command (the deploy pin hash for deploys). */
  commandHash: Sha256Hex,
  createdAt: z.iso.datetime(),
  /** Held commands expire after 24 h. */
  expiresAt: z.iso.datetime(),
  /**
   * Present only for a passkey-approvable kind with a trusted passkey: the WebAuthn challenge
   * `base64url(sha256(commandHash || nonce || expiry))`, valid `PASSKEY_CHALLENGE_TTL_SEC`.
   */
  passkey: z
    .object({
      challenge: B64Url.max(128),
      nonce: B64Url.max(64),
      expiresAt: z.iso.datetime(),
      /** Credential ids (base64url) of the passkeys this runner trusts locally, for `allowCredentials`. */
      credentialIds: z.array(B64Url.max(1024)).max(20),
    })
    .optional(),
  /**
   * easy-runner-setup: the exact copy-paste command that approves it on the machine (`<cli> approve <id>`), rendered by
   * the runner. Dropped (not refused) when it fails the shared grammar, so the item itself still arrives.
   */
  command: LocalCommandField,
  /** The shift this item belongs to, so the card that waits can show the command. */
  shiftId: z.uuid().optional().catch(undefined),
});
export type HeldItem = z.infer<typeof HeldItemSchema>;

/** A local step that is not a held item (a DevOps grant, install scripts, setup, ...): what to paste on the machine. */
export const LocalStepSchema = z.object({
  /** Stable per step (`devops.grant:<org>`), so the notice is replaced, not duplicated. */
  key: z.string().min(1).max(200),
  kind: z.enum(LOCAL_STEP_KINDS),
  summary: z.string().max(300),
  command: z.string().max(900).refine(localCommandOk, 'not a local command'),
  shiftId: z.uuid().optional().catch(undefined),
});
export type LocalStep = z.infer<typeof LocalStepSchema>;

/**
 * Runner -> server: the full list of items held right now (replaces the previous list; not acked). `steps` (additive):
 * the local steps waiting on the machine; an invalid step is dropped, never the whole message.
 */
export const ApprovalsHeldPayloadSchema = z.object({
  items: z.array(HeldItemSchema).max(200),
  steps: z
    .array(z.unknown())
    .max(100)
    .optional()
    .transform((v) =>
      v === undefined
        ? undefined
        : v.flatMap((s) => {
            const r = LocalStepSchema.safeParse(s);
            return r.success ? [r.data] : [];
          }),
    ),
});
export type ApprovalsHeldPayload = z.infer<typeof ApprovalsHeldPayloadSchema>;

// ---------------------------------------------------------------- setup offers (server -> runner, easy-runner-setup)

/** A name from the server shown in a terminal or page: plain text, no control characters (ANSI escapes included) [S2]. */
export const PlainNameSchema = z
  .string()
  .regex(/^[^\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]{1,200}$/u, 'no control characters');

/**
 * What the server offers for the installer's one screen (`guildwise-runner setup`): the organisations this workstation
 * works for, the role the server says the user has, its DevOps helper here, and the repositories of their projects. The
 * runner writes it to `setup-offers.json`; nothing in it is granted without a local yes (every item defaults to No).
 */
export const SetupOffersWireSchema = z.object({
  orgs: z
    .array(
      z.object({
        orgId: z.uuid(),
        orgName: PlainNameSchema,
        role: z.string().regex(/^[^\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]{1,40}$/u),
        devopsAgentId: z.uuid().optional(),
        devopsAgentName: PlainNameSchema.optional(),
      }),
    )
    .max(500),
  repos: z
    .array(
      z.object({
        url: z
          .string()
          .min(1)
          .max(500)
          .regex(/^[^\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\s]+$/u)
          // never a password in an address the runner stores or shows (zero known vulnerabilities)
          .refine((u) => !urlHasPassword(u), 'an address with a password'),
        name: PlainNameSchema,
      }),
    )
    .max(500)
    .default([]),
});
export type SetupOffersWire = z.infer<typeof SetupOffersWireSchema>;

/** `hello.local` (additive): how this runner's local commands start, and its approvals page port or why it did not start. */
export const HelloLocalSchema = z.object({
  cli: z.string().max(400).refine(localCliOk, 'not a local CLI'),
  windowPort: z.number().int().min(1024).max(65535).optional(),
  windowError: z.string().max(200).optional(),
});
export type HelloLocal = z.infer<typeof HelloLocalSchema>;

// ---------------------------------------------------------------- passkeys (server -> runner commands, R22)

/**
 * Command `passkey.offer`: a passkey registered on the workstation page. The runner keeps it pending; only
 * `guildwise-runner passkey trust` on the machine makes it trusted (`policy.json` `passkeys[]`).
 */
export const PasskeyOfferPayloadSchema = z.object({
  passkeyId: z.uuid(),
  credentialId: B64Url.max(1024),
  /** SPKI, base64. */
  publicKey: z.string().min(1).max(4096),
  alg: PasskeyAlgSchema,
  name: z.string().min(1).max(80),
  /** Authenticator model id (shown at `passkey trust`), when the registration carried one. */
  aaguid: z.string().max(64).optional(),
  createdAt: z.iso.datetime(),
  /** The WebAuthn relying party id (the server host) and origin the registration was made for. */
  rpId: z.string().min(1).max(253),
  origin: z.url(),
});
export type PasskeyOfferPayload = z.infer<typeof PasskeyOfferPayloadSchema>;

/** Command `passkey.withdraw`: the passkey was removed on the server; a pending offer is dropped (a trusted one stays until `passkey remove`). */
export const PasskeyWithdrawPayloadSchema = z.object({ passkeyId: z.uuid(), credentialId: B64Url.max(1024) });

/**
 * Command `approval.passkey`: the server relays a WebAuthn assertion for a held item. The runner checks the trusted
 * credential, the signature over `authenticatorData || sha256(clientDataJSON)`, `type` `webauthn.get`, the challenge,
 * the pinned origin, the rpIdHash, the UV flag, the sign count, the unused nonce and the kind; otherwise the item stays held.
 */
export const ApprovalPasskeyPayloadSchema = z.object({
  itemId: z.string().min(1).max(64),
  credentialId: B64Url.max(1024),
  authenticatorData: B64Url.max(4096),
  clientDataJSON: B64Url.max(8192),
  signature: B64Url.max(2048),
  userHandle: B64Url.max(512).optional(),
});
export type ApprovalPasskeyPayload = z.infer<typeof ApprovalPasskeyPayloadSchema>;

/** The kinds a passkey may approve, as a schema (the runner's own hard-coded list is the authority). */
export const PasskeyApprovableKindSchema = z.enum(PASSKEY_APPROVABLE_KINDS);

// ---------------------------------------------------------------- release signing (R30)

/**
 * Command `release.sign`: sign a release artefact with a key this workstation holds (`policy.json` `signingKeys[]`). Always
 * a held item unless the key has a local `autoSign`; the approve prompt shows release, target, version, artefact sha256
 * and key id. The runner signs with `minisign -S -s <keyFile> -m <artefact> -t "<project> <version> <target>"` and
 * returns only the signature.
 */
export const ReleaseSignPayloadSchema = z.object({
  releaseId: z.uuid(),
  targetId: z.uuid(),
  targetName: z.string().min(1).max(80),
  projectName: z.string().min(1).max(120),
  version: z.string().min(1).max(40),
  keyId: KeyId,
  /** The artefact on the workstation, relative to the repository (`release/<target>/manifest.json`). */
  artefact: z.string().min(1).max(300),
  repoId: z.uuid(),
  /** What the server expects the file on disk to hash to (from `ReleaseArtefactPrepared`); the runner refuses a mismatch. */
  artefactSha256: Sha256Hex,
});
export type ReleaseSignPayload = z.infer<typeof ReleaseSignPayloadSchema>;
/** `command.result.result` of a `release.sign`. */
export const ReleaseSignResultSchema = z.object({
  keyId: KeyId,
  artefactSha256: Sha256Hex,
  minisig: z.string().min(10).max(2048),
});
export type ReleaseSignResult = z.infer<typeof ReleaseSignResultSchema>;

/** Runner -> server (acked): the deploy's package step produced the artefact for a target (`ReleaseArtefactPrepared`). */
export const ReleaseArtefactPreparedPayloadSchema = z.object({
  releaseId: z.uuid(),
  targetId: z.uuid(),
  artefactSha256: Sha256Hex,
  version: z.string().min(1).max(40),
  /**
   * W14 addition: the artefact's raw text (`manifest.json`, public data). The server needs the bytes to verify a minisign
   * signature (it covers the file, not its sha256) and to offer "Download manifest.json" for offline signing. Optional on
   * the wire; the server refuses to record a prepared artefact without it.
   */
  manifest: z.string().min(2).max(16_384).optional(),
});

/**
 * Command `release.prepare` (W14 addition): run the project's package step for one deploy target on this workstation's
 * own clone, at the release commit, with the target's PUBLIC key (`scripts/package-runner.sh --pubkey <publicKey> --out
 * <dir of artefact>`), then report `release.artefact.prepared` (with the manifest text). The tgz stays on the workstation;
 * a later `deploy.exec` for that target finds the artefact on disk and verifies its signature before the rest of the recipe.
 */
export const ReleasePreparePayloadSchema = z.object({
  releaseId: z.uuid(),
  targetId: z.uuid(),
  targetName: z.string().min(1).max(80),
  projectName: z.string().min(1).max(120),
  version: z.string().min(1).max(40),
  repoId: z.uuid(),
  /** The repository's normalised remote URL (as `deploy.exec` and other runner payloads carry it), so the runner finds its clone. */
  remoteUrlNormalized: z.string().max(500).optional(),
  /** The release commit to package. */
  commit: z.string().min(7).max(64),
  keyId: KeyId,
  /** The target's minisign public key line (`RW...`): embedded in the packaged runner. Never a secret key. */
  publicKey: z.string().regex(/^RW[A-Za-z0-9+/]{54}$/),
  /** Where the artefact lands, relative to the repository (`release/<target>/manifest.json`). */
  artefact: z.string().min(1).max(300),
  /** Set when the owner packages a signed release kept for rollback again (its workstation lost the files). */
  repackage: z.literal(true).optional(),
});
export type ReleasePreparePayload = z.infer<typeof ReleasePreparePayloadSchema>;
