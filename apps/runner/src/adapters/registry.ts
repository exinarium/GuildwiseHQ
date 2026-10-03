import type { RunnerConfig } from '../config.ts';
import type { RunnerPaths } from '../paths.ts';
import { ClaudeCodeAdapter } from './claude-code.ts';
import { MockAdapter } from './mock.ts';
import type { RuntimeAdapter } from './types.ts';

/** Adapters enabled by the config: `claude-code` always, `mock` only when `runtimes.mock.enabled`. */
export function buildAdapters(config: RunnerConfig, paths: RunnerPaths): Map<string, RuntimeAdapter> {
  const adapters = new Map<string, RuntimeAdapter>();
  adapters.set('claude-code', new ClaudeCodeAdapter(config.runtimes['claude-code'], paths));
  if (config.runtimes.mock?.enabled) adapters.set('mock', new MockAdapter(config.runtimes.mock, paths));
  return adapters;
}
