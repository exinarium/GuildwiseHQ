import { z } from 'zod';
import { defineEvent, Id } from './define.ts';

/** `org`: the organization vault (one per organization); `project`: a project's own vault. */
export const VaultKind = z.enum(['org', 'project']);
export type VaultKind = z.infer<typeof VaultKind>;

/**
 * What an event may carry: the kinds of before the work/personal split was dropped as well. `work` is the organization
 * vault; a `personal` vault is merged into the organization vault by the data migration (`VaultMerged`).
 */
export const VaultEventKind = z.enum(['org', 'work', 'personal', 'project']);
export type VaultEventKind = z.infer<typeof VaultEventKind>;

const VaultBody = z.object({
  vaultId: Id,
  orgId: Id,
  projectId: Id.optional(),
  kind: VaultEventKind,
  name: z.string().min(1).max(120),
  remoteUrl: z.string().min(1),
  syncIntervalSec: z.number().int().min(1).max(86_400),
});

/** Vault events (docs/ARCHITECTURE.md section 5.2, M3). The site stores the URL only, never vault content. */
export const vaultEvents = [
  defineEvent('VaultRegistered', VaultBody),
  defineEvent('VaultUpdated', VaultBody),
  /**
   * Data migration `no-personal-2026-10`: the organization's personal vault was merged into its organization vault under
   * `folder` (the runner copies the files, `vault.merge`). `intoVaultId` is the organization vault the files go to; null:
   * the organization had no organization vault, so the personal vault itself became it (`kind org`). The projector removes
   * the vault row either way (the repository is untouched, so it stays as a backup).
   */
  defineEvent(
    'VaultMerged',
    z.object({ vaultId: Id, orgId: Id, intoVaultId: Id.nullable(), folder: z.string().min(1) }),
  ),
  /** A runner could not rebase a vault onto its remote. A pinned desk escalation exists (desk port, M2). */
  defineEvent(
    'VaultSyncConflict',
    z.object({ vaultId: Id, workstationId: Id, files: z.array(z.string()), deskItemId: Id }),
  ),
  /** The manager resolved the conflict; the runner resumes syncing that vault (`vault.configure{resume}`). */
  defineEvent('VaultConflictResolved', z.object({ vaultId: Id, workstationId: Id, resolvedBy: Id })),
] as const;
