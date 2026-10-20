import type { RunnerConfig } from '../config.ts';
import type { RunnerPaths } from '../paths.ts';
import type { ClaudeAccountRegistry } from './claude-accounts.ts';
import type { ClaudeAuthMonitor } from './claude-auth.ts';
import { ClaudeCodeAdapter } from './claude-code.ts';
import type { ClaudeUsageMonitor } from './claude-usage-limit.ts';
import { MockAdapter } from './mock.ts';
import type { RuntimeAdapter } from './types.ts';

/** Adapters enabled by the config: `claude-code` always, `mock` only when `runtimes.mock.enabled`. */
export function buildAdapters(
  config: RunnerConfig,
  paths: RunnerPaths,
  auth?: ClaudeAuthMonitor,
  credentials?: NonNullable<ConstructorParameters<typeof ClaudeCodeAdapter>[2]>['credentials'],
  usage?: ClaudeUsageMonitor,
  accounts?: ClaudeAccountRegistry,
): Map<string, RuntimeAdapter> {
  const adapters = new Map<string, RuntimeAdapter>();
  adapters.set(
    'claude-code',
    new ClaudeCodeAdapter(config.runtimes['claude-code'], paths, {
      ...(auth ? { auth } : {}),
      ...(credentials ? { credentials } : {}),
      ...(usage ? { usage } : {}),
      ...(accounts ? { accounts } : {}),
    }),
  );
  if (config.runtimes.mock?.enabled) adapters.set('mock', new MockAdapter(config.runtimes.mock, paths));
  return adapters;
}
