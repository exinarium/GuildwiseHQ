import {
  builtinCapabilities,
  builtinCapabilityMeta,
  type CapabilitiesResponse,
  type CapabilityKind,
  type CapabilityMeta,
  digestCapabilityIndex,
  isOrgManager,
  isPackedKey,
  mergeRegistry,
  type PackItem,
  type ParsedCapability,
  type RunnerToServerOf,
  streamId,
} from '@aom/shared';
import { z } from 'zod';
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

export interface RegistryOptions {
  kind?: CapabilityKind;
  /** Also the project-repository capabilities and project-scoped packs of this project. */
  projectId?: string;
  /** Leave out what cannot be used now (a pack that is not approved, or whose files changed). */
  usableOnly?: boolean;
}

/** Whether a pack's capabilities may be used: approved at exactly the pinned commit and content, and not flagged. */
export function packUsable(p: {
  pinned_sha: string | null;
  content_hash: string | null;
  trusted: boolean;
  trusted_sha: string | null;
  trusted_hash: string | null;
  integrity_failed?: boolean;
}): { usable: boolean; reason?: 'untrusted' | 'integrity' | 'pending' } {
  if (!p.pinned_sha) return { usable: false, reason: 'pending' };
  if (!p.trusted || p.trusted_sha !== p.pinned_sha || p.trusted_hash !== p.content_hash)
    return { usable: false, reason: 'untrusted' };
  if (p.integrity_failed) return { usable: false, reason: 'integrity' };
  return { usable: true };
}

async function packItems(db: Queryable, orgId: string, projectId?: string) {
  const packs = await rows(
    db,
    `SELECT id, scope, project_id, pinned_sha, content_hash, snapshot, trusted, trusted_sha, trusted_hash
       FROM packs WHERE org_id=$1 AND removed_at IS NULL AND snapshot IS NOT NULL
        AND (scope='org' OR (project_id IS NOT NULL AND project_id = $2))
      ORDER BY name`,
    [orgId, projectId ?? null],
  );
  const out: Array<{
    meta: CapabilityMeta;
    usable: boolean;
    reason?: 'untrusted' | 'integrity' | 'pending';
    packId: string;
    sha: string;
  }> = [];
  for (const p of packs) {
    const u = packUsable(p as never);
    for (const i of (p.snapshot?.items ?? []) as PackItem[]) {
      const { files: _files, ...meta } = i;
      out.push({
        meta: meta as CapabilityMeta,
        usable: u.usable,
        ...(u.reason ? { reason: u.reason } : {}),
        packId: p.id,
        sha: p.pinned_sha,
      });
    }
  }
  return out;
}

async function projectRepoMeta(db: Queryable, orgId: string, projectId: string): Promise<CapabilityMeta[]> {
  const r = await rows(
    db,
    'SELECT kind, key, name, description, hash, icon FROM project_capability_index WHERE org_id=$1 AND project_id=$2 ORDER BY kind, key',
    [orgId, projectId],
  );
  return r.map((x) => ({
    kind: x.kind as CapabilityKind,
    key: x.key,
    name: x.name,
    description: x.description,
    hash: x.hash,
    source: 'project-repo' as const,
    ...(x.icon ? { icon: x.icon } : {}),
  }));
}

/**
 * The effective registry of an organization, lowest precedence first: built-ins, the organization vault, the project's own
 * repository (with `projectId`), imported packs. Pack capabilities are listed with `usable: false` and a reason until the owner
 * approves the pack at its pinned commit.
 */
export async function effectiveRegistry(
  db: Queryable,
  orgId: string,
  opts: CapabilityKind | RegistryOptions = {},
): Promise<CapabilitiesResponse> {
  const o: RegistryOptions = typeof opts === 'string' ? { kind: opts } : opts;
  const builtin = builtinCapabilityMeta();
  const vault = await vaultCapabilityMeta(db, orgId);
  const repo = o.projectId ? await projectRepoMeta(db, orgId, o.projectId) : [];
  const packs = await packItems(db, orgId, o.projectId);
  const idsOf = (l: CapabilityMeta[]) => l.map((b) => `${b.kind}:${b.key}`);
  // what each source can override: the ids of the sources below it
  const below: Record<string, Set<string>> = {
    'org-vault': new Set(idsOf(builtin)),
    'project-repo': new Set(idsOf([...builtin, ...vault])),
    pack: new Set(idsOf([...builtin, ...vault, ...repo])),
  };
  const extra = new Map(packs.map((p) => [`${p.meta.kind}:${p.meta.key}`, p]));
  const status = await one(db, 'SELECT issues, reported_at FROM capability_index_status WHERE org_id=$1', [
    orgId,
  ]);
  const items = mergeRegistry(
    builtin,
    vault,
    repo,
    packs.filter((p) => p.usable).map((p) => p.meta),
    packs.filter((p) => !p.usable).map((p) => p.meta),
  )
    .filter((m) => !o.kind || m.kind === o.kind)
    .map((m) => {
      const id = `${m.kind}:${m.key}`;
      const pk = m.source === 'pack' ? extra.get(id) : undefined;
      return {
        ...m,
        overrides: below[m.source]?.has(id) ?? false,
        usable: pk ? pk.usable : true,
        ...(pk && !pk.usable && pk.reason ? { unusableReason: pk.reason } : {}),
        ...(pk ? { packId: pk.packId, sha: pk.sha } : {}),
        ...(m.source === 'project-repo' && o.projectId ? { projectId: o.projectId } : {}),
      };
    })
    .filter((m) => !o.usableOnly || m.usable);
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
  source: 'builtin' | 'org-vault' | 'project-repo' | 'pack';
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
  // An imported pack's persona (`bmad:analyst`): only when the pack is approved at its pinned commit and unchanged. The text
  // is never on the server; the runner reads it from its clone (and fences it as outside content).
  if (isPackedKey(key)) {
    const hit = (await packItems(db, orgId)).find((p) => p.meta.kind === 'persona' && p.meta.key === key);
    if (!hit?.usable) return undefined;
    return {
      key,
      name: hit.meta.name,
      description: hit.meta.description,
      source: 'pack',
      ...(hit.meta.icon ? { icon: hit.meta.icon } : {}),
      skills: [],
    };
  }
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
  if (!z.uuid().safeParse(msg.vaultId).success) return false;
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
