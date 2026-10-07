import { z } from 'zod';
import { VaultKind } from '../events/vault.ts';
import { RemoteUrlSchema } from '../safe.ts';
import { IsoTime } from './common.ts';

/** Per-workstation sync state of a vault (reported by the runner with `vault.status`; the viewer's own workstations). */
export const VaultWorkstationStatusSchema = z.object({
  workstationId: z.uuid(),
  workstationName: z.string(),
  localPath: z.string().nullable(),
  lastPullAt: IsoTime.nullable(),
  lastPushAt: IsoTime.nullable(),
  lastError: z.string().nullable(),
  /** Sync is paused after an unresolved conflict until the manager resolves it. */
  paused: z.boolean(),
  conflictFiles: z.array(z.string()),
});
export type VaultWorkstationStatus = z.infer<typeof VaultWorkstationStatusSchema>;

export const VaultDtoSchema = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  projectId: z.uuid().nullable(),
  kind: VaultKind,
  name: z.string(),
  remoteUrl: z.string(),
  syncIntervalSec: z.number().int(),
  createdAt: IsoTime,
  /** The project owner / org owner may edit; project members only see it. */
  canEdit: z.boolean(),
  workstations: z.array(VaultWorkstationStatusSchema),
});
export type VaultDto = z.infer<typeof VaultDtoSchema>;
export const VaultsResponseSchema = z.object({ vaults: z.array(VaultDtoSchema) });

/** `POST /api/vaults`: the organization vault (Owner and Admins); a project vault needs `projectId` (the project owner). */
export const RegisterVaultRequestSchema = z
  .object({
    kind: VaultKind,
    name: z.string().min(1).max(120).optional(),
    remoteUrl: RemoteUrlSchema,
    projectId: z.uuid().optional(),
    syncIntervalSec: z.number().int().min(1).max(86_400).default(300),
  })
  .refine((v) => (v.kind === 'project') === !!v.projectId, {
    message: 'projectId is required for (and only for) project vaults',
    path: ['projectId'],
  });
export type RegisterVaultRequest = z.infer<typeof RegisterVaultRequestSchema>;

export const PatchVaultRequestSchema = z
  .object({
    name: z.string().min(1).max(120),
    remoteUrl: RemoteUrlSchema,
    syncIntervalSec: z.number().int().min(1).max(86_400),
  })
  .partial();
export type PatchVaultRequest = z.infer<typeof PatchVaultRequestSchema>;

/** `POST /api/vaults/:id/resolve-conflict`: resumes sync of the vault on one of the caller's workstations. */
export const ResolveVaultConflictRequestSchema = z.object({ workstationId: z.uuid() });
