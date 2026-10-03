import { z } from 'zod';
import { defineEvent, Id } from './define.ts';

export const VaultKind = z.enum(['work', 'personal', 'project']);
export type VaultKind = z.infer<typeof VaultKind>;

const VaultBody = z.object({
  vaultId: Id,
  orgId: Id,
  projectId: Id.optional(),
  kind: VaultKind,
  name: z.string().min(1).max(120),
  remoteUrl: z.string().min(1),
  syncIntervalSec: z.number().int().min(1).max(86_400),
});

/** Vault events (docs/ARCHITECTURE.md section 5.2, M3). The site stores the URL only, never vault content. */
export const vaultEvents = [
  defineEvent('VaultRegistered', VaultBody),
  defineEvent('VaultUpdated', VaultBody),
  /** A runner could not rebase a vault onto its remote. A pinned desk escalation exists (desk port, M2). */
  defineEvent(
    'VaultSyncConflict',
    z.object({ vaultId: Id, workstationId: Id, files: z.array(z.string()), deskItemId: Id }),
  ),
  /** The manager resolved the conflict; the runner resumes syncing that vault (`vault.configure{resume}`). */
  defineEvent('VaultConflictResolved', z.object({ vaultId: Id, workstationId: Id, resolvedBy: Id })),
] as const;
