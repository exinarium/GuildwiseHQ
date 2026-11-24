import { PasskeyAlgSchema } from '@aom/shared';
import { z } from 'zod';

/**
 * `~/.config/aom-runner/policy.json` (R18-S, R20, R21, R22, R30): the runner's local authority. Written only by the CLI
 * on this machine (`guildwise-runner setup`, `approve --pin`, `devops grant`, `passkey trust`,
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

/** A Mac's Docker Desktop socket of a logged-in user (`host` on macOS). */
export const DESKTOP_HOST_RE = /^unix:\/\/\/Users\/[^/]+\/\.docker\/run\/docker\.sock$/;
/** The socket of another user's rootless daemon (`shared`), such as `unix:///run/docker-svc/docker.sock`. */
export const SHARED_HOST_RE = /^unix:\/\/\/(?:var\/)?run\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/docker\.sock$/;
/** Every `dockerHost` setup writes. */
export const DOCKER_HOST_RE = new RegExp(`${DESKTOP_HOST_RE.source}|${SHARED_HOST_RE.source}`);

/** Docker values of before 1.10.0 (W10 narrow mode was removed; the docker group is the installed daemon). */
export function mapLegacyDocker(v: unknown): unknown {
  if (v === 'narrow') return 'none';
  if (v === 'group') return 'host';
  return v;
}

