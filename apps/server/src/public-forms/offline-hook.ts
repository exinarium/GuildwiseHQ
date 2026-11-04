import type { Ctx } from '../context.ts';

/** What a public form tells the offline flow when a submission cannot land because the firm's workstation is offline. */
export interface RunnerOfflineEvent {
  orgId: string;
  formId: string;
  formVersion: number;
  linkId: string | null;
  submissionId: string | null;
  stage: 'start' | 'part' | 'complete';
  connectionIds: string[];
}

export type RunnerOfflineAnswer =
  | { kind: 'unavailable' }
  | { kind: 'link_later'; message: string; status?: 202 };

/**
 * The hook of the runner-offline flow. Never given an answer or a file. The default says "temporarily unavailable"
 * (503); the offline flow replaces it and may ask the client for an address to send a secure link to.
 */
export interface RunnerOfflineHook {
  onRunnerOffline(ctx: Ctx, e: RunnerOfflineEvent): Promise<RunnerOfflineAnswer>;
}

export const defaultRunnerOfflineHook: RunnerOfflineHook = {
  onRunnerOffline: async () => ({ kind: 'unavailable' }),
};
