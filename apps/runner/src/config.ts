import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ClaudeAccountKeySchema } from '@aom/shared';
import { z } from 'zod';

/** An additional Claude account of this workstation (docs/design/claude-accounts.md section 2.1). */
export const ClaudeAccountConfigSchema = z.object({
  key: ClaudeAccountKeySchema,
  /** Claude Code config dir; '~' allowed. Default '~/.claude-gw-<key>' (created when missing). */
  configDir: z.string().optional(),
  /** 'config_dir' (default) or 'token' (`secrets/claude-accounts/<key>.json` holds an oauth token or API key). */
  source: z.enum(['config_dir', 'token']).default('config_dir'),
});
export type ClaudeAccountConfig = z.infer<typeof ClaudeAccountConfigSchema>;

export const ClaudeRuntimeConfigSchema = z.object({
  bin: z.string().default('claude'),
  /** `oauth`: `oauthToken` (from `claude setup-token`); `api_key`: `apiKey`; `default`: link `~/.claude/.credentials.json`. */
  authMode: z.enum(['oauth', 'api_key', 'default']).default('default'),
  oauthToken: z.string().optional(),
  apiKey: z.string().optional(),
  /**
   * M7, the BA's intake chat: the Jira tool of this workstation. `mcpConfig` is the path of an MCP config file (with the
   * Jira server and its credentials, which never leave this machine); `allowedTools` lists what the chat may use
   * without asking (`mcp__<server>`, `WebFetch`, ...). Without it the chat has no tools beyond `aom`, `gh` and reading.
   */
  /**
   * OS-level sandbox around the agent's shell (Claude Code's own: bubblewrap + socat on Linux/WSL2, Seatbelt on
   * macOS). `required` (default): the runtime is unavailable, and sessions refuse to start, without it.
   * `best_effort`: run unsandboxed when it cannot start. `off`: no sandbox (permission rules still apply).
   */
  sandbox: z.enum(['required', 'best_effort', 'off']).default('required'),
  /**
   * Explicit acknowledgement that agents may run with no OS sandbox. `best_effort` on a platform that cannot sandbox
   * (native Windows) starts unsandboxed only with this set; without it the runtime reports itself unavailable.
   * `off` needs no flag (it is the opt-in). Default false.
   */
  allowUnsandboxed: z.boolean().default(false),
  /** Extra hosts agents' shell commands may reach (private package mirrors, an internal git host). */
  extraAllowedDomains: z.array(z.string()).default([]),
  /**
   * Extra toolchain directories sandboxed shell commands may read (e.g. ~/.dotnet, ~/.cargo, ~/.local/bin). The
   * read block hides /home from sandboxed commands; the Node install the runner itself runs on is re-opened
   * automatically. Never list a directory that holds credentials.
   */
  toolchainPaths: z.array(z.string()).default([]),
  /**
   * Sets CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1: Claude Code removes credentials from the environment of everything its
   * shell starts and, on Linux, isolates the PID namespace so `/proc/<pid>/environ` of other processes is unreadable.
   * Off by default because it also removes variables Claude Code considers credentials, which may include the
   * shift token the `aom` CLI needs; try it on one workstation first (docs/RUNNER.md).
   */
  scrubSubprocessEnv: z.boolean().default(false),
  /** Additional accounts besides the main one (today's credential); named by the key a project uses. */
  accounts: z.array(ClaudeAccountConfigSchema).default([]),
  intake: z
    .object({ mcpConfig: z.string().optional(), allowedTools: z.array(z.string()).default([]) })
    .optional(),
});

/**
 * Jira on this workstation, for posting approved updates (M8). The runner posts with the owner's own API token over
 * REST; the token stays in this file (mode 0600) and nowhere else. `email` + `apiToken` is Jira Cloud (basic auth);
 * `apiToken` alone is a personal access token (bearer) for Jira Data Center.
 */
export const JiraConfigSchema = z.object({
  baseUrl: z.string().min(1),
  email: z.string().optional(),
  apiToken: z.string().min(1),
});
export type JiraConfig = z.infer<typeof JiraConfigSchema>;

export const MockRuntimeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Narrow the advertised capabilities (default: all). */
  capabilities: z.array(z.string()).optional(),
  /** Test only: report this sandbox state in `hello` (the mock runs nothing in an OS sandbox either way). */
  sandbox: z.enum(['enforced', 'unsandboxed', 'unavailable']).optional(),
  sandboxReason: z.string().optional(),
});

/**
 * Local policy for connecting integrations from the web (docs/design/integrations-page.md D8). `allowWeb` false refuses every
 * web-submitted credential and sign-in on this workstation (`aom-runner integrations allow-web off`). Machine-wide logins
 * (`~/.claude`, `gh`, MCP sign-ins) are changed from the web only by the machine's primary pairing.
 */
export const IntegrationsPolicyConfigSchema = z.object({
  allowWeb: z.boolean().default(true),
  machineScopeFromWeb: z.enum(['primary', 'never']).default('primary'),
});

