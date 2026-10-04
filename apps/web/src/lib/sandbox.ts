import type { RuntimeInfo } from '@aom/shared';

/** Where the sandbox guidance lives (the heading "Windows: run the runner inside WSL2"). */
export const SANDBOX_DOCS_URL =
  'https://github.com/exinarium/agent-org-manager/blob/main/docs/RUNNER.md#windows-run-the-runner-inside-wsl2';

const CONSEQUENCE = 'an agent could read files your user can read, including the runner token.';

/** What to do about it, by the cause the runner reported (platform, config `off`, missing tools, test override). */
export function sandboxAdvice(reason?: string | null): string {
  const r = reason ?? '';
  if (/override/i.test(r)) return 'This state is forced by a test override.';
  if (/\bwindows\b/i.test(r)) return 'Run the runner in WSL2 to sandbox it.';
  if (/bwrap|socat/i.test(r)) return 'Install bubblewrap and socat to sandbox it.';
  if (/"off"/.test(r))
    return 'Set the runtime sandbox back to "required" in the runner config to sandbox it.';
  return 'Run the runner in WSL2, or on Linux with bubblewrap and socat, to sandbox it.';
}

/** The default consequence sentence (cause unknown). */
export const UNSANDBOXED_CONSEQUENCE = `${CONSEQUENCE} ${sandboxAdvice(null)}`;

/** The consequence plus advice that fits the reported cause. */
export const unsandboxedConsequence = (reason?: string | null): string =>
  `${CONSEQUENCE} ${sandboxAdvice(reason)}`;

/** The sentence shown on an agent card: `Runs without an OS sandbox on <workstation>: ...`. */
export const agentWarning = (workstation: string, reason?: string | null): string =>
  `Runs without an OS sandbox on ${workstation}: ${reason ? unsandboxedConsequence(reason) : UNSANDBOXED_CONSEQUENCE}`;

export const unsandboxedRuntimes = (runtimes: RuntimeInfo[]): RuntimeInfo[] =>
  runtimes.filter((r) => r.sandbox === 'unsandboxed');

export const unavailableRuntimes = (runtimes: RuntimeInfo[]): RuntimeInfo[] =>
  runtimes.filter((r) => r.sandbox === 'unavailable');

/** The runtime of a workstation an agent would run on, when it is unsandboxed. */
export const isRuntimeUnsandboxed = (runtimes: RuntimeInfo[], runtimeId: string): boolean =>
  runtimes.some((r) => r.id === runtimeId && r.sandbox === 'unsandboxed');

export const sandboxReasonOf = (runtimes: RuntimeInfo[], runtimeId: string): string | undefined =>
  runtimes.find((r) => r.id === runtimeId)?.sandboxReason;