export const PolicySchema = z
  .object({
    version: z.literal(POLICY_VERSION).default(POLICY_VERSION),
    /**
     * DevOps grants (R18-S): which agent may serve which organization outside the sandbox. Local only. The sudo grant
     * was removed in 1.10.0: an old `devops.sudo` is dropped like any unknown field, so the file stays valid.
     */
    devops: z
      .object({
        /** Organization id -> the DevOps agent id granted on this machine (`guildwise-runner devops grant <org>`). */
        agents: z.record(Uuid, Uuid).default({}),
      })
      .default({ agents: {} }),
    /** Deploys wait for `guildwise-runner approve` (`ask`) or are refused (`off`). */
    deploy: z.enum(['ask', 'off']).default('ask'),
    /** Whole-command hashes of deploys approved with `--pin` (they redeploy unattended while unchanged) [rv4-4]. */
    deployPins: z.array(Sha256Hex).max(1000).default([]),
    /** Pins also bind the commit, so a new commit needs approval again [rv4-5]. */
    deployPinCommit: z.boolean().default(false),
    /** DevOps tasks not started on this machine wait for a local yes (`ask`) or run (`auto`) [rv4-2]. */
    devopsRequests: z.enum(['ask', 'auto']).default('ask'),
    /** Origins whose unsigned update manifests are accepted (test machines only) [rv5-6]. */
    allowUnsignedUpdatesFrom: z.array(Origin).max(20).default([]),
    /**
     * The runner's Docker (1.10.0): `rootless` = its own rootless daemon (one per runner user, so per instance), `host` =
     * the installed daemon (root-equivalent: needs acceptRootEquivalent), `none` = no Docker. Values of before map:
     * `narrow` (removed) -> `none`, `group` -> `host`, so an old file still parses instead of resetting every grant.
     */
    docker: z.preprocess(mapLegacyDocker, z.enum(['rootless', 'host', 'shared', 'none'])).default('none'),
    /**
     * The daemon's socket when it is not the default: for `host` a Mac's Docker Desktop socket of the logged-in user
     * (`unix:///Users/<user>/.docker/run/docker.sock`); for `shared` the socket of another user's rootless daemon.
     */
    dockerHost: z.string().regex(DOCKER_HOST_RE).optional(),
    /**
     * `shared` (owner 2026-11-21: "The uat runner will use the rootless docker already installed"; "Prod and UAT can use
     * the same rootless docker"): the acceptance root recorded at install (`guildwise-admin docker shared`), after the
     * typed acceptance in setup. The start-up check then only warns for exactly this socket, while its daemon is rootless.
     */
    sharedDocker: z
      .object({
        socket: z.string().regex(/^\/[A-Za-z0-9._/-]{1,300}$/),
        group: z.string().min(1).max(64),
        acceptedAt: z.iso.datetime().optional(),
      })
      .optional(),
    /** The account the runner runs as (R20): the dedicated `guildwise-runner` user, or the installing user. */
    runnerUser: z
      .object({
        mode: z.enum(['dedicated', 'current']),
        name: z.string().min(1).max(64),
        /** Windows: the WSL distro the runner lives in (copy-paste commands start with `wsl -d <distro> --`). */
        wslDistro: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,64}$/)
          .optional(),
      })
      .optional(),
    /** `guildwise-runner setup` finished; until then unsandboxed paths are held ("setup pending") [R20, Q13]. */
    setupDone: z.boolean().default(false),
    /** Repositories whose installs may run their scripts (`guildwise-runner repo allow-scripts <url>`) [rv3-2]. */
    installScripts: z.record(z.string().min(1).max(500), z.literal(true)).default({}),
    /** Registry hosts an `aom devops install` may use besides registry.npmjs.org and registry.yarnpkg.com (owner 2026-11-21). */
    installRegistries: z.array(z.string().min(1).max(253)).max(50).default([]),
    /** Proxy and TLS keys (proxy, https-proxy, strict-ssl, ca, cafile, ...) in a project's .npmrc/.yarnrc/bunfig may apply. */
    installNetworkConfig: z.boolean().default(false),
    /**
     * easy-runner-setup (Overnight decision 4, narrows R18-S): git vault remotes approved on this machine. A
     * `vault.configure` runs unattended when every git vault's (vaultId, remote) is listed here; otherwise it is held, and
     * approving it adds the pairs shown.
     */
    vaultRemotes: z
      .array(z.object({ vaultId: z.string().min(1).max(200), remote: z.string().min(1).max(500) }))
      .max(1000)
      .default([]),
    /** Hashes of release formatter configs approved locally [rv3-2]. */
    formatterPins: z.array(Sha256Hex).max(1000).default([]),
    /** `aom devops` requests from agents: wait for a local approval (`ask`) or are refused (`deny`) (R18-D). */
    devopsAgentRequests: z.enum(['ask', 'deny']).default('ask'),
    /**
     * UAT 1.10.0 finding 3: may the DevOps helpers install the tools projects need (the installer's screen, `devops install
     * on|off`, Approvals on this computer)? The runner sends this choice to the server, which sets the workstation's
     * "Install packages and tools" switch to it. Absent: never chosen here (the website's switch stays as it is).
     */
    devopsInstall: z.boolean().optional(),
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
    /**
     * runner-authority-fixes T2 (D2): toolchains (`aom toolchain add` entry hashes) the owner approved locally. A
     * toolchain the DevOps engineer registered reaches other agents' PATH only once pinned here.
     */
    toolchainPins: z.array(Sha256Hex).max(1000).default([]),
  })
  .superRefine((p, ctx) => {
    if (p.docker === 'host' && !p.acceptRootEquivalent)
      ctx.addIssue({
        code: 'custom',
        path: ['docker'],
        message: 'docker "host" makes the runner root-equivalent: it needs acceptRootEquivalent',
      });
    if (
      p.dockerHost &&
      !(p.docker === 'host' && DESKTOP_HOST_RE.test(p.dockerHost)) &&
      !(p.docker === 'shared' && SHARED_HOST_RE.test(p.dockerHost))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['dockerHost'],
        message:
          'dockerHost is a Docker Desktop socket with docker "host", or a daemon socket under /run with "shared"',
      });
    if (p.docker === 'shared' && !p.dockerHost)
      ctx.addIssue({ code: 'custom', path: ['dockerHost'], message: 'docker "shared" needs dockerHost' });
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
