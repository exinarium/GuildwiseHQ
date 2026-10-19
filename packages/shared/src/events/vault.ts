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

/**
 * How a vault is stored (docs/design/project-graphs.md section 3). `git`: a remote repository the runners clone and sync
 * (every vault before the project graphs). `local`: a folder on one workstation, no remote, no sync; the Owner backs it up.
 */
export const VaultStorage = z.enum(['git', 'local']);
export type VaultStorage = z.infer<typeof VaultStorage>;

const VaultBody = z.object({
  vaultId: Id,
  orgId: Id,
  projectId: Id.optional(),
  kind: VaultEventKind,
  name: z.string().min(1).max(120),
  /** Empty for a `local` vault (no remote). */
  remoteUrl: z.string(),
  syncIntervalSec: z.number().int().min(1).max(86_400),
  /** Absent: `git` (every event before the local kind). */
  storage: VaultStorage.optional(),
  /** `local` only: the workstation that holds the folder (the Org Owner's primary workstation). Absent until one exists. */
  localWorkstationId: Id.optional(),
});

/** Vault events (docs/ARCHITECTURE.md section 5.2, M3). The site stores the URL only, never vault content. */
export const vaultEvents = [
  defineEvent('VaultRegistered', VaultBody),
  defineEvent('VaultUpdated', VaultBody),
  /**
   * Every project always has a vault (project-graphs design section 3). Recorded when a project is created and by the data
   * migration `project-vaults-2026-10` for the projects that have none. The server answers it by registering a `local`
   * vault (`VaultRegistered`, `storage: 'local'`) on the Org Owner's primary workstation, or keeps the request open until
   * that workstation exists. Carries no content.
   */
  defineEvent(
    'ProjectVaultEnsureRequested',
    z.object({
      projectId: Id,
      orgId: Id,
      reason: z.enum(['created', 'migration', 'workstation']),
    }),
  ),
  /** A local vault's folder is held by this workstation (the Org Owner's first workstation claimed it). */
  defineEvent('VaultLocalWorkstationSet', z.object({ vaultId: Id, orgId: Id, workstationId: Id })),
  /**
   * Data migration `no-personal-2026-10`: the organization's personal vault was merged into its organization vault under
   * `folder` (the runner copies the files, `vault.merge`). `intoVaultId` is the organization vault the files go to; null:
   * the organization had no organization vault, so the personal vault itself became it (`kind org`). The projector removes
   * the vault row either way (the repository is untouched, so it stays as a backup).
   */
  defineEvent(
    'VaultMerged',
    z.object({
      vaultId: Id,
      orgId: Id,
      intoVaultId: Id.nullable(),
      folder: z.string().min(1),
      /** Both vaults pointed at the same repository: nothing was copied, the registration was only retired. */
      sameRepository: z.boolean().optional(),
    }),
  ),
  /** A runner could not rebase a vault onto its remote. A pinned desk escalation exists (desk port, M2). */
  defineEvent(
    'VaultSyncConflict',
    z.object({ vaultId: Id, workstationId: Id, files: z.array(z.string()), deskItemId: Id }),
  ),
  /** The manager resolved the conflict; the runner resumes syncing that vault (`vault.configure{resume}`). */
  defineEvent('VaultConflictResolved', z.object({ vaultId: Id, workstationId: Id, resolvedBy: Id })),
] as const;
