import type { PendingUpdate } from './layout.ts';

/** How long a freshly updated runner has to connect before it is rolled back. */
export const PROBATION_SEC = 5 * 60;

export type ProbationDecision =
  /** No update is on probation. */
  | { action: 'none' }
  /** The marker belongs to some other version (a rollback already happened, or it is left over): remove it. */
  | { action: 'stale' }
  /** The new version connected: the update worked. Remove the marker and prune old versions. */
  | { action: 'confirm' }
  /** Still within the probation window, or the server cannot be reached so a failed connect proves nothing. */
  | { action: 'wait'; reason: 'probation' | 'server_unreachable'; untilSec: number }
  /** The window passed without a connection while the server is reachable: go back to the previous version. */
  | { action: 'rollback' };

export interface ProbationInput {
  pending: PendingUpdate | null;
  /** The version this process is. */
  running: string;
  /** Has any pairing of this runner completed the hello/welcome handshake since start. */
  connected: boolean;
  nowSec: number;
  /** Whether the server answered a plain HTTP request just now (only consulted once the window has passed). */
  serverReachable: boolean;
}

/**
 * The rollback rule, kept pure so it can be tested without a filesystem or a clock. A new version must reach the
 * server within `PROBATION_SEC`; if it does not and the server is up, the previous version is restored. If the server
 * itself is down the runner cannot tell a broken update from an outage, so it keeps waiting instead of rolling back.
 */
export function decideProbation(i: ProbationInput): ProbationDecision {
  if (!i.pending) return { action: 'none' };
  if (i.pending.to !== i.running) return { action: 'stale' };
  if (i.connected) return { action: 'confirm' };
  if (i.nowSec < i.pending.deadline)
    return { action: 'wait', reason: 'probation', untilSec: i.pending.deadline };
  if (!i.serverReachable)
    return { action: 'wait', reason: 'server_unreachable', untilSec: i.nowSec + PROBATION_SEC };
  return { action: 'rollback' };
}
