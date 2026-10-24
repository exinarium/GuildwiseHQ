import { z } from 'zod';
import { sealLarge } from '../delivery/connect.ts';
import { requireSubtle } from '../secure-context.ts';

/**
 * What a sealed credential is bound to (security review, findings 1, 2 and 8). A hybrid blob without associated data (`h1.`) can
 * be relabelled by whoever relays it: an organization's OpenAI key presented as an `openai-compatible` key with the endpoint
 * changed to a host of the relay's choosing, a revoked key replayed, a pack token redirected to another host. `h2.` blobs carry the
 * purpose as AES-GCM associated data. The browser builds the string from what it is sealing; the runner REBUILDS it from the
 * command it received and opens the blob with it, so a blob moved to another provider, organization, endpoint, key generation or
 * runner key does not open.
 */

/** The endpoint as it is compared and bound: a parsed URL without trailing slashes ('' when there is none). */
export function normalizeEndpoint(raw: string | null | undefined): string {
  const t = (raw ?? '').trim();
  if (!t) return '';
  try {
    return new URL(t).toString().replace(/\/+$/, '');
  } catch {
    return t;
  }
}

export interface ProviderKeyBinding {
  /** Whose slot: the workstation's own key, or an organization's. */
  scope: 'org' | 'workstation';
  /** The organization (required for `org`). */
  orgId?: string | undefined;
  provider: string;
  /** The endpoint (base URL) the credential is for: the provider's `baseUrl`, or a backend credential's `baseUrl` field. */
  endpoint?: string | undefined;
  /**
   * The key's generation. An organization key: `org_providers.key_generation`. A workstation's own key (Q73): chosen by the browser
   * (seconds since the epoch), so a later entry is always higher; 0 for a key sealed before keys had one (still accepted, with a warning).
   */
  generation: number;
  /** The id of the runner key it is sealed to. */
  keyId: string;
  /**
   * A named account of the workstation's own key (S-A): the same provider can hold a main key and keys named `work`, `personal`.
   * Bound into the associated data, so a blob sealed for one account does not open as another's (or as the main key). Absent or
   * empty for the main key, whose associated data is unchanged (every key sealed before accounts existed still opens).
   */
  account?: string | undefined;
}

/** The associated data of a sealed provider or backend credential. Every field is a plain string, joined unambiguously. */
export function providerKeyAad(b: ProviderKeyBinding): string {
  const base: Array<string | number> = [
    'aom-provider-key/v2',
    b.scope,
    b.scope === 'org' ? (b.orgId ?? '') : '',
    b.provider,
    normalizeEndpoint(b.endpoint),
    b.generation,
    b.keyId,
  ];
  // the account comes last and only when there is one: the main key's associated data is what it always was
  if (b.scope === 'workstation' && b.account) base.push(b.account);
  return JSON.stringify(base);
}

/** Seals a provider or backend credential for one runner, bound to its purpose (`h2.`). */
export function sealProviderKey(
  publicKeyB64: string,
  secret: string,
  b: ProviderKeyBinding,
): Promise<string> {
  return sealLarge(publicKeyB64, secret, providerKeyAad(b));
}

// ------------------------------------------------------------------------------------------------- pack credentials

/** The host a pack credential may be used for: the lower-case host name (no port) of the pack's git URL, ssh or https. */
export function packCredentialHost(gitUrl: string): string {
  const t = gitUrl.trim();
  // scp-like ssh: git@host:owner/repo
  const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)/.exec(t);
  if (scp?.[1]) return scp[1].toLowerCase();
  try {
    return new URL(t).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

export function packCredentialAad(b: {
  packId: string;
  kind: 'ssh' | 'token';
  host: string;
  keyId: string;
}): string {
  return JSON.stringify(['aom-pack-credential/v2', b.packId, b.kind, b.host.toLowerCase(), b.keyId]);
}

// ------------------------------------------------------------------------------------------------- reshare approval

/**
 * The approval an Owner or Admin's browser makes when they share an organization key from one workstation to another. It is sealed
 * to the SOURCE runner's key (so only that runner can read it) and carries what the admin was shown: the target runner's key id and
 * the hash of its public key. The source runner recomputes both from the public key it is asked to seal to and refuses any
 * difference, and the nonce makes each approval usable once.
 */
export const ResealApprovalSchema = z.object({
  v: z.literal(1),
  orgId: z.uuid(),
  provider: z.string().min(1).max(40),
  generation: z.number().int().min(1),
  sourceKeyId: z.string().min(1).max(64),
  targetKeyId: z.string().min(1).max(64),
  /** SHA-256 (hex) of the target's SPKI public key (the DER bytes). */
  targetPublicKeySha256: z.string().regex(/^[0-9a-f]{64}$/),
  nonce: z.string().min(16).max(64),
  /** Epoch milliseconds after which the approval is void. */
  exp: z.number().int(),
  /** The Owner or Admin who approved (for the log; the runner cannot check it). */
  approvedBy: z.uuid(),
});
export type ResealApproval = z.infer<typeof ResealApprovalSchema>;

/** Longest an approval may be valid for. */
export const RESEAL_APPROVAL_MAX_MS = 15 * 60_000;

export function resealApprovalAad(b: { orgId: string; provider: string; sourceKeyId: string }): string {
  return JSON.stringify(['aom-reseal-approval/v1', b.orgId, b.provider, b.sourceKeyId]);
}

const toHex = (u: ArrayBuffer) => [...new Uint8Array(u)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** SHA-256 (hex) of a base64 SPKI public key. */
export async function spkiSha256(publicKeyB64: string): Promise<string> {
  const der = Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0));
  return toHex(await requireSubtle().digest('SHA-256', der));
}

/** The runner key id of a public key: the first 16 hex digits of the SHA-256 of the SPKI (what a runner announces). */
export async function keyIdOfSpki(publicKeyB64: string): Promise<string> {
  return (await spkiSha256(publicKeyB64)).slice(0, 16);
}

/**
 * The browser side: seals the approval of sharing `provider` of `orgId` (generation `generation`) from the source runner to the
 * target runner, naming the target's key as the admin saw it.
 */
export async function sealResealApproval(a: {
  source: { keyId: string; publicKey: string };
  target: { keyId: string; publicKey: string };
  orgId: string;
  provider: string;
  generation: number;
  approvedBy: string;
  now?: number;
}): Promise<string> {
  requireSubtle();
  const nonce = toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer);
  const body: ResealApproval = {
    v: 1,
    orgId: a.orgId,
    provider: a.provider,
    generation: a.generation,
    sourceKeyId: a.source.keyId,
    targetKeyId: a.target.keyId,
    targetPublicKeySha256: await spkiSha256(a.target.publicKey),
    nonce,
    exp: (a.now ?? Date.now()) + RESEAL_APPROVAL_MAX_MS - 60_000,
    approvedBy: a.approvedBy,
  };
  return sealLarge(
    a.source.publicKey,
    JSON.stringify(body),
    resealApprovalAad({ orgId: a.orgId, provider: a.provider, sourceKeyId: a.source.keyId }),
  );
}
