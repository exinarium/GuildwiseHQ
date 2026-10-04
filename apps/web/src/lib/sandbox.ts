import type { RuntimeInfo } from '@aom/shared';

/** Where the sandbox guidance lives (the heading "Windows: run the runner inside WSL2"). */
export const SANDBOX_DOCS_URL =
  'https://github.com/exinarium/agent-org-manager/blob/main/docs/RUNNER.md#windows-run-the-runner-inside-wsl2';

export const UNSANDBOXED_CONSEQUENCE =
  'an agent could read files your user can read, including the runner token. Run the runner in WSL2 to sandbox it.';

/** The sentence shown on an agent card: `Runs without an OS sandbox on <workstation>: ...`. */
export const agentWarning = (workstation: string): string =>
  `Runs without an OS sandbox on ${workstation}: ${UNSANDBOXED_CONSEQUENCE}`;

export const unsandboxedRuntimes = (runtimes: RuntimeInfo[]): RuntimeInfo[] =>
  runtimes.filter((r) => r.sandbox === 'unsandboxed');

export const unavailableRuntimes = (runtimes: RuntimeInfo[]): RuntimeInfo[] =>
  runtimes.filter((r) => r.sandbox === 'unavailable');

/** The runtime of a workstation an agent would run on, when it is unsandboxed. */
export const isRuntimeUnsandboxed = (runtimes: RuntimeInfo[], runtimeId: string): boolean =>
  runtimes.some((r) => r.id === runtimeId && r.sandbox === 'unsandboxed');
