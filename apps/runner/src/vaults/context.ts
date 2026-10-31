import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ChatVault,
  isSafeVaultFolder,
  type ShiftBrief,
  type ShiftVault,
  stripManagedSection,
  TASTE_FILE,
} from '@aom/shared';
import { confine } from '../fs-safe.ts';
import { isLocalVaultDir } from './local.ts';

export interface VaultShiftContext {
  /** Which vault this is (set by readVaultContexts). */
  kind?: ShiftVault['kind'];
  /** The one directory passed to the runtime as `--add-dir`. */
  addDir: string;
  standingOrders: Array<{ title: string; body: string }>;
  projectDoc?: string;
  /** `<folder>/taste.md`: the manager's feed preferences (curators read it at shift start). */
  taste?: string;
}

const read = async (file: string, root: string): Promise<string | undefined> => {
  if (!existsSync(file)) return undefined;
  try {
    confine(root, file); // a symlink inside the clone must not lead out of it
  } catch {
    return undefined;
  }
  const text = (await readFile(file, 'utf8')).trim();
  return text || undefined;
};

/**
 * What a card shift may see of the knowledge vault (docs/ARCHITECTURE.md section 16.1): only the clone of the vault
 * the server named for this card (its project vault or the organization vault). Reads `standing-orders.md`,
 * `<folder>/standing-orders.md` and `<folder>/PROJECT.md`. No clone yet: no vault context.
 */
export async function readVaultContext(
  vaultsDir: string,
  vault: ShiftVault | ChatVault,
): Promise<VaultShiftContext | null> {
  let root: string;
  try {
    root = confine(vaultsDir, join(vaultsDir, vault.vaultId));
  } catch {
    return null;
  }
  if (
    (vault.folder !== undefined && !isSafeVaultFolder(vault.folder)) ||
    !(existsSync(join(root, '.git')) || isLocalVaultDir(root))
  )
    return null;
  const folder = vault.folder ? vault.folder.split('/') : undefined;
  const orders: Array<{ title: string; body: string }> = [];
  const global = await read(join(root, 'standing-orders.md'), root);
  if (global) orders.push({ title: 'Vault standing orders', body: global });
  const project = folder ? await read(join(root, ...folder, 'standing-orders.md'), root) : undefined;
  if (project) orders.push({ title: 'Project standing orders (vault)', body: project });
  const projectDoc = folder ? await read(join(root, ...folder, 'PROJECT.md'), root) : undefined;
  // The site-managed rules reach curators through the brief (`feed.tasteSeed`); the file copy would show them twice.
  const rawTaste = folder ? await read(join(root, ...folder, TASTE_FILE), root) : undefined;
  const taste = rawTaste ? stripManagedSection(rawTaste) || undefined : undefined;
  return {
    addDir: root,
    standingOrders: orders,
    ...(projectDoc ? { projectDoc } : {}),
    ...(taste ? { taste } : {}),
  };
}

/** Merges vault content into the brief the instructions are rendered from. */
export function withVaultContext(brief: ShiftBrief, ctx: VaultShiftContext | null): ShiftBrief {
  if (!ctx) return brief;
  return {
    ...brief,
    project: { ...brief.project, ...(ctx.projectDoc ? { projectDoc: ctx.projectDoc } : {}) },
    standingOrders: [...ctx.standingOrders, ...brief.standingOrders],
    ...(brief.feed && ctx.taste ? { feed: { ...brief.feed, taste: ctx.taste } } : {}),
  };
}

const relabel = (title: string, kind: ShiftVault['kind'] | undefined): string => {
  const which = kind === 'org' ? 'organization' : 'project';
  if (title === 'Vault standing orders')
    return `${kind === 'org' ? 'Organization' : 'Project'} vault standing orders`;
  if (title === 'Project standing orders (vault)') return `Project standing orders (${which} vault)`;
  return title;
};

/**
 * The vaults of a shift, in order (the write target first), each read as `readVaultContext`. Vaults with no clone on
 * this workstation are skipped; duplicates (same vault id or same directory) are dropped. With two or more vaults the
 * standing-order titles say which vault they come from; with one the output is exactly that of `readVaultContext`.
 */
export async function readVaultContexts(
  vaultsDir: string,
  vaults: ShiftVault[],
): Promise<VaultShiftContext[]> {
  const seen = new Set<string>();
  const out: VaultShiftContext[] = [];
  for (const v of vaults) {
    if (seen.has(v.vaultId)) continue;
    seen.add(v.vaultId);
    const ctx = await readVaultContext(vaultsDir, v);
    if (!ctx || out.some((c) => c.addDir === ctx.addDir)) continue;
    out.push({ ...ctx, kind: v.kind });
  }
  if (out.length < 2) return out;
  return out.map((c) => ({
    ...c,
    standingOrders: c.standingOrders.map((o) => ({ ...o, title: relabel(o.title, c.kind) })),
  }));
}

/**
 * Merges several vaults into the brief: standing orders of all (first vault first, identical bodies once), PROJECT.md
 * and taste.md from the first vault that has them. One vault gives the same result as `withVaultContext`.
 */
export function withVaultContexts(brief: ShiftBrief, ctxs: VaultShiftContext[]): ShiftBrief {
  if (ctxs.length === 0) return brief;
  if (ctxs.length === 1) return withVaultContext(brief, ctxs[0]!);
  const bodies = new Set<string>();
  const standingOrders = ctxs.flatMap((c) =>
    c.standingOrders.filter((o) => (bodies.has(o.body) ? false : (bodies.add(o.body), true))),
  );
  return withVaultContext(brief, {
    addDir: ctxs[0]!.addDir,
    standingOrders,
    ...(ctxs.find((c) => c.projectDoc) ? { projectDoc: ctxs.find((c) => c.projectDoc)!.projectDoc } : {}),
    ...(ctxs.find((c) => c.taste) ? { taste: ctxs.find((c) => c.taste)!.taste } : {}),
  });
}
