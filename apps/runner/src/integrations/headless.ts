import { homedir } from 'node:os';
import { join } from 'node:path';
import { probeClaudeLogin } from '../adapters/claude-auth.ts';
import { realClaudeBlocked } from '../adapters/claude-code.ts';
import { loadConfig } from '../config.ts';
import { touchRecheck } from '../forge/connect.ts';
import { SshSettingsStore } from '../forge/ssh.ts';
import { FileTokenStore } from '../forge/tokens.ts';
import { discoverPluginMcpServers, mcpAuthStates } from '../mcp/plugins.ts';
import type { RunnerPaths } from '../paths.ts';
import { realExecutor } from '../toolchain/exec.ts';
import { ClaudeCredentialStore, claudeFile, resolveClaudeCredential } from './claude-store.ts';
import { buildIntegrationAdapters } from './index.ts';
import type { AdapterEnv, IntegrationAdapter } from './types.ts';

/**
 * The adapters for a command line that runs without a Runner process (`aom-runner jira-connect`, `auth`, `integrations`):
 * the same `connect()`, `remove()` and `status()` the Integrations page uses, so the CLI and the web share one path and
 * one set of checks. A running runner notices the change by the recheck marker within seconds.
 */
export function headlessEnv(paths: RunnerPaths, overrides: Partial<AdapterEnv> = {}): AdapterEnv {
  const config = () => loadConfig(paths.config);
  const claudeStore = new ClaudeCredentialStore(claudeFile(paths.secrets));
  return {
    paths,
    forge: {
      exec: realExecutor,
      fetch: globalThis.fetch,
      tokens: new FileTokenStore(join(paths.secrets, 'git-tokens.json')),
      ssh: {
        settings: new SshSettingsStore(join(paths.secrets, 'git-ssh.json')),
        knownHosts: join(paths.secrets, 'known_hosts'),
      },
      ...(process.env.AOM_GH_BIN ? { ghBin: process.env.AOM_GH_BIN } : {}),
    },
    exec: realExecutor,
    fetch: globalThis.fetch,
    config,
    now: () => new Date(),
    home: homedir(),
    claudeStore,
    claude: {
      bin: () => config().runtimes['claude-code'].bin,
      blocked: () => realClaudeBlocked(),
      probe: async (env) =>
        realClaudeBlocked()
          ? 'unknown'
          : probeClaudeLogin({ bin: config().runtimes['claude-code'].bin, env }),
      probeLogin: async () => {
        if (realClaudeBlocked()) return 'unknown';
        const cc = config().runtimes['claude-code'];
        const c = resolveClaudeCredential(claudeStore, cc);
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (c.authMode === 'oauth' && c.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = c.oauthToken;
        if (c.authMode === 'api_key' && c.apiKey) env.ANTHROPIC_API_KEY = c.apiKey;
        return probeClaudeLogin({ bin: cc.bin, env });
      },
      authState: () => 'ok',
      afterChange: async () => undefined,
    },
    mcp: { discover: () => discoverPluginMcpServers(), authOf: () => mcpAuthStates() },
    repoHosts: () => ({}),
    sessionCwd: join(paths.root, 'tmp', 'integrations'),
    touchRecheck: () => touchRecheck(paths.secrets),
    ...overrides,
  };
}

export function headlessAdapters(paths: RunnerPaths, overrides: Partial<AdapterEnv> = {}) {
  const env = headlessEnv(paths, overrides);
  return { env, adapters: buildIntegrationAdapters(env) as Map<string, IntegrationAdapter> };
}
