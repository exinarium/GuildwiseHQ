import type { RunnerConfig } from '../config.ts';
import type { ProviderStore } from '../direct/store.ts';
import type { RunnerPaths } from '../paths.ts';
import type { ClaudeAccountRegistry } from './claude-accounts.ts';
import type { ClaudeAuthMonitor } from './claude-auth.ts';
import { ClaudeCodeAdapter, realClaudeBlocked } from './claude-code.ts';
import type { ClaudeUsageMonitor } from './claude-usage-limit.ts';
import { CodexAdapter, detectCodex } from './codex.ts';
import type { DirectModelOptions } from './direct-model.ts';
import { DirectModelAdapter } from './direct-model.ts';
import { MockAdapter } from './mock.ts';
import type { RuntimeAdapter } from './types.ts';

/**
 * Adapters enabled by the config: `claude-code` always, `mock` only when `runtimes.mock.enabled`, `direct-model` whenever the
 * runner has a provider store (it reports no providers, and is unavailable, until a key is stored), and `codex` only when the
 * `codex` binary is found (on PATH or at `runtimes.codex.bin`) at start: installing it later needs a runner restart.
 */
export function buildAdapters(
  config: RunnerConfig,
  paths: RunnerPaths,
  auth?: ClaudeAuthMonitor,
  credentials?: NonNullable<ConstructorParameters<typeof ClaudeCodeAdapter>[2]>['credentials'],
  usage?: ClaudeUsageMonitor,
  accounts?: ClaudeAccountRegistry,
  direct?: { store: ProviderStore; options?: Partial<DirectModelOptions>; onModelsChanged?: () => void },
): Map<string, RuntimeAdapter> {
  const adapters = new Map<string, RuntimeAdapter>();
  adapters.set(
    'claude-code',
    new ClaudeCodeAdapter(config.runtimes['claude-code'], paths, {
      ...(auth ? { auth } : {}),
      ...(credentials ? { credentials } : {}),
      ...(usage ? { usage } : {}),
      ...(accounts ? { accounts } : {}),
      ...(direct ? { providers: direct.store } : {}),
    }),
  );
  if (config.runtimes.mock?.enabled) adapters.set('mock', new MockAdapter(config.runtimes.mock, paths));
  const codexBin = detectCodex(config.runtimes.codex, { blocked: realClaudeBlocked() });
  if (codexBin) {
    const c = config.runtimes.codex;
    adapters.set(
      'codex',
      new CodexAdapter(
        { enabled: true, authMode: 'login', toolchainPaths: [], ...(c ?? {}), bin: codexBin },
        paths,
      ),
    );
  }
  if (direct)
    adapters.set(
      'direct-model',
      new DirectModelAdapter({
        store: direct.store,
        root: paths.root,
        ...(direct.options ? { options: direct.options } : {}),
        ...(direct.onModelsChanged ? { onModelsChanged: direct.onModelsChanged } : {}),
      }),
    );
  return adapters;
}
