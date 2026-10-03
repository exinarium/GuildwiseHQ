import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

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
  intake: z
    .object({ mcpConfig: z.string().optional(), allowedTools: z.array(z.string()).default([]) })
    .optional(),
});

export const MockRuntimeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Narrow the advertised capabilities (default: all). */
  capabilities: z.array(z.string()).optional(),
});

export const RunnerConfigSchema = z.object({
  serverUrl: z.string().min(1),
  workstationId: z.string().min(1),
  runnerToken: z.string().min(1),
  repoRoots: z.array(z.string()).default([]),
  runtimes: z
    .object({
      'claude-code': ClaudeRuntimeConfigSchema.default(ClaudeRuntimeConfigSchema.parse({})),
      mock: MockRuntimeConfigSchema.optional(),
    })
    .default({ 'claude-code': ClaudeRuntimeConfigSchema.parse({}) }),
  maxConcurrentShifts: z.number().int().positive().default(4),
  vaultSyncIntervalSec: z.number().int().positive().default(300),
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
  return {
    ...config,
    runtimes: { ...config.runtimes, mock: { ...(config.runtimes.mock ?? {}), enabled: true } },
  };
}
