import {
  builtinCapabilities,
  builtinCapabilityMeta,
  type CapabilitiesResponse,
  type CapabilityKind,
  type CapabilityMeta,
  digestCapabilityIndex,
  isOrgManager,
  mergeRegistry,
  type ParsedCapability,
  type RunnerToServerOf,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import { orgScope, runnerActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, rows } from '../db/sql.ts';

/**
 * The organization vault's capabilities as a runner last reported them (metadata only: the server never stores vault
 * content). The built-ins ship in `@aom/shared`.
 */
export async function vaultCapabilityMeta(db: Queryable, orgId: string): Promise<CapabilityMeta[]> {
  const r = await rows(
    db,
    'SELECT kind, key, name, description, hash FROM capability_index WHERE org_id=$1 ORDER BY kind, key',
    [orgId],
  );
  return r.map((x) => ({
    kind: x.kind as CapabilityKind,
    key: x.key,
    name: x.name,
    description: x.description,
    hash: x.hash,
    source: 'org-vault' as const,
  }));
}

/** The effective registry of an organization: built-ins overridden by the organization vault, by kind and key. */
export async function effectiveRegistry(
  db: Queryable,
  orgId: string,
  kind?: CapabilityKind,
): Promise<CapabilitiesResponse> {
  const builtin = builtinCapabilityMeta();
  const vault = await vaultCapabilityMeta(db, orgId);
  const builtinIds = new Set(builtin.map((b) => `${b.kind}:${b.key}`));
  const status = await one(db, 'SELECT issues, reported_at FROM capability_index_status WHERE org_id=$1', [
    orgId,
  ]);
  const items = mergeRegistry(builtin, vault)
    .filter((m) => !kind || m.kind === kind)
    .map((m) => ({ ...m, overrides: m.source === 'org-vault' && builtinIds.has(`${m.kind}:${m.key}`) }));
  return {
    items,
    issues: (status?.issues as Array<{ path: string; message: string }> | undefined) ?? [],
    indexedAt: iso(status?.reported_at),
  };
}

/** A persona the server can speak for: the built-in text, or (for a vault persona) only what the index says. */
export interface ResolvedPersona {
  key: string;
  name: string;
  description: string;
  source: 'builtin' | 'org-vault';
  /** The persona prompt; absent for a vault persona (the runner reads it from its clone). */
  prompt?: string;
  stance?: string;
  voice?: string;
  icon?: string;
  model?: string;
  skills: string[];
}

export async function resolvePersona(
  db: Queryable,
  orgId: string,
  key: string,
): Promise<ResolvedPersona | undefined> {
  const vault = await one(
    db,
    `SELECT name, description FROM capability_index WHERE org_id=$1 AND kind='persona' AND key=$2`,
    [orgId, key],
  );
  if (vault)
    return { key, name: vault.name, description: vault.description, source: 'org-vault', skills: [] };
  const b = builtinCapabilities().find(
    (e): e is Extract<ParsedCapability, { kind: 'persona' }> => e.kind === 'persona' && e.key === key,
  );
  if (!b) return undefined;
  return {
    key,
    name: b.meta.name,
    description: b.meta.description,
    source: 'builtin',
    prompt: b.body,
    stance: b.meta.stance,
    voice: b.meta.voice,
    icon: b.meta.icon,
    ...(b.meta.model ? { model: b.meta.model } : {}),
    skills: b.meta.skills ?? [],
  };
}

/**
 * `capabilities.report` from a runner: the organization vault's index. Only a workstation of an Owner or Admin may report
 * (the same audience that reads the organization vault); an identical report appends nothing.
 */
export async function applyCapabilitiesReport(
  ctx: Ctx,
  ws: { id: string; userId: string },
  msg: RunnerToServerOf<'capabilities.report'>,
): Promise<boolean> {
  const vault = await one(
    ctx.pool,
    `SELECT id, org_id FROM vaults WHERE id=$1 AND kind='org' AND project_id IS NULL`,
    [msg.vaultId],
  );
  if (!vault) return false;
  if (!isOrgManager({ orgRole: await orgRoleOf(ctx.pool, ws.userId, vault.org_id) })) return false;
  const digest = digestCapabilityIndex(msg.items, msg.issues);
  const cur = await one(ctx.pool, 'SELECT item_hash FROM capability_index_status WHERE org_id=$1', [
    vault.org_id,
  ]);
  if (cur?.item_hash === digest) return false;
  await ctx.store.append([
    {
      streamId: streamId.capabilities(vault.org_id),
      event: {
        type: 'CapabilityIndexReported',
        payload: {
          orgId: vault.org_id,
          vaultId: vault.id,
          workstationId: ws.id,
          items: msg.items,
          issues: msg.issues,
        },
      },
      actor: runnerActor(ws.id),
      scope: orgScope(vault.org_id),
    },
  ]);
  return true;
}
