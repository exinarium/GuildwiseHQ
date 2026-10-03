import { randomUUID } from 'node:crypto';
import type { Tx } from './db/tx.ts';

/**
 * M3 -> M2 seam. M2 owns the decision desk (`desk_items`, `DeskItemCreated`, `DeskItemResolved`); M3 needs two
 * kinds of desk items before the desk exists on this branch:
 *
 *  - DevOps approvals (`DevOpsApprovalNeeded`, `kind 'approval'`, `subkind 'devops'`, pinned: a hard stop)
 *  - vault sync conflicts (`VaultSyncConflict`, `kind 'escalation'`, `subkind 'vault_conflict'`, pinned)
 *
 * M3 code only calls `raiseDeskItem` and stores the returned id on its own events. The stub below returns a fresh
 * id and creates nothing, so these items are answered from the M3 pages (Settings > Vaults, DevOps request thread)
 * through `POST /api/devops/requests/:id/resolve` and `POST /api/vaults/:id/resolve-conflict`.
 *
 * TODO(M2 integration, done by the coordinator at merge):
 *  1. Replace `stubDeskPort.raise` (or call `setDeskPort`) with an implementation that appends
 *     `DeskItemCreated{deskItemId: <returned id>, kind, subkind, title, body, blocking, pinned, cardId, ...}` in the
 *     SAME transaction `tx` and returns that id.
 *  2. In the M2 desk resolve endpoint, for `subkind 'devops'` call `resolveDevOpsApproval(ctx, user, requestId, ...)`
 *     (commands/devops.ts) and for `subkind 'vault_conflict'` call `resolveVaultConflict(...)` (commands/vaults.ts);
 *     both validate the caller and append the M3 event. The desk item itself is resolved by M2's `DeskItemResolved`.
 *  3. Wire the decision-file hook: see `registerDecisionHook` in commands/decisions.ts.
 */
export interface DeskItemRequest {
  kind: 'approval' | 'escalation';
  subkind: 'devops' | 'vault_conflict';
  title: string;
  body: string;
  pinned: boolean;
  blocking: boolean;
  orgId: string;
  projectId?: string | null;
  cardId?: string | null;
  /** The user who must answer (the workstation or vault owner). */
  routeToUserId: string;
  /** Domain ids the resolve endpoint needs (requestId, vaultId, workstationId, ...). */
  context: Record<string, unknown>;
}

export interface DeskPort {
  /** Creates the desk item inside `tx` and returns its id. */
  raise(tx: Tx, req: DeskItemRequest): Promise<{ deskItemId: string }>;
}

export const stubDeskPort: DeskPort = {
  async raise() {
    return { deskItemId: randomUUID() };
  },
};

let current: DeskPort = stubDeskPort;
export const getDeskPort = (): DeskPort => current;
export const setDeskPort = (p: DeskPort): void => {
  current = p;
};