/**
 * The CEO's full-power profile (docs/design/ceo-front-door.md section 3.2): a cap the machine owner holds against any server.
 * `aom-runner ceo full-power on` lets the Owner's own CEO chat run as his real Claude Code session on this machine.
 */
export const CeoConfigSchema = z.object({
  fullPower: z.boolean().default(false),
});

/**
 * Retention of the agents' `scratch/` folders (docs/RUNNER.md, "Scratch retention"). Pruned after every shift and by a
 * periodic sweep, only while the agent has no shift or chat running.
 */
export const ScratchConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Top-level entries not touched for this many days are removed. */
  maxAgeDays: z.number().positive().default(3),
  /** Per-agent cap in bytes (default 10 GB, 0: no cap); the oldest entries go first. */
  maxBytes: z
    .number()
    .int()
    .nonnegative()
    .default(10 * 1024 ** 3),
  /** Top-level names never pruned. */
  keep: z.array(z.string().min(1)).default([]),
  /** Hours between the periodic scratch and worktree sweeps (also run at start). */
  sweepIntervalHours: z.number().positive().default(4),
});

export const RunnerConfigSchema = z.object({
  serverUrl: z.string().min(1),
  workstationId: z.string().min(1),
  runnerToken: z.string().min(1),
  repoRoots: z.array(z.string()).default([]),
  /**
   * Organization source folders: `{ [organizationId]: folder }`. Agents whose role may read the organization's code (the
   * architect) can read every git repository under the folder of their organization, read-only, secret files blocked.
   * Set with `aom-runner org-folder set`; the folder must sit inside one of `repoRoots` (never the home or data dir).
   * The server never learns the path.
   */
  orgSourceFolders: z.record(z.string(), z.string()).default({}),
  runtimes: z
    .object({
      'claude-code': ClaudeRuntimeConfigSchema.default(ClaudeRuntimeConfigSchema.parse({})),
      mock: MockRuntimeConfigSchema.optional(),
    })
    .default({ 'claude-code': ClaudeRuntimeConfigSchema.parse({}) }),
  /** M8: credentials for posting approved updates to Jira (GitHub uses this machine's `gh` login). */
  jira: JiraConfigSchema.optional(),
  /** The CEO's full-power switch (see `CeoConfigSchema`). */
  ceo: CeoConfigSchema.default(CeoConfigSchema.parse({})),
  /** Integrations page policy (see `IntegrationsPolicyConfigSchema`). */
  integrations: IntegrationsPolicyConfigSchema.default(IntegrationsPolicyConfigSchema.parse({})),
  /**
   * The .NET install root agents use (`~` allowed). By default the runner picks the root with the most SDK versions
   * among `$DOTNET_ROOT`, `~/.dotnet`, `/usr/share/dotnet`, ... and the root behind `dotnet` on PATH.
   */
  dotnetRoot: z.string().optional(),
  maxConcurrentShifts: z.number().int().positive().default(4),
  /** Run a branch (#58): how many run environments this workstation holds at once, and the range allocated ports come from. */
  maxRunEnvironments: z.number().int().positive().default(2),
  runPortRange: z
    .object({ from: z.number().int().min(1024).max(65535), to: z.number().int().min(1024).max(65535) })
    .refine((r) => r.from <= r.to, { message: 'runPortRange.from must not exceed to' })
    .default({ from: 20000, to: 29999 }),
  vaultSyncIntervalSec: z.number().int().positive().default(300),
  /** Disk retention of the agents' scratch folders (see `ScratchConfigSchema`). */
  scratch: ScratchConfigSchema.default(ScratchConfigSchema.parse({})),
});
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

export function loadConfig(path: string): RunnerConfig {
  if (!existsSync(path)) throw new Error(`No runner config at ${path}. Run \`aom-runner pair\` first.`);
  return RunnerConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Atomic write with mode 0600 (the file holds the runner token and possibly provider credentials). */
export function saveConfig(path: string, config: RunnerConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // not supported on every platform
  }
  renameSync(tmp, path);
}

/** `AOM_RUNNER_MOCK=1` or `--mock` enable the mock runtime for this process without editing config.json. */
export function applyOverrides(config: RunnerConfig, opts: { mock?: boolean }): RunnerConfig {
  if (!opts.mock) return config;
  // AOM_RUNNER_MOCK_SANDBOX=unsandboxed|unavailable|enforced: test-only, makes the mock runtime report that state.
  const forced = process.env.AOM_RUNNER_MOCK_SANDBOX;
  const sandbox = MockRuntimeConfigSchema.shape.sandbox.safeParse(forced).data;
  return {
    ...config,
    runtimes: {
      ...config.runtimes,
      mock: {
        ...(config.runtimes.mock ?? {}),
        enabled: true,
        ...(sandbox ? { sandbox, sandboxReason: `test override: AOM_RUNNER_MOCK_SANDBOX=${sandbox}` } : {}),
      },
    },
  };
}
