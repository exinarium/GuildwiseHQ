import { PasskeyAlgSchema } from '@aom/shared';
import { z } from 'zod';

/**
 * `~/.config/aom-runner/policy.json` (R18-S, R20, R21, R22, R30): the runner's local authority. Written only by the CLI
 * on this machine (`guildwise-runner setup`, `approve --pin`, `devops grant`, `sudo enable`, `passkey trust`,
 * `signing add-key`, ...), mode 600. The server can narrow what it says, never widen it: nothing in here is ever taken
 * from the server. Missing fields take the safe default; unknown fields are dropped.
 */

export const POLICY_FILE = 'policy.json';
export const POLICY_FILE_MODE = 0o600;
export const POLICY_VERSION = 1;

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
/** An exact origin (`https://host[:port]`), as `allowUnsignedUpdatesFrom` and `legacyUpdateOrigin` compare it. */
const Origin = z
  .string()
  .max(300)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === v;
    } catch {
      return false;
    }
  }, 'an exact origin (scheme://host[:port], no path)');
const Uuid = z.uuid();

/** A passkey trusted on this machine with `guildwise-runner passkey trust` (R22). */
export const TrustedPasskeySchema = z.object({
  credentialId: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(1024),
  /** SPKI, base64. */
  publicKey: z.string().min(1).max(4096),
  alg: PasskeyAlgSchema,
  /** The relying party id and origin pinned at trust time; an assertion for any other is refused. */
  rpId: z.string().min(1).max(253),
  origin: Origin,
  name: z.string().max(80).optional(),
  trustedAt: z.iso.datetime().optional(),
  /** Highest authenticator sign count seen; a lower one is refused (cloned authenticator). */
  signCount: z.number().int().nonnegative().default(0),
});
export type TrustedPasskey = z.infer<typeof TrustedPasskeySchema>;

/** A signing key this workstation holds for release signing (R30). Only the path is stored, never the key. */
export const SigningKeySchema = z.object({
  keyId: z.string().regex(/^[0-9A-F]{16}$/),
  /** Absolute path of the minisign secret key file. */
  keyFile: z
    .string()
    .min(1)
    .max(1024)
    .refine((p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p), 'an absolute path'),
  /** Sign `release.sign` requests for this key without asking (typed confirmation; refused for passphrase keys, Q14). */
  autoSign: z.boolean().default(false),
});
export type SigningKey = z.infer<typeof SigningKeySchema>;

export const PolicySchema = z
  .object({
    version: z.literal(POLICY_VERSION).default(POLICY_VERSION),
    /** DevOps grants (R18-S): which agent may serve which organization outside the sandbox, and sudo. Local only. */
    devops: z
      .object({
        /** Organization id -> the DevOps agent id granted on this machine (`guildwise-runner devops grant <org>`). */
        agents: z.record(Uuid, Uuid).default({}),
        sudo: z.boolean().default(false),
      })
      .default({ agents: {}, sudo: false }),
    /** Deploys wait for `guildwise-runner approve` (`ask`) or are refused (`off`). */
    deploy: z.enum(['ask', 'off']).default('ask'),
    /** Whole-command hashes of deploys approved with `--pin` (they redeploy unattended while unchanged) [rv4-4]. */
    deployPins: z.array(Sha256Hex).max(1000).default([]),
    /** Pins also bind the commit, so a new commit needs approval again [rv4-5]. */
    deployPinCommit: z.boolean().default(false),
    /** DevOps tasks not started on this machine wait for a local yes (`ask`); `auto` is refused while sudo is granted [rv4-2]. */
    devopsRequests: z.enum(['ask', 'auto']).default('ask'),
    /** Origins whose unsigned update manifests are accepted (test machines only) [rv5-6]. */
    allowUnsignedUpdatesFrom: z.array(Origin).max(20).default([]),
    /** How deploys reach Docker (R20): not at all, the narrow root-owned helper, or the docker group (root-equivalent). */
    docker: z.enum(['none', 'narrow', 'group']).default('none'),
    /** The account the runner runs as (R20): the dedicated `guildwise-runner` user, or the installing user. */
    runnerUser: z
      .object({ mode: z.enum(['dedicated', 'current']), name: z.string().min(1).max(64) })
      .optional(),
    /** `guildwise-runner setup` finished; until then unsandboxed paths are held ("setup pending") [R20, Q13]. */
    setupDone: z.boolean().default(false),
    /** Repositories whose installs may run their scripts (`guildwise-runner repo allow-scripts <url>`) [rv3-2]. */
    installScripts: z.record(z.string().min(1).max(500), z.literal(true)).default({}),
    /** Hashes of release formatter configs approved locally [rv3-2]. */
    formatterPins: z.array(Sha256Hex).max(1000).default([]),
    /** `aom devops` requests from agents: wait for a local approval (`ask`) or are refused (`deny`) (R18-D). */
    devopsAgentRequests: z.enum(['ask', 'deny']).default('ask'),
    /** Containers for shifts (local only; privileged containers and host mounts are refused anyway) (R18-L). */
    allowDocker: z.boolean().default(false),
    /** CEO owner turns with full power start only from this machine (R18-S). */
    ceo: z.object({ fullPower: z.boolean().default(false) }).default({ fullPower: false }),
    /** Typed local confirmation that a root-equivalent runner may start (with the warning) [R21]. */
    acceptRootEquivalent: z.boolean().default(false),
    /**
     * Refuse to start when root-equivalent [R21]. Written `true` by the 1.10.0 installer and by `setup`; absent on a
     * runner that self-updated without `setup`, which then only warns (unless the server's welcome says signed runners
     * are required).
     */
    startupRefusal: z.boolean().optional(),
    /** Passkeys trusted on this machine for the two routine kinds [R22]. */
    passkeys: z.array(TrustedPasskeySchema).max(20).default([]),
    /** Set only for a runner that reached 1.10.0 through the old in-place update: its pairing origin [R29]. */
    legacyUpdateOrigin: Origin.optional(),
    /** Release signing keys held on this machine [R30]. */
    signingKeys: z.array(SigningKeySchema).max(20).default([]),
  })
  .superRefine((p, ctx) => {
    if (p.devopsRequests === 'auto' && p.devops.sudo)
      ctx.addIssue({
        code: 'custom',
        path: ['devopsRequests'],
        message: 'devopsRequests "auto" is not allowed while sudo is granted: with sudo, asking is always on',
      });
    if (p.docker === 'group' && !p.acceptRootEquivalent)
      ctx.addIssue({
        code: 'custom',
        path: ['docker'],
        message: 'docker "group" makes the runner root-equivalent: it needs acceptRootEquivalent',
      });
    const ids = new Set<string>();
    for (const k of p.signingKeys) {
      if (ids.has(k.keyId))
        ctx.addIssue({
          code: 'custom',
          path: ['signingKeys'],
          message: `signing key ${k.keyId} listed twice`,
        });
      ids.add(k.keyId);
    }
  });
export type Policy = z.infer<typeof PolicySchema>;

/** The policy of a machine that never ran `setup`: every grant off, deploys ask, nothing trusted. */
export const DEFAULT_POLICY: Policy = PolicySchema.parse({});

/** Parses the file's text; throws (with the zod issues) on invalid JSON or an invalid policy. */
export function parsePolicy(text: string): Policy {
  return PolicySchema.parse(JSON.parse(text));
}
