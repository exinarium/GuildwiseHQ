import { z } from 'zod';
import { DeployTargetSigningSchema, ReleaseSignatureSourceSchema } from '../security/index.ts';

/**
 * Release signing per deploy target (R30): the API of `routes/release-signing.ts` and the release sheet. A target with
 * `signing.required` deploys only a shipped release whose runner artefact, packaged for that target with its public key,
 * carries a minisign signature by that target's key. The secret key never reaches the server: a signature is made on the
 * workstation holding the key (under a local approval) or offline and uploaded.
 */

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const KeyId = z.string().regex(/^[0-9A-F]{16}$/);

/** Where a target stands for one release, in the order the flow goes through. */
export const RELEASE_SIGNING_STATES = [
  /** The target has no signing, or it is configured but not required. */
  'not_required',
  /** The commit is not a shipped release (only a shipped release is signed). */
  'no_release',
  /** Nothing was packaged for this target yet. */
  'not_prepared',
  /** `release.prepare` is queued or running on the deploying workstation. */
  'preparing',
  'prepare_failed',
  /** Packaged; no signature by the target's key over that artefact yet. */
  'waiting_signature',
  /** `release.sign` is waiting for the local approval on the workstation. */
  'signing',
  'sign_failed',
  'signed',
] as const;
export const ReleaseSigningStateSchema = z.enum(RELEASE_SIGNING_STATES);
export type ReleaseSigningState = z.infer<typeof ReleaseSigningStateSchema>;

export const ReleaseSigningTargetSchema = z.object({
  targetId: z.uuid(),
  targetName: z.string(),
  signing: DeployTargetSigningSchema.nullable(),
  state: ReleaseSigningStateSchema,
  /** The artefact path the runner packages and signs for this target (`release/<target>/manifest.json`). */
  artefact: z.string().nullable(),
  artefactSha256: Sha256Hex.nullable(),
  preparedAt: z.string().nullable(),
  signature: z.object({ keyId: KeyId, source: ReleaseSignatureSourceSchema, at: z.string() }).nullable(),
  /** The last prepare or sign failure, as the workstation reported it. */
  error: z.string().nullable(),
});
export type ReleaseSigningTarget = z.infer<typeof ReleaseSigningTargetSchema>;

/** `GET /api/projects/:id/release-signing?env&commit`. */
export const ReleaseSigningStatusSchema = z.object({
  env: z.string(),
  commit: z.string().nullable(),
  release: z.object({ releaseId: z.uuid(), version: z.string(), tag: z.string() }).nullable(),
  targets: z.array(ReleaseSigningTargetSchema),
});
export type ReleaseSigningStatus = z.infer<typeof ReleaseSigningStatusSchema>;

export const ReleaseSigningStatusQuerySchema = z.object({
  env: z.string().min(1).max(40),
  commit: z.string().trim().max(64).optional(),
});

/** `PUT /api/deploy-targets/:id/signing` (project Owner, step-up). `publicKey` may be the whole `.pub` file. */
export const SetDeployTargetSigningRequestSchema = z.object({
  signing: z
    .object({
      required: z.boolean(),
      publicKey: z.string().min(56).max(400),
      /** Optional cross-check: refused when it is not the id inside `publicKey`. */
      keyId: KeyId.optional(),
      artefact: z
        .string()
        .min(1)
        .max(200)
        .regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/)
        .optional(),
    })
    .nullable(),
});
export type SetDeployTargetSigningRequest = z.infer<typeof SetDeployTargetSigningRequestSchema>;

/** `POST /api/projects/:id/release-signing/prepare`: package the runner of the release of `commit` for one target. */
export const ReleaseSigningPrepareRequestSchema = z.object({
  targetId: z.uuid(),
  commit: z.string().trim().min(7).max(64),
});
export type ReleaseSigningPrepareRequest = z.infer<typeof ReleaseSigningPrepareRequestSchema>;

/** `POST /api/projects/:id/release-signing/sign`: ask the workstation that packaged it to sign (route 1). */
export const ReleaseSigningSignRequestSchema = z.object({ releaseId: z.uuid(), targetId: z.uuid() });
export type ReleaseSigningSignRequest = z.infer<typeof ReleaseSigningSignRequestSchema>;

/** `POST /api/projects/:id/release-signing/signature`: an offline signature (route 2), the `.minisig` file's text. */
export const ReleaseSignatureUploadRequestSchema = z.object({
  releaseId: z.uuid(),
  targetId: z.uuid(),
  minisig: z.string().min(10).max(2048),
  /** The sha256 of the manifest that was downloaded: refused when the target was packaged again since. */
  artefactSha256: Sha256Hex.optional(),
});
export type ReleaseSignatureUploadRequest = z.infer<typeof ReleaseSignatureUploadRequestSchema>;

export const ReleaseSigningManifestQuerySchema = z.object({ releaseId: z.uuid(), targetId: z.uuid() });

/** The 409 of a prepare or upload before anything was packaged, and of an upload over an artefact packaged again since. */
export const ARTEFACT_NOT_PREPARED = 'artefact_not_prepared';
export const ARTEFACT_CHANGED = 'artefact_changed';
/** The 422 of a signature that does not verify against the target's key and artefact, or is by another key. */
export const SIGNATURE_INVALID = 'signature_invalid';
export const SIGNATURE_WRONG_KEY = 'signature_wrong_key';

/**
 * The artefact a target's runner is packaged into and signed as: the target's own folder beside the configured file, so
 * one release packaged for UAT and for prod never overwrites the other (`release/manifest.json` -> `release/uat/manifest.json`).
 */
export function targetArtefactPath(artefact: string, targetName: string): string {
  const slug =
    targetName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'target';
  const i = artefact.lastIndexOf('/');
  return i < 0 ? `${slug}/${artefact}` : `${artefact.slice(0, i)}/${slug}/${artefact.slice(i + 1)}`;
}
