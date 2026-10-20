import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAccountRegistry } from '../adapters/claude-accounts.ts';
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
  const claudeAccounts = new ClaudeAccountRegistry({
    home: homedir(),
    root: paths.root,
    secretsDir: paths.secrets,
    accounts: () => config().runtimes['claude-code'].accounts,
    mainCredential: () => resolveClaudeCredential(claudeStore, config().runtimes['claude-code']),
  });
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
      probeLogin: async (key) => {
        if (realClaudeBlocked()) return 'unknown';
        const cc = config().runtimes['claude-code'];
        const account = claudeAccounts.get(key ?? 'main');
        if (!account) return 'unknown';
        const r = await probeClaudeLogin({ bin: cc.bin, env: account.probeEnv() });
        if (r === 'ok') account.auth.markOk();
        return r;
      },
      authState: (key) => claudeAccounts.get(key ?? 'main')?.auth.state ?? 'ok',
      afterChange: async () => undefined,
    },
    claudeAccounts,
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
