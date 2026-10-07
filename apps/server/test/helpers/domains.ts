import { randomUUID } from 'node:crypto';
import { DomainEventSchema, streamId } from '@aom/shared';
import type { TestApp } from './app.ts';
import { q } from './db.ts';

/**
 * Fixtures for the data that existed before the work/personal domain was dropped (migration 1322 and
 * `no-personal-2026-10`): vaults registered with the old kinds, and the snapshot of the domains and tiers the SQL
 * migration took of the projects.
 */

/** Registers a vault the way the old code did (`work` or `personal`) by appending the event: the API no longer accepts them. */
export async function registerLegacyVault(
  t: TestApp,
  v: { orgId: string; kind: 'work' | 'personal'; remoteUrl: string; name?: string; actorId?: string },
): Promise<string> {
  const vaultId = randomUUID();
  await t.app.ctx.store.append([
    {
      streamId: streamId.vault(vaultId),
      event: DomainEventSchema.parse({
        type: 'VaultRegistered',
        payload: {
          vaultId,
          orgId: v.orgId,
          kind: v.kind,
          name: v.name ?? (v.kind === 'work' ? 'Work vault' : 'Personal vault'),
          remoteUrl: v.remoteUrl,
          syncIntervalSec: 300,
        },
      }),
      actor: v.actorId ? ({ kind: 'user', id: v.actorId } as never) : ({ kind: 'system', id: null } as never),
      scope: { orgId: v.orgId, projectId: null, audience: 'org' } as never,
    },
  ]);
  return vaultId;
}

/** What migration 1322 recorded of a project before it dropped `domain` and `priority_tier`. */
export async function snapshotDomain(
  projectId: string,
  domain: 'work' | 'personal',
  tier = 2,
): Promise<void> {
  await q(
    `INSERT INTO legacy_project_domains (project_id, org_id, key, kind, domain, priority_tier, created_at, vault_dir, vault_folder)
     SELECT id, org_id, key, kind, $2, $3, created_at, vault_dir, vault_folder FROM projects WHERE id=$1
     ON CONFLICT (project_id) DO UPDATE SET domain = EXCLUDED.domain, priority_tier = EXCLUDED.priority_tier`,
    [projectId, domain, tier],
  );
}
